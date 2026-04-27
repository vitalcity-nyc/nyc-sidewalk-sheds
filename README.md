# NYC sidewalk shed tracker

Interactive embed mapping every active sidewalk shed in NYC with duration, building owner (per PLUTO), and a "zombie shed" flag for buildings where the shed has been up over a year with no recent non-shed construction filed.

Designed as a companion embed to a longer article. Built to Vital City visual specs but unbranded.

## Live data

- 7,400+ active shed-bearing buildings citywide
- 595 zombie sheds (>1 year up, no recent work filings)
- 539 sheds up over five years; longest is 8.5 years and counting
- Refreshed nightly from NYC Open Data

## How it works

- `scripts/build_data.py` pulls four NYC Open Data endpoints (DOB NOW permits, legacy DOB permits, DOB NOW job filings, PLUTO) and writes three small JSON files into `data/`
- `index.html` + `assets/` is a static embed — Leaflet map, vanilla JS, no build step
- A nightly GitHub Actions workflow (in `.github/workflows/refresh.yml`, applied separately because the initial push token lacked the `workflow` scope) runs `build_data.py` and commits the refreshed JSON. Re-add it via the GitHub web UI or push it from a token with the `workflow` scope.

See [methodology.html](methodology.html) for the full transparency pass.

## Local development

```bash
python3 scripts/build_data.py            # ~5 minutes, writes data/*.json
python3 -m http.server 8765              # serve the embed
open http://localhost:8765
```

## Embedding

The embed posts `embed-resize` and `embed-state` `postMessage` events to its parent and supports URL parameters for deep-linking from the parent article: `?view=zombies`, `?boro=Manhattan`, `?dur=1825-99999`, `?zombie=1`, `?q=NYCHA`.
