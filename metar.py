"""Fetch and classify METAR observations from the Iowa Environmental Mesonet."""

from __future__ import annotations

from datetime import datetime, timezone
from io import StringIO
from typing import Iterable

import pandas as pd
import requests

ASOS_DOWNLOAD_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"

CEILING_COVERS = {"BKN", "OVC", "VV"}


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fetch_metars(stations: Iterable[str], start: datetime, end: datetime) -> pd.DataFrame:
    """Download METAR/ASOS rows from IEM for the requested UTC window."""
    start = _utc(start)
    end = _utc(end)
    stations = [s.upper().strip() for s in stations if s]
    if not stations:
        raise ValueError("At least one station is required")

    params: list[tuple[str, str | int]] = []
    for station in stations:
        params.append(("station", station))

    requested_data = [
        "vsby",
        "skyc1",
        "skyc2",
        "skyc3",
        "skyc4",
        "skyl1",
        "skyl2",
        "skyl3",
        "skyl4",
        "wxcodes",
        "metar",
    ]
    for key in requested_data:
        params.append(("data", key))

    params.extend(
        [
            ("year1", start.year),
            ("month1", start.month),
            ("day1", start.day),
            ("hour1", start.hour),
            ("minute1", start.minute),
            ("year2", end.year),
            ("month2", end.month),
            ("day2", end.day),
            ("hour2", end.hour),
            ("minute2", end.minute),
            ("tz", "Etc/UTC"),
            ("format", "comma"),
            ("latlon", "no"),
            ("elev", "no"),
            ("missing", "M"),
            ("trace", "T"),
            ("direct", "no"),
            # 1 = routine, 2 = specials. Pull both so short-lived restrictions count.
            ("report_type", "1"),
            ("report_type", "2"),
        ]
    )

    response = requests.get(ASOS_DOWNLOAD_URL, params=params, timeout=30)
    response.raise_for_status()

    text = response.text
    if not text.strip() or text.lstrip().startswith("ERROR"):
        raise RuntimeError(f"IEM METAR request failed: {text[:300]}")

    df = pd.read_csv(StringIO(text), comment="#")
    if df.empty:
        return df

    df["valid"] = pd.to_datetime(df["valid"], utc=True, errors="coerce")
    for col in ["vsby", "skyl1", "skyl2", "skyl3", "skyl4"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df["ceiling_ft"] = df.apply(observed_ceiling, axis=1)
    df["obs_category"] = df.apply(lambda r: flight_category(r.get("vsby"), r.get("ceiling_ft")), axis=1)
    return df.sort_values(["station", "valid"]).reset_index(drop=True)


def observed_ceiling(row: pd.Series) -> float | None:
    """Return lowest BKN/OVC/VV cloud height in feet, if present."""
    ceilings: list[float] = []
    for idx in range(1, 5):
        cover = str(row.get(f"skyc{idx}", "")).strip().upper()
        height = row.get(f"skyl{idx}")
        if cover in CEILING_COVERS and pd.notna(height):
            ceilings.append(float(height))
    if not ceilings:
        return None
    return min(ceilings)


def flight_category(visibility_sm: float | None, ceiling_ft: float | None) -> str:
    """Classify flight category using standard ceiling/visibility thresholds."""
    vis = None if pd.isna(visibility_sm) else visibility_sm
    cig = None if pd.isna(ceiling_ft) else ceiling_ft

    if (cig is not None and cig < 500) or (vis is not None and vis < 1):
        return "LIFR"
    if (cig is not None and cig < 1000) or (vis is not None and vis < 3):
        return "IFR"
    if (cig is not None and cig <= 3000) or (vis is not None and vis <= 5):
        return "MVFR"
    return "VFR"
