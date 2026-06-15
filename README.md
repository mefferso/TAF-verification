# TAF Verification Prototype

A first-pass Streamlit dashboard for verifying LIX TAF ceiling/visibility categories against archived METAR observations from the Iowa Environmental Mesonet (IEM).

## What it does now

- Select a UTC date, TAF issuance cycle, terminal, and verification window.
- Fetch the archived collective `TAFLIX` product from IEM.
- Fetch METAR observations from IEM for the selected terminal(s).
- Classify observed flight category from ceiling and visibility.
- Parse a basic forecast category from TAF prevailing/FM groups.
- Calculate contingency-table stats for LIFR/IFR/MVFR-or-worse events:
  - hits
  - misses
  - false alarms
  - correct negatives
  - POD
  - FAR
  - CSI

## Important limitations

This is an initial operational prototype, not a final official verification system.

Current TAF parsing is intentionally conservative:

- Prevailing/FM groups are supported first.
- TEMPO/PROB/BECMG groups are parsed and shown, but excluded from verification by default.
- Wind, thunder, precip type, and exact categorical timing logic are not fully implemented yet.
- The first major science decision still needs to be locked down: verify each METAR against its valid TAF group, or verify any occurrence during the first 6 hours.

## Local setup

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
streamlit run app.py
```

On Mac/Linux:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

## Default LIX terminals

Edit `config.py` to change the terminal list.

```python
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
```

## Next build steps

1. Confirm how TEMPO/PROB groups should count.
2. Add all-terminal summary rows.
3. Add occurrence-based verification option.
4. Add charts for category forecast vs observed timeline.
5. Add unit tests with saved TAF/METAR examples.
