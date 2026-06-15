"""Default configuration for the LIX TAF verification prototype."""

from __future__ import annotations

LIX_WFO = "LIX"
LIX_TAF_PRODUCT = "TAFLIX"

# Edit this list as needed. I included the usual LIX aviation terminals plus nearby
# terminals that may show up depending on local office practice.
DEFAULT_SITES = [
    "KMSY",
    "KBTR",
    "KNEW",
    "KHDC",
    "KHUM",
    "KGPT",
    "KASD",
    "KMCB",
]

CYCLES_UTC = [0, 6, 12, 18]

FLIGHT_CATEGORY_ORDER = ["LIFR", "IFR", "MVFR", "VFR"]
