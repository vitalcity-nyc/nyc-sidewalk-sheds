"""
Sanity gates for the shed pipeline.

The failure mode this guards against: a partial or degraded upstream response
produces a technically-valid but wrong dataset, which then gets committed and
published. On an unattended nightly cron nobody notices for weeks.

So the build refuses to publish anything that fails these checks. A stale-but-
correct site beats a fresh-but-wrong one, and the workflow surfaces the failure.
"""
from __future__ import annotations

import json
from pathlib import Path


class ValidationError(RuntimeError):
    pass


# Absolute floors. The real count has run 7,000-9,000 for years; anything under
# 4,000 means we lost a chunk of the response rather than that sheds vanished.
MIN_SHEDS = 4000
MAX_SHEDS = 25000
# Night-over-night churn is a few dozen. A 35% swing is a pipeline bug, not news.
MAX_SWING_PCT = 35.0


def check_sheds(sheds: list) -> list[str]:
    errs = []
    n = len(sheds)
    if n < MIN_SHEDS:
        errs.append(f"only {n:,} sheds (floor {MIN_SHEDS:,}) — likely a truncated fetch")
    if n > MAX_SHEDS:
        errs.append(f"{n:,} sheds exceeds ceiling {MAX_SHEDS:,} — likely duplicated rows")

    if not sheds:
        return errs

    geo_bad = sum(1 for s in sheds if not (40.4 < (s.get("lat") or 0) < 41.0 and -74.3 < (s.get("lon") or 0) < -73.6))
    if geo_bad:
        errs.append(f"{geo_bad:,} sheds have coordinates outside NYC")

    no_date = sum(1 for s in sheds if not s.get("first"))
    if no_date > n * 0.05:
        errs.append(f"{no_date:,} sheds ({no_date/n:.0%}) have no start date")

    neg = sum(1 for s in sheds if (s.get("days") or 0) < 0)
    if neg:
        errs.append(f"{neg:,} sheds have negative duration")

    boros = {s.get("boro") for s in sheds if s.get("boro")}
    expected = {"Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"}
    missing = expected - boros
    if missing:
        errs.append(f"no sheds found in {', '.join(sorted(missing))} — partial fetch")

    dupes = n - len({s.get("bin") for s in sheds})
    if dupes:
        errs.append(f"{dupes:,} duplicate BINs")

    # Derived-metric checks. Counting rows is not enough: a broken *join* leaves
    # the shed count perfectly correct while silently corrupting the flags built
    # on top of it. This is not hypothetical — the DOB `shed` flag changed from
    # '0'/'1' to 'NO'/'YES', the zombie join matched nothing, and the zombie
    # count quintupled while total_active looked fine.
    # Threshold calibrated against observed runs, not guessed: a healthy build puts
    # the zombie share of year-plus sheds near 13% (432/3,352 in Jul 2026; 447/3,472
    # in Apr 2026). The broken-join build produced 71%. 40% sits far above the real
    # signal and far below the failure, so it catches the break without false alarms.
    over_1y = sum(1 for s in sheds if (s.get("days") or 0) >= 365)
    zombies = sum(1 for s in sheds if s.get("zombie"))
    if over_1y and zombies / over_1y > 0.40:
        errs.append(
            f"{zombies:,} of {over_1y:,} year-plus sheds ({zombies/over_1y:.0%}) are "
            "flagged zombie, versus ~13% historically. The recent-work join has "
            "probably broken — check the `shed` flag encoding in w9ak-ipjd."
        )

    # A shed with an UNSAFE facade filing has a documented reason to exist, so it
    # is never a zombie. If that invariant breaks, the FISP join is wrong.
    bad_zombie = sum(1 for s in sheds if s.get("zombie") and s.get("fisp") == "UNSAFE")
    if bad_zombie:
        errs.append(f"{bad_zombie:,} sheds flagged both zombie and UNSAFE — contradictory")

    # Every borough should have some FISP coverage; zero means the join dropped.
    if n and not any(s.get("fisp") for s in sheds):
        errs.append("no shed has any FISP status — the FISP join returned nothing")

    if n and not any(s.get("owner") and s.get("owner") != "—" for s in sheds):
        errs.append("no shed has an owner — the PLUTO join returned nothing")

    return errs


def check_cdistricts(cdist_rows: list, total_complaints: int) -> list[str]:
    """Guard the council-district scorecard against dead columns.

    The previous build summed a per-shed `complaints` key that only ever existed
    client-side, so every district silently reported 0 complaints. A column that is
    uniformly zero while the underlying data is not is the signature of that bug.
    """
    errs = []
    if not cdist_rows:
        return ["council-district scorecard is empty"]
    if total_complaints > 0 and not any(r.get("complaints") for r in cdist_rows):
        errs.append(
            f"{total_complaints:,} complaints exist but every council district reports 0 "
            "— the complaint join is dead"
        )
    if not any(r.get("worst_addr") for r in cdist_rows):
        errs.append("no council district has a worst-shed address")
    return errs


def check_against_previous(summary: dict, data_dir: Path) -> list[str]:
    """Compare to the last committed summary and flag implausible jumps."""
    prev_path = data_dir / "summary.json"
    if not prev_path.exists():
        return []
    try:
        prev = json.loads(prev_path.read_text())
    except Exception:
        return []
    prev_n = prev.get("total_active") or 0
    new_n = summary.get("total_active") or 0
    if prev_n < MIN_SHEDS or not new_n:
        return []
    swing = abs(new_n - prev_n) / prev_n * 100
    if swing > MAX_SWING_PCT:
        return [
            f"total_active moved {prev_n:,} -> {new_n:,} ({swing:.1f}%), over the "
            f"{MAX_SWING_PCT:.0f}% guard. If this is real, re-run with ALLOW_SWING=1."
        ]
    return []


def gate(sheds: list, summary: dict, data_dir: Path, allow_swing: bool = False,
         cdist_rows: list | None = None) -> None:
    errs = check_sheds(sheds)
    if cdist_rows is not None:
        errs += check_cdistricts(cdist_rows, summary.get("complaints_12mo", 0))
    swing_errs = [] if allow_swing else check_against_previous(summary, data_dir)
    all_errs = errs + swing_errs
    if all_errs:
        raise ValidationError(
            "Refusing to publish; data failed sanity checks:\n"
            + "\n".join(f"  - {e}" for e in all_errs)
        )
