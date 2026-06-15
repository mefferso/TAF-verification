"""Minimal TAF fetch/parse helpers.

This starts conservative: it parses prevailing/FM groups and stores TEMPO/PROB/BECMG
as separate rows. Verification initially uses prevailing/FM conditions unless the
user chooses to include temporary groups later.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable

import pandas as pd
import requests
from bs4 import BeautifulSoup

from metar import CEILING_COVERS, flight_category

IEM_AFOS_LIST_URL = "https://mesonet.agron.iastate.edu/wx/afos/list.phtml"

GROUP_RE = re.compile(r"\b(FM\d{6}|TEMPO\s+\d{4}/\d{4}|BECMG\s+\d{4}/\d{4}|PROB\d{2}\s+\d{4}/\d{4})\b")
VALID_RE = re.compile(r"\b(\d{4}/\d{4})\b")
VIS_RE = re.compile(r"\b(P?\d+(?:/\d+)?|\d+\s+\d/\d)SM\b")
SKY_RE = re.compile(r"\b(FEW|SCT|BKN|OVC|VV)(\d{3})\b")


@dataclass
class TafProduct:
    pil: str
    issued: datetime | None
    text: str
    source_url: str | None = None


def fetch_taf_product(pil: str, issue_date: datetime, cycle_hour: int, wfo: str = "LIX") -> TafProduct:
    """Fetch the TAF product closest to the requested UTC cycle from IEM."""
    issue_date = _ensure_utc(issue_date)
    target = issue_date.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
    start_day = target.date()
    end_day = (target + timedelta(days=1)).date()

    params = {
        "source": wfo.upper(),
        "year1": start_day.year,
        "month1": start_day.month,
        "day1": start_day.day,
        "year2": end_day.year,
        "month2": end_day.month,
        "day2": end_day.day,
        "sort": "asc",
        "pil": pil.upper(),
    }
    response = requests.get(IEM_AFOS_LIST_URL, params=params, timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    candidates: list[tuple[datetime | None, str]] = []
    for link in soup.find_all("a"):
        label = link.get_text(strip=True).upper()
        href = link.get("href") or ""
        if label != pil.upper() or "p.php" not in href:
            continue
        url = requests.compat.urljoin(IEM_AFOS_LIST_URL, href)
        issued = _issued_from_url(url)
        candidates.append((issued, url))

    if not candidates:
        raise RuntimeError(
            f"No {pil.upper()} products found for {wfo.upper()} on {start_day}. "
            "Check the PIL/WFO/date or the IEM listing parameters."
        )

    candidates.sort(key=lambda item: abs(((item[0] or target) - target).total_seconds()))
    issued, url = candidates[0]

    product_response = requests.get(url, timeout=30)
    product_response.raise_for_status()
    return TafProduct(pil=pil.upper(), issued=issued, text=_extract_product_text(product_response.text), source_url=url)


def split_taf_by_site(product_text: str, sites: Iterable[str]) -> dict[str, str]:
    """Extract individual station TAF blocks from a collective TAF product."""
    sites = [s.upper() for s in sites]
    lines = [line.rstrip() for line in product_text.splitlines()]
    blocks: dict[str, list[str]] = {}
    current_site: str | None = None
    site_start = re.compile(r"^(TAF\s+)?(?P<site>K[A-Z0-9]{3})\b")

    for raw in lines:
        line = raw.strip()
        match = site_start.match(line)
        if match and match.group("site") in sites:
            current_site = match.group("site")
            blocks[current_site] = [line]
        elif current_site and line:
            other = site_start.match(line)
            if other and other.group("site") not in sites:
                current_site = None
            else:
                blocks[current_site].append(line)

    return {site: "\n".join(block) for site, block in blocks.items()}


def parse_taf_block(taf_text: str, issue_time: datetime, window_start: datetime, window_end: datetime) -> pd.DataFrame:
    """Parse a single station TAF into coarse forecast periods."""
    issue_time = _ensure_utc(issue_time)
    window_start = _ensure_utc(window_start)
    window_end = _ensure_utc(window_end)

    compact = " ".join(taf_text.replace("=", " ").split())
    station_match = re.search(r"\b(K[A-Z0-9]{3})\b", compact)
    station = station_match.group(1) if station_match else "UNKNOWN"

    markers = [(m.start(), m.group(1)) for m in GROUP_RE.finditer(compact)]
    spans = [(0, "PREVAILING")] + markers if markers else [(0, "PREVAILING")]

    rows = []
    for idx, (pos, marker) in enumerate(spans):
        next_pos = spans[idx + 1][0] if idx + 1 < len(spans) else len(compact)
        text = compact[pos:next_pos].strip()
        start, end = _period_from_marker(marker, issue_time, window_start, window_end)
        ceiling = forecast_ceiling(text)
        vis = forecast_visibility(text)
        rows.append(
            {
                "station": station,
                "group_type": marker.split()[0],
                "start": start,
                "end": end,
                "forecast_visibility_sm": vis,
                "forecast_ceiling_ft": ceiling,
                "forecast_category": flight_category(vis, ceiling),
                "group_text": text,
                "is_prevailing": marker.startswith("FM") or marker == "PREVAILING",
            }
        )

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["start"] = pd.to_datetime(df["start"], utc=True)
    df["end"] = pd.to_datetime(df["end"], utc=True)
    df = df[(df["end"] > window_start) & (df["start"] < window_end)].copy()
    df["start"] = df["start"].clip(lower=window_start)
    df["end"] = df["end"].clip(upper=window_end)
    return df.reset_index(drop=True)


def forecast_ceiling(text: str) -> float | None:
    ceilings = []
    for cover, hundreds in SKY_RE.findall(text):
        if cover in CEILING_COVERS:
            ceilings.append(int(hundreds) * 100)
    return float(min(ceilings)) if ceilings else None


def forecast_visibility(text: str) -> float | None:
    match = VIS_RE.search(text)
    if not match:
        return None
    return _parse_sm(match.group(1).replace("P", ""))


def _period_from_marker(marker: str, issue_time: datetime, window_start: datetime, window_end: datetime) -> tuple[datetime, datetime]:
    marker = marker.strip()
    if marker.startswith("FM"):
        dd = int(marker[2:4])
        hh = int(marker[4:6])
        mm = int(marker[6:8])
        return _resolve_day_hour(issue_time, dd, hh, mm), window_end

    period_match = VALID_RE.search(marker)
    if period_match:
        start_s, end_s = period_match.group(1).split("/")
        start = _resolve_day_hour(issue_time, int(start_s[:2]), int(start_s[2:]), 0)
        end = _resolve_day_hour(issue_time, int(end_s[:2]), int(end_s[2:]), 0)
        if end <= start:
            end += timedelta(days=1)
        return start, end

    return window_start, window_end


def _parse_sm(value: str) -> float | None:
    value = value.strip()
    try:
        if " " in value:
            whole, frac = value.split()
            num, den = frac.split("/")
            return float(whole) + float(num) / float(den)
        if "/" in value:
            num, den = value.split("/")
            return float(num) / float(den)
        return float(value)
    except (ValueError, ZeroDivisionError):
        return None


def _resolve_day_hour(reference: datetime, day: int, hour: int, minute: int = 0) -> datetime:
    """Resolve a TAF DDHH time near the issue time, including month boundaries."""
    reference = _ensure_utc(reference)
    base = reference.replace(hour=hour % 24, minute=minute, second=0, microsecond=0)
    options = []
    for offset in range(-3, 35):
        candidate = base + timedelta(days=offset)
        if candidate.day == day:
            if hour == 24:
                candidate += timedelta(days=1)
            options.append(candidate)
    if not options:
        raise ValueError(f"Could not resolve TAF day/hour {day:02d}{hour:02d} near {reference}")
    return min(options, key=lambda dt: abs((dt - reference).total_seconds()))


def _issued_from_url(url: str) -> datetime | None:
    match = re.search(r"[?&]e=(\d{12})", url)
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _extract_product_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    pre = soup.find("pre")
    return pre.get_text("\n").strip() if pre else soup.get_text("\n").strip()


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
