# NYC sidewalk shed tracker

Interactive embed mapping every active sidewalk shed in NYC with duration, building owner (per PLUTO), and a "zombie shed" flag for buildings where the shed has been up over a year with no recent non-shed construction filed.

Designed as a companion embed to a longer article. Built to Vital City visual specs but unbranded.

Data refreshes automatically every night from NYC Open Data. If the refresh ever
stops, a watchdog opens an issue on this repo rather than letting the embed quietly
serve stale numbers. Live counts are in [`data/summary.json`](data/summary.json) —
they move nightly, so this README deliberately does not restate them.

## How it works

- `scripts/build_data.py` pulls eight NYC Open Data endpoints (DOB NOW permits,
  legacy DOB permits, DOB NOW job filings, PLUTO, FISP/Local Law 11, HPD
  violations, HPD Alternative Enforcement, and 311 Scaffold Safety complaints) and
  writes seven JSON snapshots into `data/`. Every write is atomic and gated on
  `scripts/validate.py`, so a partial or degraded upstream response fails the build
  instead of publishing wrong numbers.
- `index.html` + `assets/` is a static embed — Leaflet map, vanilla JS, no build step.

### Scheduled jobs

| Workflow | When | What it does |
| --- | --- | --- |
| `refresh.yml` | 07:20 UTC daily | Rebuilds data, commits only if something changed |
| `staleness-check.yml` | 13:45 UTC daily | Opens an issue if published data is >3 days old |

Both can be run manually from the Actions tab. If a genuine jump in shed counts
trips the swing guard, re-run `refresh.yml` with `allow_swing` checked.

**History worth keeping.** An earlier version of this README described the nightly
workflow as "applied separately because the initial push token lacked the `workflow`
scope." It was never applied — there was no `.github/workflows` directory, nothing
ever ran, and the published data sat frozen for about three months without anyone
noticing. That is why the staleness watchdog exists: a refresh that never runs looks
exactly like a repo at rest.

The pipeline here is shared with
[joshgreenman1973/nyc-sidewalk-sheds](https://github.com/joshgreenman1973/nyc-sidewalk-sheds),
the standalone full-screen version of the same tracker. Fixes should land in both.

### The Socrata app token (optional)

A full build makes roughly 46 requests once a day, which runs fine against
Socrata's anonymous per-IP pool. Set a `SOCRATA_APP_TOKEN` repo secret only if
builds start failing on throttling; the workflow picks it up automatically.

See [methodology.html](methodology.html) for the full transparency pass.

## Local development

```bash
python3 scripts/build_data.py            # ~10 minutes, writes data/*.json
python3 -m http.server 8765              # serve the embed
open http://localhost:8765
```

## Embedding

The embed posts `embed-resize` and `embed-state` `postMessage` events to its parent and supports URL parameters for deep-linking from the parent article: `?view=zombies`, `?boro=Manhattan`, `?dur=1825-99999`, `?zombie=1`, `?q=NYCHA`.
