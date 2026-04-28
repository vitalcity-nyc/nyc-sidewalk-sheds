"""
Build data for the NYC sidewalk shed embed.

Pulls from NYC Open Data (Socrata):
  - DOB NOW: Build approved permits (rbx6-tga4) for current shed permits
  - DOB Permit Issuance legacy (ipu4-2q9a) for pre-DOB-NOW first-erected dates
  - DOB NOW Job Filings (w9ak-ipjd) to detect "zombie" sheds with no recent work
  - PLUTO (64uk-42ks) for owner names, building age, units

Writes JSON snapshots into ../data/ for the static embed to load.

No Socrata app token required at this volume; we paginate with $limit/$offset.
"""
from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

TODAY = date.today()
TODAY_ISO = TODAY.isoformat()
ZOMBIE_DAYS = 365  # no construction work filed in the last year => zombie
RUN_GAP_BRIDGE = timedelta(days=30)  # gap ≤30 days = paperwork lag; longer = real gap

UA = "vital-city-sidewalk-sheds/0.1 (https://github.com/vitalcity-nyc)"

def fetch_all(resource: str, where: str, select: str = "*", page: int = 50000, sleep: float = 0.0):
    """Page through a Socrata resource with $where + $select."""
    base = f"https://data.cityofnewyork.us/resource/{resource}.json"
    out = []
    offset = 0
    while True:
        url = (
            f"{base}?$select={quote(select)}&$where={quote(where)}"
            f"&$limit={page}&$offset={offset}&$order=:id"
        )
        req = Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        for attempt in range(3):
            try:
                with urlopen(req, timeout=120) as r:
                    chunk = json.loads(r.read())
                break
            except Exception as e:
                if attempt == 2:
                    raise
                print(f"  retry {attempt+1}: {e}", file=sys.stderr)
                time.sleep(2)
        out.extend(chunk)
        print(f"  {resource}: fetched {len(out):,} rows", file=sys.stderr)
        if len(chunk) < page:
            break
        offset += page
        if sleep:
            time.sleep(sleep)
    return out


def parse_dt(s):
    if not s:
        return None
    s = s.replace("Z", "")
    try:
        return datetime.fromisoformat(s).date()
    except Exception:
        pass
    # Legacy DOB permit dataset stores dates as MM/DD/YYYY strings.
    try:
        return datetime.strptime(s.split(" ")[0], "%m/%d/%Y").date()
    except Exception:
        return None


def latest_run_start(permit_dates):
    """
    permit_dates: list of (issued, expired) date tuples.
    Returns (run_start, run_end_max) for the contiguous run that includes today,
    or the most recent run if today is past the last expiration.
    """
    items = sorted(
        [(i, e) for i, e in permit_dates if i and e],
        key=lambda x: x[0],
    )
    if not items:
        return None, None
    runs = []
    cur_start, cur_end = items[0]
    for i, e in items[1:]:
        if i <= cur_end + RUN_GAP_BRIDGE:
            if e > cur_end:
                cur_end = e
        else:
            runs.append((cur_start, cur_end))
            cur_start, cur_end = i, e
    runs.append((cur_start, cur_end))
    for s, e in runs:
        if s <= TODAY <= e:
            return s, e
    return runs[-1]


def main():
    # 1. Active DOB NOW shed permits (current).
    print("Fetching DOB NOW active shed permits...", file=sys.stderr)
    where_now = (
        "work_type='Sidewalk Shed' "
        f"AND expired_date >= '{TODAY_ISO}T00:00:00' "
        "AND permit_status='Permit Issued'"
    )
    now_active = fetch_all(
        "rbx6-tga4", where_now,
        select=("bin,bbl,block,lot,house_no,street_name,borough,zip_code,latitude,longitude,"
                "community_board,council_district,nta,issued_date,expired_date,"
                "filing_reason,owner_name,owner_business_name,applicant_business_name,"
                "job_description,work_on_floor,permit_status,work_permit,job_filing_number"),
    )
    print(f"  active permits: {len(now_active):,}", file=sys.stderr)

    # 2. Full DOB NOW shed history (for run-start calculation per BIN).
    #    Fetch issued_date & expired_date for ALL shed permits (not just active).
    print("Fetching full DOB NOW shed permit history...", file=sys.stderr)
    where_hist = "work_type='Sidewalk Shed' AND bin IS NOT NULL"
    now_hist = fetch_all(
        "rbx6-tga4", where_hist,
        select="bin,issued_date,expired_date",
    )
    print(f"  total DOB NOW shed permits: {len(now_hist):,}", file=sys.stderr)

    # 3. Legacy DOB shed permits (pre-DOB-NOW).
    print("Fetching legacy DOB shed permits...", file=sys.stderr)
    where_legacy = "permit_subtype='SH' AND bin__ IS NOT NULL"
    legacy = fetch_all(
        "ipu4-2q9a", where_legacy,
        select="bin__,issuance_date,expiration_date",
    )
    print(f"  legacy shed permits: {len(legacy):,}", file=sys.stderr)

    # Build per-BIN permit history.
    history = defaultdict(list)
    for r in now_hist:
        history[str(r.get("bin"))].append((parse_dt(r.get("issued_date")), parse_dt(r.get("expired_date"))))
    for r in legacy:
        history[str(r.get("bin__"))].append((parse_dt(r.get("issuance_date")), parse_dt(r.get("expiration_date"))))

    # Get the unique BINs we actually need.
    active_bins = {str(r.get("bin")) for r in now_active if r.get("bin")}
    print(f"  unique active BINs: {len(active_bins):,}", file=sys.stderr)

    # 4. PLUTO for owner / building info — fetch only the BBLs we need.
    active_bbls = sorted({str(r.get("bbl")) for r in now_active if r.get("bbl")})
    print(f"Fetching PLUTO for {len(active_bbls):,} BBLs...", file=sys.stderr)
    pluto = {}
    CHUNK = 500
    for i in range(0, len(active_bbls), CHUNK):
        bbls = active_bbls[i : i + CHUNK]
        in_clause = ",".join(f"'{b}'" for b in bbls)
        where = f"bbl in({in_clause})"
        select = "bbl,ownername,yearbuilt,unitsres,unitstotal,bldgclass,address"
        url = (
            "https://data.cityofnewyork.us/resource/64uk-42ks.json"
            f"?$select={quote(select)}&$where={quote(where)}&$limit=50000"
        )
        req = Request(url, headers={"User-Agent": UA})
        with urlopen(req, timeout=120) as r:
            chunk = json.loads(r.read())
        for row in chunk:
            key = str(row["bbl"]).split(".")[0]
            pluto[key] = row
        if (i // CHUNK) % 5 == 0:
            print(f"  PLUTO progress: {i+len(bbls):,}/{len(active_bbls):,}", file=sys.stderr)

    # 4a. HPD open B/C violations per shed BBL — aggregate citywide then index.
    print("Fetching HPD open B/C violation counts (citywide aggregate)...", file=sys.stderr)
    hpd_open = defaultdict(lambda: {"b": 0, "c": 0})
    for cls in ("B", "C"):
        select = "boroid,block,lot,count(*) as cnt"
        where = f"violationstatus='Open' AND class='{cls}'"
        url = (
            "https://data.cityofnewyork.us/resource/wvxf-dwi5.json"
            f"?$select={quote(select)}&$where={quote(where)}"
            f"&$group={quote('boroid,block,lot')}&$limit=200000"
        )
        req = Request(url, headers={"User-Agent": UA})
        try:
            with urlopen(req, timeout=300) as r:
                rows = json.loads(r.read())
        except Exception as e:
            print(f"  HPD class-{cls} fetch failed ({e}); skipping", file=sys.stderr)
            rows = []
        # Build BBL strings from boroid+block+lot.
        for row in rows:
            try:
                boro = row["boroid"]
                block = str(int(row["block"])).zfill(5)
                lot = str(int(row["lot"])).zfill(4)
                bbl = f"{boro}{block}{lot}"
            except Exception:
                continue
            hpd_open[bbl][cls.lower()] += int(row["cnt"])
        print(f"  class {cls}: {len(rows):,} BBLs aggregated", file=sys.stderr)
    print(f"  shed-BBLs with open HPD B/C violations: {sum(1 for b in active_bbls if hpd_open.get(b,{}).get('b',0)+hpd_open.get(b,{}).get('c',0) > 0):,}", file=sys.stderr)

    # 4a-bis. HPD Alternative Enforcement Program list (distressed-building flag).
    print("Fetching HPD AEP list...", file=sys.stderr)
    aep_bins = set()
    aep_bbls = set()
    try:
        aep = fetch_all("hcir-3275", "1=1", select="*", page=20000)
        for r in aep:
            if r.get("bin"): aep_bins.add(str(r["bin"]))
            if r.get("bbl"): aep_bbls.add(str(r["bbl"]).split(".")[0])
        print(f"  AEP total: {len(aep):,} (bins: {len(aep_bins)}, bbls: {len(aep_bbls)})", file=sys.stderr)
    except Exception as e:
        print(f"  AEP fetch failed ({e})", file=sys.stderr)
        aep = []

    # 4b. FISP (Local Law 11) filings for the shed BINs.
    print(f"Fetching FISP filings for {len(active_bins):,} BINs...", file=sys.stderr)
    fisp_by_bin = {}
    bin_list = sorted(active_bins)
    for i in range(0, len(bin_list), CHUNK):
        bins = bin_list[i : i + CHUNK]
        in_clause = ",".join(f"'{b}'" for b in bins)
        where = f"bin in({in_clause})"
        select = "bin,cycle,current_status,filing_status,sequence_no,late_filing_amt,failure_to_file_amt,failure_to_correct_amt"
        url = (
            "https://data.cityofnewyork.us/resource/xubg-57si.json"
            f"?$select={quote(select)}&$where={quote(where)}&$limit=50000"
        )
        req = Request(url, headers={"User-Agent": UA})
        with urlopen(req, timeout=120) as r:
            chunk = json.loads(r.read())
        for row in chunk:
            b = str(row.get("bin"))
            cycle = int(row.get("cycle") or 0)
            seq = int(row.get("sequence_no") or 0)
            cur = fisp_by_bin.get(b)
            # Keep the highest-cycle, then highest-sequence_no record per BIN.
            if cur is None or (cycle, seq) > (int(cur.get("cycle") or 0), int(cur.get("sequence_no") or 0)):
                fisp_by_bin[b] = row
        if (i // CHUNK) % 5 == 0:
            print(f"  FISP progress: {i+len(bins):,}/{len(bin_list):,}", file=sys.stderr)
    print(f"  shed-BINs with FISP record: {len(fisp_by_bin):,}", file=sys.stderr)

    # 5. Recent construction job filings (for zombie detection) — DOB NOW Job Filings.
    cutoff = (TODAY - timedelta(days=ZOMBIE_DAYS)).isoformat()
    print(f"Fetching recent DOB NOW job filings since {cutoff}...", file=sys.stderr)
    # We want filings where actual non-shed work is in progress. Each filing has
    # a set of boolean work-type flags; if any non-shed flag is true, count it.
    # Filings have boolean-ish fields stored as "0"/"1" strings. shed='0' means
    # the filing involves work other than a sidewalk shed.
    where_jobs = (
        f"current_status_date >= '{cutoff}T00:00:00' AND bin IS NOT NULL AND shed='0'"
    )
    try:
        jobs = fetch_all(
            "w9ak-ipjd", where_jobs,
            select="bin,job_filing_number,current_status_date,filing_status",
        )
    except Exception as e:
        print(f"  job filings fetch failed ({e}); zombie detection skipped", file=sys.stderr)
        jobs = []
    bins_with_recent_work = {str(r.get("bin")) for r in jobs if r.get("bin")}
    print(f"  BINs with recent non-shed work: {len(bins_with_recent_work):,}", file=sys.stderr)

    # 6. Build per-BIN active shed records (one entry per BIN, picking the
    #    most-recently-issued permit for current attribution).
    by_bin = {}
    for r in now_active:
        bin_ = str(r.get("bin") or "")
        if not bin_ or bin_ == "None":
            continue
        existing = by_bin.get(bin_)
        if existing is None or parse_dt(r.get("issued_date")) > parse_dt(existing.get("issued_date") or "1900-01-01"):
            by_bin[bin_] = r

    sheds = []
    today_str = TODAY_ISO
    for bin_, r in by_bin.items():
        run_start, run_end = latest_run_start(history.get(bin_, []))
        # If our run-start is later than the active permit's issued, fall back.
        active_issued = parse_dt(r.get("issued_date"))
        if run_start is None or (active_issued and active_issued < run_start):
            run_start = active_issued
        days_up = (TODAY - run_start).days if run_start else 0
        bbl = str(r.get("bbl") or "")
        plut = pluto.get(bbl, {})
        pluto_owner = (plut.get("ownername") or "").strip().upper()
        permit_owner = (r.get("owner_business_name") or r.get("owner_name") or "").strip().upper()
        owner = pluto_owner or permit_owner
        owner_src = "pluto" if pluto_owner else "permit"
        try:
            lat = float(r.get("latitude")) if r.get("latitude") else None
            lon = float(r.get("longitude")) if r.get("longitude") else None
        except (TypeError, ValueError):
            lat = lon = None
        if lat is None or lon is None:
            continue
        fisp = fisp_by_bin.get(bin_, {})
        fisp_status = (fisp.get("current_status") or "").upper() or None
        fisp_cycle = fisp.get("cycle") or None
        hpd = hpd_open.get(bbl, {"b": 0, "c": 0})
        hpd_b = hpd.get("b", 0)
        hpd_c = hpd.get("c", 0)
        is_aep = bin_ in aep_bins or bbl in aep_bbls
        # Distress score: combines HPD severity + AEP. C is hazardous (weight 3),
        # B is significant (weight 1), AEP adds 10. Capped at 30 for display.
        distress = min(hpd_c * 3 + hpd_b + (10 if is_aep else 0), 30)
        # A "true" zombie: long-standing, no recent construction work, AND no
        # documented unsafe-facade filing that would explain the shed.
        is_zombie = (
            days_up >= ZOMBIE_DAYS
            and bin_ not in bins_with_recent_work
            and fisp_status not in ("UNSAFE",)
        )
        fisp_justified = fisp_status == "UNSAFE"
        sheds.append({
            "bin": bin_,
            "bbl": bbl,
            "addr": f"{(r.get('house_no') or '').strip()} {(r.get('street_name') or '').strip()}".strip().title(),
            "boro": (r.get("borough") or "").title(),
            "zip": r.get("zip_code") or "",
            "cd": r.get("community_board") or "",
            "cdist": r.get("council_district") or "",
            "nta": r.get("nta") or "",
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "first": run_start.isoformat() if run_start else None,
            "exp": (parse_dt(r.get("expired_date")).isoformat() if parse_dt(r.get("expired_date")) else None),
            "days": days_up,
            "owner": owner or "—",
            "osrc": owner_src,
            "yrbuilt": plut.get("yearbuilt") or "",
            "units": plut.get("unitsres") or "",
            "bclass": plut.get("bldgclass") or "",
            "reason": r.get("filing_reason") or "",
            "job": r.get("job_filing_number") or r.get("work_permit") or "",
            "appl": (r.get("applicant_business_name") or "").strip(),
            "block": str(r.get("block") or ""),
            "lot": str(r.get("lot") or ""),
            "zombie": is_zombie,
            "fisp": fisp_status,
            "fisp_cycle": fisp_cycle,
            "fisp_just": fisp_justified,
            "hpd_b": hpd_b,
            "hpd_c": hpd_c,
            "aep": is_aep,
            "distress": distress,
        })

    sheds.sort(key=lambda s: -s["days"])
    print(f"Final shed records: {len(sheds):,}", file=sys.stderr)
    print(f"Zombie sheds: {sum(1 for s in sheds if s['zombie']):,}", file=sys.stderr)

    # 7. (Owner aggregation dropped — keeping PLUTO ownername per shed for popup
    #     context only; not ranking owners.)

    # 7b. 311 scaffold/shed-safety complaints (past 12 months).
    print("Fetching 311 scaffold-safety complaints (past 12 months)...", file=sys.stderr)
    cutoff_311 = (TODAY - timedelta(days=365)).isoformat()
    where_311 = (
        f"complaint_type='Scaffold Safety' AND created_date >= '{cutoff_311}T00:00:00' "
        "AND latitude IS NOT NULL"
    )
    try:
        complaints_raw = fetch_all(
            "erm2-nwe9", where_311,
            select=("unique_key,created_date,closed_date,status,descriptor,"
                    "incident_address,borough,latitude,longitude,bbl,resolution_description"),
        )
    except Exception as e:
        print(f"  311 fetch failed ({e})", file=sys.stderr)
        complaints_raw = []
    complaints = []
    for c in complaints_raw:
        try:
            lat = float(c.get("latitude")); lon = float(c.get("longitude"))
        except (TypeError, ValueError):
            continue
        complaints.append({
            "id": c.get("unique_key"),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "addr": (c.get("incident_address") or "").title(),
            "boro": (c.get("borough") or "").title(),
            "desc": c.get("descriptor") or "",
            "created": (c.get("created_date") or "")[:10],
            "closed": (c.get("closed_date") or "")[:10],
            "status": c.get("status") or "",
        })
    print(f"  311 complaints: {len(complaints):,}", file=sys.stderr)

    # Group complaints by ~address to flag chronic sites. Round lat/lon to ~10m
    # so adjacent reports cluster, then count.
    loc_counts = defaultdict(list)
    for c in complaints:
        key = (round(c["lat"], 4), round(c["lon"], 4))
        loc_counts[key].append(c)
    for c in complaints:
        key = (round(c["lat"], 4), round(c["lon"], 4))
        c["loc_count"] = len(loc_counts[key])
    chronic = []
    for (lat, lon), items in loc_counts.items():
        if len(items) >= 2:
            items_sorted = sorted(items, key=lambda x: x["created"], reverse=True)
            chronic.append({
                "lat": lat, "lon": lon,
                "addr": items_sorted[0]["addr"],
                "boro": items_sorted[0]["boro"],
                "count": len(items),
                "last_filed": items_sorted[0]["created"],
                "first_filed": items_sorted[-1]["created"],
            })
    chronic.sort(key=lambda x: -x["count"])
    print(f"  chronic complaint sites (>=2 complaints): {len(chronic):,}", file=sys.stderr)

    # 8. Community-district aggregation (for choropleth + equity).
    cd_agg = defaultdict(lambda: {"sheds": 0, "shed_days": 0, "zombies": 0})
    for s in sheds:
        cd = s["cd"]
        if not cd:
            continue
        cd_agg[cd]["sheds"] += 1
        cd_agg[cd]["shed_days"] += s["days"]
        if s["zombie"]:
            cd_agg[cd]["zombies"] += 1
    cd_rows = [{"cd": k, **v} for k, v in cd_agg.items()]
    cd_rows.sort(key=lambda x: -x["shed_days"])

    # 8b. Council-district scorecards.
    cdist_agg = defaultdict(lambda: {
        "sheds": 0, "shed_days": 0, "zombies": 0,
        "over_1y": 0, "over_5y": 0,
        "unsafe": 0, "distressed": 0,
        "complaints": 0, "days_list": [],
    })
    for s in sheds:
        cd = s.get("cdist") or ""
        if not cd:
            continue
        c = cdist_agg[cd]
        c["sheds"] += 1
        c["shed_days"] += s["days"]
        c["days_list"].append(s["days"])
        if s["days"] >= 365: c["over_1y"] += 1
        if s["days"] >= 1825: c["over_5y"] += 1
        if s["zombie"]: c["zombies"] += 1
        if s["fisp"] == "UNSAFE": c["unsafe"] += 1
        if (s.get("distress") or 0) >= 10: c["distressed"] += 1
        if s.get("complaints", 0): c["complaints"] += s["complaints"]
    cdist_rows = []
    for cd, c in cdist_agg.items():
        ds = sorted(c["days_list"])
        median = ds[len(ds) // 2] if ds else 0
        # Worst shed in the district (longest-standing).
        worst = max((s for s in sheds if str(s.get("cdist") or "") == cd), key=lambda s: s["days"], default=None)
        cdist_rows.append({
            "cdist": cd,
            "sheds": c["sheds"],
            "shed_days": c["shed_days"],
            "median_days": median,
            "over_1y": c["over_1y"],
            "over_5y": c["over_5y"],
            "zombies": c["zombies"],
            "unsafe": c["unsafe"],
            "distressed": c["distressed"],
            "complaints": c["complaints"],
            "worst_addr": (worst["addr"] + ", " + worst["boro"]) if worst else "",
            "worst_days": worst["days"] if worst else 0,
            "worst_bin": worst["bin"] if worst else "",
        })
    cdist_rows.sort(key=lambda x: -x["shed_days"])

    # 9. Summary stats for the embed header.
    summary = {
        "as_of": today_str,
        "total_active": len(sheds),
        "longest_days": max((s["days"] for s in sheds), default=0),
        "over_5y": sum(1 for s in sheds if s["days"] >= 365 * 5),
        "over_3y": sum(1 for s in sheds if s["days"] >= 365 * 3),
        "over_1y": sum(1 for s in sheds if s["days"] >= 365),
        "zombies": sum(1 for s in sheds if s["zombie"]),
        "median_days": sorted(s["days"] for s in sheds)[len(sheds) // 2] if sheds else 0,
        "complaints_12mo": len(complaints),
        "chronic_sites": len(chronic),
        "fisp_unsafe": sum(1 for s in sheds if s["fisp"] == "UNSAFE"),
        "fisp_swarmp": sum(1 for s in sheds if s["fisp"] == "SWARMP"),
        "fisp_safe": sum(1 for s in sheds if s["fisp"] == "SAFE"),
        "fisp_no_filing": sum(1 for s in sheds if not s["fisp"]),
        "with_open_hpd": sum(1 for s in sheds if (s.get("hpd_b",0)+s.get("hpd_c",0)) > 0),
        "with_open_class_c": sum(1 for s in sheds if s.get("hpd_c",0) > 0),
        "in_aep": sum(1 for s in sheds if s.get("aep")),
        "high_distress": sum(1 for s in sheds if s.get("distress",0) >= 10),
        "over_10y": sum(1 for s in sheds if s["days"] >= 365 * 10),
    }

    (DATA / "sheds.json").write_text(json.dumps(sheds, separators=(",", ":")))
    (DATA / "cd.json").write_text(json.dumps(cd_rows, separators=(",", ":")))
    (DATA / "cdistricts.json").write_text(json.dumps(cdist_rows, separators=(",", ":")))
    (DATA / "complaints311.json").write_text(json.dumps(complaints, separators=(",", ":")))
    (DATA / "chronic311.json").write_text(json.dumps(chronic, separators=(",", ":")))

    # 9. Monthly active-shed trend, 2010-01-01 to today.
    print("Computing monthly active-shed history (2010 onward)...", file=sys.stderr)
    runs_per_bin = []
    for bin_, dates in history.items():
        items = sorted([(i, e) for i, e in dates if i and e], key=lambda x: x[0])
        if not items:
            continue
        cur_s, cur_e = items[0]
        for i, e in items[1:]:
            if i <= cur_e + RUN_GAP_BRIDGE:
                if e > cur_e:
                    cur_e = e
            else:
                runs_per_bin.append((cur_s, cur_e))
                cur_s, cur_e = i, e
        runs_per_bin.append((cur_s, cur_e))
    months = []
    y, m = 2010, 1
    while (y, m) <= (TODAY.year, TODAY.month):
        d = date(y, m, 1)
        active_runs = [r for r in runs_per_bin if r[0] <= d <= r[1]]
        count = len(active_runs)
        if count:
            durations = sorted((d - r[0]).days for r in active_runs)
            median = durations[len(durations) // 2]
        else:
            median = 0
        months.append({"m": d.isoformat()[:7], "n": count, "med": median})
        m += 1
        if m > 12: m = 1; y += 1
    (DATA / "trend.json").write_text(json.dumps(months, separators=(",", ":")))
    print(f"  trend points: {len(months):,} (latest: {months[-1] if months else 'none'})", file=sys.stderr)
    (DATA / "summary.json").write_text(json.dumps(summary, indent=2))
    print(f"Wrote {DATA}/", file=sys.stderr)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
