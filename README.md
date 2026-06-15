# TAF Verification Web App

Google Apps Script + GitHub implementation for verifying LIX TAF ceiling/visibility categories against archived METAR observations from the Iowa Environmental Mesonet (IEM).

This version stays inside the two allowed buckets:

- **GitHub** stores the source code.
- **Google Apps Script** runs the web app and fetches IEM data server-side.

No local Python. No PowerShell. No coworker laptop setup.

## Files

```text
apps-script/
├── Code.gs      # Apps Script backend: fetches TAF/METAR data, parses, verifies
└── Index.html   # Dashboard UI
```

## What it does now

- User selects UTC date, TAF cycle, terminal, category threshold, and verification window.
- Fetches archived `TAFLIX` product from IEM.
- Fetches METAR observations from IEM.
- Classifies observed flight category from ceiling/visibility.
- Parses basic TAF prevailing/FM groups.
- Displays TEMPO/PROB/BECMG groups and optionally includes them.
- Calculates:
  - hits
  - misses
  - false alarms
  - correct negatives
  - POD
  - FAR
  - CSI

## Deploy in Google Apps Script

1. Go to [script.google.com](https://script.google.com).
2. Create a new project named `TAF Verification`.
3. Replace the default `Code.gs` with the contents of `apps-script/Code.gs`.
4. Add a new HTML file named exactly `Index`.
5. Paste the contents of `apps-script/Index.html` into that file.
6. Click **Deploy** → **New deployment**.
7. Choose **Web app**.
8. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone in your organization, or whatever your office allows
9. Click **Deploy**.
10. Open the generated web app URL.

## First test

Use a recent date/cycle and one terminal first, not all terminals.

Example:

```text
UTC date: yesterday
Cycle: 12z
Terminal: KMSY
Threshold: IFR-or-worse
Window: 6 hours
```

If IEM changes a parameter or the AFOS listing scrape needs a tweak, the app will show the exact URL it tried in the error message. That is intentional so we can fix the data-fetch logic fast instead of guessing.

## Current limitations

This is still a first-pass verifier.

- Prevailing/FM handling is the default verification mode.
- TEMPO/PROB/BECMG handling is experimental.
- Wind verification is not implemented yet.
- Weather-type verification is not implemented yet.
- The science decision still needs to be locked down: verify each METAR against the valid TAF group, or verify occurrence anywhere in the first 6 hours.

## Default LIX terminals

Defined in `apps-script/Code.gs`:

```javascript
['KMSY', 'KBTR', 'KNEW', 'KHDC', 'KHUM', 'KGPT', 'KASD', 'KMCB']
```
