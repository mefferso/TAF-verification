"""Verification calculations for categorical TAF events."""

from __future__ import annotations

import pandas as pd

CATEGORY_RANK = {"LIFR": 0, "IFR": 1, "MVFR": 2, "VFR": 3}


def event_bool(category: str, threshold: str) -> bool:
    """True when category is at-or-below the chosen threshold.

    Example: threshold IFR counts LIFR and IFR as events.
    """
    return CATEGORY_RANK.get(str(category), 99) <= CATEGORY_RANK[threshold]


def attach_forecast_to_obs(obs: pd.DataFrame, taf_periods: pd.DataFrame, include_tempo: bool = False) -> pd.DataFrame:
    """Attach the valid forecast category to each observation row."""
    if obs.empty:
        return obs.copy()
    if taf_periods.empty:
        out = obs.copy()
        out["forecast_category"] = None
        out["forecast_group"] = None
        return out

    periods = taf_periods.copy()
    if not include_tempo:
        periods = periods[periods["is_prevailing"]]

    rows = []
    for _, ob in obs.iterrows():
        valid = ob["valid"]
        station_periods = periods[periods["station"].eq(ob["station"])]
        matches = station_periods[(station_periods["start"] <= valid) & (station_periods["end"] > valid)]
        if matches.empty:
            fcst_cat = None
            fcst_group = None
        else:
            # Use the latest-starting matching group.
            match = matches.sort_values("start").iloc[-1]
            fcst_cat = match["forecast_category"]
            fcst_group = match["group_text"]
        row = ob.to_dict()
        row["forecast_category"] = fcst_cat
        row["forecast_group"] = fcst_group
        rows.append(row)
    return pd.DataFrame(rows)


def contingency(df: pd.DataFrame, threshold: str) -> dict[str, float | int]:
    """Calculate hits/misses/false alarms/correct negatives plus POD/FAR/CSI."""
    valid_rows = df.dropna(subset=["forecast_category", "obs_category"]).copy()
    if valid_rows.empty:
        return {"hits": 0, "misses": 0, "false_alarms": 0, "correct_negatives": 0, "POD": float("nan"), "FAR": float("nan"), "CSI": float("nan")}

    valid_rows["forecast_event"] = valid_rows["forecast_category"].apply(lambda c: event_bool(c, threshold))
    valid_rows["obs_event"] = valid_rows["obs_category"].apply(lambda c: event_bool(c, threshold))

    hits = int((valid_rows["forecast_event"] & valid_rows["obs_event"]).sum())
    misses = int((~valid_rows["forecast_event"] & valid_rows["obs_event"]).sum())
    false_alarms = int((valid_rows["forecast_event"] & ~valid_rows["obs_event"]).sum())
    correct_negatives = int((~valid_rows["forecast_event"] & ~valid_rows["obs_event"]).sum())

    pod = hits / (hits + misses) if hits + misses else float("nan")
    far = false_alarms / (hits + false_alarms) if hits + false_alarms else float("nan")
    csi = hits / (hits + misses + false_alarms) if hits + misses + false_alarms else float("nan")

    return {
        "hits": hits,
        "misses": misses,
        "false_alarms": false_alarms,
        "correct_negatives": correct_negatives,
        "POD": pod,
        "FAR": far,
        "CSI": csi,
    }
