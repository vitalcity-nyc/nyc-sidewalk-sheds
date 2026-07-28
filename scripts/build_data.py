"""
Build data for the NYC sidewalk shed tracker.

Sources (all NYC Open Data / Socrata):
  rbx6-tga4  DOB NOW: Build approved permits  — current + historical shed permits
  ipu4-2q9a  DOB legacy permit issuance       — pre-DOB-NOW first-erected dates
  w9ak-ipjd  DOB NOW job filings              — zombie detection (recent non-shed work)
  64uk-42ks  PLUTO                            — owner, year built, units
  xubg-57si  FISP / Local Law 11              — facade safety status
  wvxf-dwi5  HPD violations                   — open class B/C counts
  hcir-3275  HPD Alternative Enforcement      — distressed-building flag
  erm2-nwe9  311 service requests             — Scaffold Safety complaints

Writes JSON snapshots into data/. Every write is atomic and gated on validation;
see validate.py for why. Set SOCRATA_APP_TOKEN to avoid anonymous throttling.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import socrata
import validate

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

TODAY = date.today()
TODAY_ISO = TODAY.isoformat()
ZOMBIE_DAYS = 365
RUN_GAP_BRIDGE = timedelta(days=30)  # gap <=30 days = paperwork lag; longer = a real gap
ALLOW_SWING = os.environ.get("ALLOW_SWING") == "1"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def write_atomic(path: Path, payload, indent=None) -> None:
    """Write via temp file + rename so a crash mid-write cannot truncate good data."""
    sep = (",", ":") if indent is None else None
    text = json.dumps(payload, separators=sep, indent=indent)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def parse_dt(s):
    if not s:
        return None
    s = str(s).replace("Z", "")
    try:
        return datetime.fromisoformat(s).date()
    except Exception:
        pass
    # The legacy DOB permit dataset stores dates as MM/DD/YYYY strings.
    try:
        return datetime.strptime(s.split(" ")[0], "%m/%d/%Y").date()
    except Exception:
        return None


def build_runs(permit_dates):
    """Collapse (issued, expired) pairs into contiguous runs, bridging short gaps."""
    items = sorted([(i, e) for i, e in permit_dates if i and e], key=lambda x: x[0])
    if not items:
        return []
    runs = []
    cur_s, cur_e = items[0]
    for i, e in items[1:]:
        if i <= cur_e + RUN_GAP_BRIDGE:
            cur_e = max(cur_e, e)
        else:
            runs.append((cur_s, cur_e))
            cur_s, cur_e = i, e
    runs.append((cur_s, cur_e))
    return runs


def latest_run_start(permit_dates):
    runs = build_runs(permit_dates)
    if not runs:
        return None, None
    for s, e in runs:
        if s <= TODAY <= e:
            return s, e
    return runs[-1]


def main() -> int:
    t0 = time.time()
    log(f"Build start {datetime.now(timezone.utc).isoformat()}  "
        f"token={'yes' if socrata.has_token() else 'NO (anonymous, may throttle)'}")

    # 1. Currently-active DOB NOW shed permits.
    log("[1/8] DOB NOW active shed permits...")
    now_active = socrata.fetch_all(
        "rbx6-tga4",
        where=("work_type='Sidewalk Shed' "
               f"AND expired_date >= '{TODAY_ISO}T00:00:00' "
               "AND permit_status='Permit Issued'"),
        select=("bin,bbl,block,lot,house_no,street_name,borough,zip_code,latitude,longitude,"
                "community_board,council_district,nta,issued_date,expired_date,"
                "filing_reason,owner_name,owner_business_name,applicant_business_name,"
                "job_description,permit_status,work_permit,job_filing_number"),
        what="active shed permits",
    )
    if not now_active:
        log("FATAL: zero active permits returned — aborting rather than publishing an empty map")
        return 1

    # 2. Full DOB NOW shed history (for run-start + trend).
    log("[2/8] DOB NOW full shed permit history...")
    now_hist = socrata.fetch_all(
        "rbx6-tga4", where="work_type='Sidewalk Shed' AND bin IS NOT NULL",
        select="bin,issued_date,expired_date", what="shed permit history",
    )

    # 3. Legacy pre-DOB-NOW shed permits.
    log("[3/8] Legacy DOB shed permits...")
    legacy = socrata.fetch_all(
        "ipu4-2q9a", where="permit_subtype='SH' AND bin__ IS NOT NULL",
        select="bin__,issuance_date,expiration_date", what="legacy shed permits",
    )

    history = defaultdict(list)
    for r in now_hist:
        history[str(r.get("bin"))].append((parse_dt(r.get("issued_date")), parse_dt(r.get("expired_date"))))
    for r in legacy:
        history[str(r.get("bin__"))].append((parse_dt(r.get("issuance_date")), parse_dt(r.get("expiration_date"))))

    active_bins = sorted({str(r["bin"]) for r in now_active if r.get("bin")})
    active_bbls = sorted({str(r["bbl"]).split(".")[0] for r in now_active if r.get("bbl")})
    log(f"  unique active BINs: {len(active_bins):,}  BBLs: {len(active_bbls):,}")

    # 4. PLUTO owner/building info for just the BBLs we need.
    log(f"[4/8] PLUTO for {len(active_bbls):,} BBLs...")
    pluto = {}
    for row in socrata.fetch_in_chunks(
        "64uk-42ks", "bbl", active_bbls,
        select="bbl,ownername,yearbuilt,unitsres,unitstotal,bldgclass,address",
        what="PLUTO",
    ):
        pluto[str(row.get("bbl")).split(".")[0]] = row

    # 5. HPD open B/C violations, aggregated citywide then indexed by BBL.
    log("[5/8] HPD open class B/C violations...")
    hpd_open = defaultdict(lambda: {"b": 0, "c": 0})
    for cls in ("B", "C"):
        rows = socrata.fetch_json(
            socrata.build_url(
                "wvxf-dwi5", select="boroid,block,lot,count(*) as cnt",
                where=f"violationstatus='Open' AND class='{cls}'",
                group="boroid,block,lot", limit=250000,
            ),
            what=f"HPD class {cls}",
        )
        for row in rows:
            try:
                bbl = f"{row['boroid']}{str(int(row['block'])).zfill(5)}{str(int(row['lot'])).zfill(4)}"
            except Exception:
                continue
            hpd_open[bbl][cls.lower()] += int(row["cnt"])
        log(f"  class {cls}: {len(rows):,} BBLs")

    # 6. HPD Alternative Enforcement Program (distressed buildings).
    log("[6/8] HPD AEP list...")
    aep_bins, aep_bbls = set(), set()
    for r in socrata.fetch_all("hcir-3275", select="*", page=20000, what="AEP"):
        if r.get("bin"):
            aep_bins.add(str(r["bin"]))
        if r.get("bbl"):
            aep_bbls.add(str(r["bbl"]).split(".")[0])

    # 7. FISP (Local Law 11) facade filings for our BINs.
    log(f"[7/8] FISP filings for {len(active_bins):,} BINs...")
    fisp_by_bin = {}
    for row in socrata.fetch_in_chunks(
        "xubg-57si", "bin", active_bins,
        select="bin,cycle,current_status,filing_status,sequence_no",
        what="FISP",
    ):
        b = str(row.get("bin"))
        key = (int(row.get("cycle") or 0), int(row.get("sequence_no") or 0))
        cur = fisp_by_bin.get(b)
        if cur is None or key > (int(cur.get("cycle") or 0), int(cur.get("sequence_no") or 0)):
            fisp_by_bin[b] = row
    log(f"  BINs with a FISP record: {len(fisp_by_bin):,}")

    # 8. Recent non-shed job filings => the building is actually being worked on.
    #
    # The `shed` flag is a boolean-ish column whose encoding DOB has changed at
    # least once: it was '0'/'1' and is now 'NO'/'YES'. The old query hard-coded
    # shed='0', so after the switch it silently matched zero rows and every
    # long-standing shed got mislabelled a zombie. Accept both encodings, and
    # treat an empty result as fatal rather than as "no work happened citywide".
    cutoff = (TODAY - timedelta(days=ZOMBIE_DAYS)).isoformat()
    log(f"[8/8] DOB NOW job filings since {cutoff}...")
    jobs = socrata.fetch_all(
        "w9ak-ipjd",
        where=(f"current_status_date >= '{cutoff}T00:00:00' AND bin IS NOT NULL "
               "AND shed in('NO','0','false','FALSE')"),
        select="bin,job_filing_number,current_status_date,filing_status",
        what="recent job filings",
    )
    bins_with_recent_work = {str(r["bin"]) for r in jobs if r.get("bin")}
    log(f"  BINs with recent non-shed work: {len(bins_with_recent_work):,}")
    if not bins_with_recent_work:
        log("FATAL: zero buildings with recent non-shed work in a full year. That is "
            "not plausible; the `shed` flag encoding has probably changed again. "
            "Refusing to run, because this would mislabel every shed as a zombie.")
        return 1

    # --- Assemble one record per BIN, attributed to its newest active permit ---
    by_bin = {}
    for r in now_active:
        bin_ = str(r.get("bin") or "")
        if not bin_ or bin_ == "None":
            continue
        cur = by_bin.get(bin_)
        if cur is None or (parse_dt(r.get("issued_date")) or date.min) > (parse_dt(cur.get("issued_date")) or date.min):
            by_bin[bin_] = r

    sheds = []
    for bin_, r in by_bin.items():
        run_start, _ = latest_run_start(history.get(bin_, []))
        active_issued = parse_dt(r.get("issued_date"))
        if run_start is None or (active_issued and active_issued < run_start):
            run_start = active_issued
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError, KeyError):
            continue

        bbl = str(r.get("bbl") or "").split(".")[0]
        plut = pluto.get(bbl, {})
        pluto_owner = (plut.get("ownername") or "").strip().upper()
        permit_owner = (r.get("owner_business_name") or r.get("owner_name") or "").strip().upper()
        owner = pluto_owner or permit_owner

        fisp = fisp_by_bin.get(bin_, {})
        fisp_status = (fisp.get("current_status") or "").upper() or None
        hpd = hpd_open.get(bbl, {"b": 0, "c": 0})
        hpd_b, hpd_c = hpd.get("b", 0), hpd.get("c", 0)
        is_aep = bin_ in aep_bins or bbl in aep_bbls
        # Class C is hazardous (weight 3), B is significant (1), AEP adds 10.
        distress = min(hpd_c * 3 + hpd_b + (10 if is_aep else 0), 30)
        days_up = (TODAY - run_start).days if run_start else 0
        is_zombie = (days_up >= ZOMBIE_DAYS
                     and bin_ not in bins_with_recent_work
                     and fisp_status != "UNSAFE")

        sheds.append({
            "bin": bin_, "bbl": bbl,
            "addr": f"{(r.get('house_no') or '').strip()} {(r.get('street_name') or '').strip()}".strip().title(),
            "boro": (r.get("borough") or "").title(),
            "zip": r.get("zip_code") or "",
            "cd": r.get("community_board") or "",
            "cdist": r.get("council_district") or "",
            "nta": r.get("nta") or "",
            "lat": round(lat, 6), "lon": round(lon, 6),
            "first": run_start.isoformat() if run_start else None,
            "exp": (parse_dt(r.get("expired_date")).isoformat() if parse_dt(r.get("expired_date")) else None),
            "days": days_up,
            "owner": owner or "—",
            "osrc": "pluto" if pluto_owner else "permit",
            "yrbuilt": plut.get("yearbuilt") or "",
            "units": plut.get("unitsres") or "",
            "bclass": plut.get("bldgclass") or "",
            "reason": r.get("filing_reason") or "",
            "job": r.get("job_filing_number") or r.get("work_permit") or "",
            "appl": (r.get("applicant_business_name") or "").strip(),
            "block": str(r.get("block") or ""), "lot": str(r.get("lot") or ""),
            "zombie": is_zombie,
            "fisp": fisp_status,
            "fisp_cycle": fisp.get("cycle") or None,
            "fisp_just": fisp_status == "UNSAFE",
            "hpd_b": hpd_b, "hpd_c": hpd_c,
            "aep": is_aep, "distress": distress,
        })

    sheds.sort(key=lambda s: -s["days"])
    log(f"Assembled {len(sheds):,} sheds; {sum(1 for s in sheds if s['zombie']):,} zombies")

    # --- 311 Scaffold Safety complaints, past 12 months ---
    log("311 Scaffold Safety complaints...")
    complaints = []
    for c in socrata.fetch_all(
        "erm2-nwe9",
        where=(f"complaint_type='Scaffold Safety' AND created_date >= '{cutoff}T00:00:00' "
               "AND latitude IS NOT NULL"),
        select=("unique_key,created_date,closed_date,status,descriptor,"
                "incident_address,borough,latitude,longitude"),
        what="311 complaints",
    ):
        try:
            lat, lon = float(c["latitude"]), float(c["longitude"])
        except (TypeError, ValueError, KeyError):
            continue
        complaints.append({
            "id": c.get("unique_key"), "lat": round(lat, 6), "lon": round(lon, 6),
            "addr": (c.get("incident_address") or "").title(),
            "boro": (c.get("borough") or "").title(),
            "desc": c.get("descriptor") or "",
            "created": (c.get("created_date") or "")[:10],
            "closed": (c.get("closed_date") or "")[:10],
            "status": c.get("status") or "",
        })

    loc_counts = defaultdict(list)
    for c in complaints:
        loc_counts[(round(c["lat"], 4), round(c["lon"], 4))].append(c)
    for c in complaints:
        c["loc_count"] = len(loc_counts[(round(c["lat"], 4), round(c["lon"], 4))])
    chronic = []
    for (lat, lon), items in loc_counts.items():
        if len(items) >= 2:
            srt = sorted(items, key=lambda x: x["created"], reverse=True)
            chronic.append({"lat": lat, "lon": lon, "addr": srt[0]["addr"], "boro": srt[0]["boro"],
                            "count": len(items), "last_filed": srt[0]["created"],
                            "first_filed": srt[-1]["created"]})
    chronic.sort(key=lambda x: -x["count"])

    # --- Aggregations ---
    cd_agg = defaultdict(lambda: {"sheds": 0, "shed_days": 0, "zombies": 0})
    for s in sheds:
        if not s["cd"]:
            continue
        a = cd_agg[s["cd"]]
        a["sheds"] += 1
        a["shed_days"] += s["days"]
        a["zombies"] += 1 if s["zombie"] else 0
    cd_rows = sorted([{"cd": k, **v} for k, v in cd_agg.items()], key=lambda x: -x["shed_days"])

    # Attach a 311 count to each shed by rounded-coordinate match (~10m), mirroring
    # what the client does at load time. The previous build aggregated s["complaints"]
    # server-side, but that key is only ever attached in the browser — so the column
    # summed nothing and every council district reported exactly 0 complaints.
    c_index = defaultdict(int)
    for c in complaints:
        c_index[(round(c["lat"], 4), round(c["lon"], 4))] += 1
    for s in sheds:
        s["complaints"] = c_index.get((round(s["lat"], 4), round(s["lon"], 4)), 0)

    # Precompute the worst shed per council district in one pass. The previous
    # version rescanned all sheds inside the per-district loop.
    worst_by_cdist = {}
    for s in sheds:
        cd = str(s.get("cdist") or "")
        if cd and (cd not in worst_by_cdist or s["days"] > worst_by_cdist[cd]["days"]):
            worst_by_cdist[cd] = s

    cdist_agg = defaultdict(lambda: {"sheds": 0, "shed_days": 0, "zombies": 0, "over_1y": 0,
                                     "over_5y": 0, "unsafe": 0, "distressed": 0,
                                     "complaints": 0, "days_list": []})
    for s in sheds:
        cd = str(s.get("cdist") or "")
        if not cd:
            continue
        c = cdist_agg[cd]
        c["sheds"] += 1
        c["shed_days"] += s["days"]
        c["days_list"].append(s["days"])
        c["complaints"] += s["complaints"]
        if s["days"] >= 365: c["over_1y"] += 1
        if s["days"] >= 1825: c["over_5y"] += 1
        if s["zombie"]: c["zombies"] += 1
        if s["fisp"] == "UNSAFE": c["unsafe"] += 1
        if s["distress"] >= 10: c["distressed"] += 1
    cdist_rows = []
    for cd, c in cdist_agg.items():
        ds = sorted(c["days_list"])
        worst = worst_by_cdist.get(cd)
        cdist_rows.append({
            "cdist": cd, "sheds": c["sheds"], "shed_days": c["shed_days"],
            "median_days": ds[len(ds) // 2] if ds else 0,
            "over_1y": c["over_1y"], "over_5y": c["over_5y"], "zombies": c["zombies"],
            "unsafe": c["unsafe"], "distressed": c["distressed"],
            "complaints": c["complaints"],
            "worst_addr": f"{worst['addr']}, {worst['boro']}" if worst else "",
            "worst_days": worst["days"] if worst else 0,
            "worst_bin": worst["bin"] if worst else "",
        })
    cdist_rows.sort(key=lambda x: -x["shed_days"])

    days_sorted = sorted(s["days"] for s in sheds)
    summary = {
        "as_of": TODAY_ISO,
        "total_active": len(sheds),
        "longest_days": days_sorted[-1] if days_sorted else 0,
        "over_10y": sum(1 for d in days_sorted if d >= 3650),
        "over_5y": sum(1 for d in days_sorted if d >= 1825),
        "over_3y": sum(1 for d in days_sorted if d >= 1095),
        "over_1y": sum(1 for d in days_sorted if d >= 365),
        "median_days": days_sorted[len(days_sorted) // 2] if days_sorted else 0,
        "zombies": sum(1 for s in sheds if s["zombie"]),
        "complaints_12mo": len(complaints),
        "chronic_sites": len(chronic),
        "fisp_unsafe": sum(1 for s in sheds if s["fisp"] == "UNSAFE"),
        "fisp_swarmp": sum(1 for s in sheds if s["fisp"] == "SWARMP"),
        "fisp_safe": sum(1 for s in sheds if s["fisp"] == "SAFE"),
        "fisp_no_filing": sum(1 for s in sheds if not s["fisp"]),
        "with_open_hpd": sum(1 for s in sheds if s["hpd_b"] + s["hpd_c"] > 0),
        "with_open_class_c": sum(1 for s in sheds if s["hpd_c"] > 0),
        "in_aep": sum(1 for s in sheds if s["aep"]),
        "high_distress": sum(1 for s in sheds if s["distress"] >= 10),
    }

    # --- GATE: validate before writing anything at all ---
    log("Validating...")
    validate.gate(sheds, summary, DATA, allow_swing=ALLOW_SWING, cdist_rows=cdist_rows)
    log("  passed")

    # --- Monthly trend since 2010 ---
    log("Computing monthly trend...")
    runs = []
    for dates in history.values():
        runs.extend(build_runs(dates))
    months = []
    y, m = 2010, 1
    while (y, m) <= (TODAY.year, TODAY.month):
        d = date(y, m, 1)
        active = [r for r in runs if r[0] <= d <= r[1]]
        durs = sorted((d - r[0]).days for r in active)
        months.append({"m": d.isoformat()[:7], "n": len(active),
                       "med": durs[len(durs) // 2] if durs else 0})
        m += 1
        if m > 12:
            m, y = 1, y + 1

    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "build_seconds": round(time.time() - t0, 1),
        "used_app_token": socrata.has_token(),
        "source_rows": {
            "active_permits": len(now_active), "shed_history": len(now_hist),
            "legacy_permits": len(legacy), "pluto_bbls": len(pluto),
            "fisp_bins": len(fisp_by_bin), "aep_bins": len(aep_bins),
            "recent_job_bins": len(bins_with_recent_work), "complaints_311": len(complaints),
        },
    }

    write_atomic(DATA / "sheds.json", sheds)
    write_atomic(DATA / "cd.json", cd_rows)
    write_atomic(DATA / "cdistricts.json", cdist_rows)
    write_atomic(DATA / "complaints311.json", complaints)
    write_atomic(DATA / "chronic311.json", chronic)
    write_atomic(DATA / "trend.json", months)
    write_atomic(DATA / "summary.json", summary, indent=2)
    write_atomic(DATA / "build_meta.json", meta, indent=2)

    log(f"Wrote {DATA} in {meta['build_seconds']}s")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except validate.ValidationError as e:
        print(f"\nVALIDATION FAILED\n{e}\n\nNo files written; existing data left intact.", file=sys.stderr)
        sys.exit(2)
    except socrata.SocrataError as e:
        print(f"\nUPSTREAM FETCH FAILED\n{e}\n\nNo files written; existing data left intact.", file=sys.stderr)
        sys.exit(3)
