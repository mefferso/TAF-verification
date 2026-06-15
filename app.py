"""Streamlit dashboard for LIX TAF verification."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

import pandas as pd
import streamlit as st

from config import CYCLES_UTC, DEFAULT_SITES, LIX_TAF_PRODUCT, LIX_WFO
from metar import fetch_metars
from taf import fetch_taf_product, parse_taf_block, split_taf_by_site
from verify import attach_forecast_to_obs, contingency

st.set_page_config(page_title="TAF Verification", layout="wide")

st.title("TAF Verification Prototype")
st.caption("Fetch archived TAFs + METARs from IEM and verify categorical ceiling/visibility events.")

with st.sidebar:
    st.header("Request")
    selected_date = st.date_input("UTC date", value=date.today() - timedelta(days=1))
    cycle = st.selectbox("TAF cycle", CYCLES_UTC, format_func=lambda h: f"{h:02d}z")
    site_choice = st.selectbox("Terminal", ["All"] + DEFAULT_SITES)
    threshold = st.selectbox("Verify category at or below", ["LIFR", "IFR", "MVFR"], index=1)
    window_hours = st.number_input("Verification window hours", min_value=1, max_value=30, value=6, step=1)
    include_tempo = st.checkbox(
        "Include TEMPO/PROB/BECMG groups",
        value=False,
        help="Initial default is prevailing/FM only. Turn this on for experimental behavior.",
    )
    run = st.button("Run verification", type="primary")

sites = DEFAULT_SITES if site_choice == "All" else [site_choice]
issue_dt = datetime.combine(selected_date, time(cycle, 0), tzinfo=timezone.utc)
window_start = issue_dt
window_end = issue_dt + timedelta(hours=int(window_hours))

st.info(
    f"Selected window: **{window_start:%Y-%m-%d %H:%M}z** to "
    f"**{window_end:%Y-%m-%d %H:%M}z** for **{', '.join(sites)}**"
)

if run:
    with st.spinner("Fetching TAF product and METAR observations from IEM..."):
        taf_product = fetch_taf_product(LIX_TAF_PRODUCT, issue_dt, cycle, LIX_WFO)
        taf_blocks = split_taf_by_site(taf_product.text, sites)
        metars = fetch_metars(sites, window_start, window_end)

    st.subheader("Archived TAF product")
    cols = st.columns([1, 3])
    cols[0].metric("PIL", taf_product.pil)
    cols[1].write(f"Issued: `{taf_product.issued}`")
    if taf_product.source_url:
        st.link_button("Open IEM product", taf_product.source_url)
    st.code(taf_product.text, language="text")

    if not taf_blocks:
        st.error("No selected station TAF blocks were found inside the product. Check terminal list/product text.")
        st.stop()

    all_periods = []
    for site, block in taf_blocks.items():
        parsed = parse_taf_block(block, taf_product.issued or issue_dt, window_start, window_end)
        if not parsed.empty:
            parsed["station"] = site
            all_periods.append(parsed)
    taf_periods = pd.concat(all_periods, ignore_index=True) if all_periods else pd.DataFrame()

    st.subheader("Parsed TAF periods")
    if taf_periods.empty:
        st.warning("No valid TAF periods parsed for the selected window.")
    else:
        st.dataframe(
            taf_periods[
                [
                    "station",
                    "group_type",
                    "start",
                    "end",
                    "forecast_visibility_sm",
                    "forecast_ceiling_ft",
                    "forecast_category",
                    "is_prevailing",
                    "group_text",
                ]
            ],
            use_container_width=True,
        )

    st.subheader("METAR observations")
    if metars.empty:
        st.warning("No METAR observations returned for this window.")
        st.stop()
    st.dataframe(
        metars[["station", "valid", "vsby", "ceiling_ft", "obs_category", "wxcodes", "metar"]],
        use_container_width=True,
    )

    matched = attach_forecast_to_obs(metars, taf_periods, include_tempo=include_tempo)
    stats = contingency(matched, threshold)

    st.subheader(f"Verification summary: {threshold}-or-worse")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Hits", stats["hits"])
    c2.metric("Misses", stats["misses"])
    c3.metric("False Alarms", stats["false_alarms"])
    c4.metric("Correct Negatives", stats["correct_negatives"])

    c5, c6, c7 = st.columns(3)
    c5.metric("POD", f"{stats['POD']:.2f}" if pd.notna(stats["POD"]) else "NA")
    c6.metric("FAR", f"{stats['FAR']:.2f}" if pd.notna(stats["FAR"]) else "NA")
    c7.metric("CSI", f"{stats['CSI']:.2f}" if pd.notna(stats["CSI"]) else "NA")

    st.subheader("Matched forecast vs obs")
    st.dataframe(
        matched[["station", "valid", "forecast_category", "obs_category", "vsby", "ceiling_ft", "forecast_group", "metar"]],
        use_container_width=True,
    )

    csv = matched.to_csv(index=False).encode("utf-8")
    st.download_button("Download matched CSV", csv, file_name="taf_verification_matched.csv", mime="text/csv")
else:
    st.write("Pick the date/cycle/site on the left, then hit **Run verification**.")
