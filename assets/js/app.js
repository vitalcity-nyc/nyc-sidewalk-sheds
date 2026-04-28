(() => {
  'use strict';

  // Compact embed mode: hides tabs/filters/presets, shows just stats + map.
  const _params = new URLSearchParams(location.search);
  const COMPACT = _params.get('mode') === 'compact';
  if (COMPACT) {
    document.body.classList.add('compact');
    const cta = document.getElementById('btn-open-full');
    if (cta) {
      cta.hidden = false;
      cta.href = location.pathname; // strips ?mode=compact
    }
  }

  const COLORS = [
    { max: 90,    fill: '#57aa4a' },
    { max: 365,   fill: '#dde44c' },
    { max: 1095,  fill: '#ff7c53' },
    { max: 1825,  fill: '#e7466d' },
    { max: 99999, fill: '#d2232a' },
  ];
  const colorFor = (d) => COLORS.find(c => d <= c.max).fill;
  const radiusForDays = (d) => Math.max(2, Math.sqrt(Math.max(d, 1)) / 7);
  const fmt = (n) => n.toLocaleString('en-US');
  const titleCase = (s) => s.replace(/\w\S*/g, t => t[0].toUpperCase() + t.slice(1).toLowerCase());

  const state = { sheds: [], cd: [], complaints: [], chronic: [], filtered: [], view: 'map', layer: null, complaintLayer: null, buckets: new Set(), fisp: new Set(), flags: new Set() };

  function bucketOf(days) {
    if (days < 90) return '0-90';
    if (days < 365) return '90-365';
    if (days < 1095) return '365-1095';
    if (days < 1825) return '1095-1825';
    return '1825-99999';
  }

  // ── load data ────────────────────────────────────────────────────────────
  Promise.all([
    fetch('data/sheds.json').then(r => r.json()),
    fetch('data/summary.json').then(r => r.json()),
    fetch('data/cd.json').then(r => r.json()),
    fetch('data/complaints311.json').then(r => r.json()).catch(() => []),
    fetch('data/chronic311.json').then(r => r.json()).catch(() => []),
    fetch('data/trend.json').then(r => r.json()).catch(() => []),
    fetch('data/cdistricts.json').then(r => r.json()).catch(() => []),
  ]).then(([sheds, summary, cd, complaints, chronic, trend, cdistricts]) => {
    state.cdistricts = cdistricts;
    state.summary = summary;
    state.trend = trend;
    state.sheds = sheds;
    state.cd = cd;
    state.complaints = complaints;
    state.chronic = chronic;
    // Annotate each shed with nearby 311 count (rounded-coord match).
    const cKey = c => `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
    const cIndex = {};
    complaints.forEach(c => { const k = cKey(c); cIndex[k] = (cIndex[k] || 0) + 1; });
    state.sheds.forEach(s => {
      const k = `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
      s.complaints = cIndex[k] || 0;
    });
    attachSort('zombie-table', null, renderZombieTable);
    attachSort('cd-table', null, renderCDTable);
    attachSort('council-table', null, renderCouncilTable);
    populateCDDropdown();
    populateNTADatalist();
    renderFindings();
    renderTrend();
    renderCouncilTable();
    paintSummary(summary);
    initMap();
    renderCDTable();
    applyURLParams();
    applyFilters();
  }).catch(err => {
    document.querySelector('main').innerHTML =
      `<p style="padding:24px;color:#d2232a">Failed to load data: ${err}</p>`;
  });

  function paintSummary(s) {
    document.getElementById('s-total').textContent = fmt(s.total_active);
    document.getElementById('s-median').textContent = fmt(s.median_days);
    document.getElementById('s-1y').textContent = fmt(s.over_1y);
    document.getElementById('s-5y').textContent = fmt(s.over_5y);
    document.getElementById('s-zombie').textContent = fmt(s.zombies);
    document.getElementById('s-unsafe').textContent = fmt(s.fisp_unsafe || 0);
    document.getElementById('s-distress').textContent = fmt(s.high_distress || 0);
    document.getElementById('s-asof').textContent = s.as_of;
    const asof2 = document.getElementById('s-asof2'); if (asof2) asof2.textContent = s.as_of;
  }
  function paintFilteredStats() {
    const sel = state.filtered;
    if (!sel.length) {
      ['s-total','s-median','s-1y','s-5y','s-zombie','s-unsafe','s-distress'].forEach(id => {
        document.getElementById(id).textContent = '0';
      });
      return;
    }
    const days = sel.map(s => s.days).sort((a,b) => a-b);
    document.getElementById('s-total').textContent = fmt(sel.length);
    document.getElementById('s-median').textContent = fmt(days[Math.floor(days.length/2)]);
    document.getElementById('s-1y').textContent = fmt(sel.filter(s => s.days >= 365).length);
    document.getElementById('s-5y').textContent = fmt(sel.filter(s => s.days >= 1825).length);
    document.getElementById('s-zombie').textContent = fmt(sel.filter(s => s.zombie).length);
    document.getElementById('s-unsafe').textContent = fmt(sel.filter(s => s.fisp === 'UNSAFE').length);
    document.getElementById('s-distress').textContent = fmt(sel.filter(s => (s.distress || 0) >= 10).length);
  }
  function isFiltered() {
    const f = getFilters();
    return state.buckets.size || state.fisp.size || state.flags.size
      || f.boro || f.zombie || f.q || f.cd || f.nta || state._cdist;
  }

  function passesFlags(s) {
    if (!state.flags.size) return true;
    if (state.flags.has('distress') && (s.distress || 0) < 10) return false;
    if (state.flags.has('aep') && !s.aep) return false;
    return true;
  }

  const FISP_KEY = (s) => s.fisp || 'NONE';
  const FISP_LABEL = { UNSAFE: 'Unsafe', SWARMP: 'SWARMP', SAFE: 'Safe', NONE: 'No filing', 'NO REPORT FILED': 'No report filed' };
  const FISP_COLOR = { UNSAFE: '#d2232a', SWARMP: '#ff7c53', SAFE: '#57aa4a', NONE: '#9b9fbc', 'NO REPORT FILED': '#9b9fbc' };
  function fispBadge(s) {
    const k = FISP_KEY(s);
    const lbl = FISP_LABEL[k] || k;
    return `<span class="fisp-badge" style="background:${FISP_COLOR[k] || '#9b9fbc'}">${lbl}</span>`;
  }
  function distressCell(s) {
    const d = s.distress || 0;
    const parts = [];
    if (s.hpd_c) parts.push(`<strong style="color:#d2232a">${s.hpd_c}C</strong>`);
    if (s.hpd_b) parts.push(`<span style="color:#ff7c53">${s.hpd_b}B</span>`);
    if (s.aep) parts.push('<span class="fisp-badge" style="background:#7d1027">AEP</span>');
    if (!parts.length) return '<span class="dim">0</span>';
    return `<span class="num">${d}</span> <small style="color:#5a5a52">(${parts.join(' ')})</small>`;
  }

  // ── map ──────────────────────────────────────────────────────────────────
  let map;
  function initMap() {
    map = L.map('map', { preferCanvas: true, zoomControl: true })
      .setView([40.74, -73.97], 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);
  }

  function renderMap() {
    if (state.layer) state.layer.remove();
    const g = L.layerGroup();
    for (const s of state.filtered) {
      const m = L.circleMarker([s.lat, s.lon], {
        radius: radiusForDays(s.days),
        weight: 0.4,
        color: 'rgba(0,0,0,0.4)',
        fillColor: colorFor(s.days),
        fillOpacity: 0.7,
      });
      m.bindPopup(() => popupHTML(s), { maxWidth: 280 });
      g.addLayer(m);
    }
    g.addTo(map);
    state.layer = g;
    render311();
  }

  function render311() {
    if (state.complaintLayer) { state.complaintLayer.remove(); state.complaintLayer = null; }
    const on = document.getElementById('f-311').checked;
    const chronicOnly = document.getElementById('f-chronic').checked;
    if (!on) return;
    // Group complaints by rounded location so each pin shows total count.
    const groups = {};
    for (const c of state.complaints) {
      const k = `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
      (groups[k] = groups[k] || { lat: c.lat, lon: c.lon, items: [] }).items.push(c);
    }
    const g = L.layerGroup();
    Object.values(groups).forEach(grp => {
      if (chronicOnly && grp.items.length < 2) return;
      const n = grp.items.length;
      const radius = n === 1 ? 5 : Math.min(5 + (n - 1) * 2, 13);
      const isChronic = n >= 2;
      const m = L.circleMarker([grp.lat, grp.lon], {
        radius,
        weight: isChronic ? 2.5 : 1.5,
        color: isChronic ? '#0a4f80' : '#217ebe',
        fillColor: isChronic ? '#0a4f80' : '#217ebe',
        fillOpacity: isChronic ? 0.7 : 0.5,
      });
      const items = [...grp.items].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
      const head = items[0];
      m.bindPopup(`
        <div class="popup-addr">${head.addr || '311 complaint'}</div>
        <div class="popup-days" style="color:${isChronic ? '#d2232a' : '#217ebe'}">${n} 311 complaint${n>1?'s':''} (past 12 months)${isChronic ? ' · chronic site' : ''}</div>
        <div class="popup-row"><span>Most recent</span><span>${head.created || '—'} (${head.status || '—'})</span></div>
        ${items.length > 1 ? `<div class="popup-row"><span>Earliest</span><span>${items[items.length-1].created || '—'}</span></div>` : ''}
        <div class="popup-row"><span>Borough</span><span>${head.boro}</span></div>
        <div class="popup-row"><span>Descriptor</span><span style="text-align:right;max-width:170px">${head.desc}</span></div>
      `, { maxWidth: 280 });
      g.addLayer(m);
    });
    g.addTo(map);
    state.complaintLayer = g;
  }

  // Building-class translations (DOB single-letter codes -> plain English)
  const BCLASS = {
    A: 'One-family home', B: 'Two-family home', C: 'Walk-up apartments',
    D: 'Elevator apartments', E: 'Warehouse', F: 'Factory/industrial',
    G: 'Garage', H: 'Hotel', I: 'Hospital/health', J: 'Theater',
    K: 'Store with offices', L: 'Loft', M: 'Religious', N: 'Asylum/home',
    O: 'Office', P: 'Public assembly', Q: 'Outdoor recreation',
    R: 'Condo', S: 'Mixed residential/commercial', T: 'Transportation',
    U: 'Utility', V: 'Vacant land', W: 'School', Y: 'Government',
    Z: 'Misc.',
  };
  function popupHTML(s) {
    const owner = s.owner && s.owner !== '—' ? titleCase(s.owner) : 'Owner not on file';
    const yrs = (s.days / 365).toFixed(1);
    const bclassFriendly = s.bclass ? (BCLASS[s.bclass[0]] || 'Building') + ` (${s.bclass})` : '';
    const reason = s.reason ? s.reason.replace(/Permit/i, '').trim() : '';
    return `
      <div class="popup-addr">${s.addr}, ${s.boro}</div>
      <div class="popup-days">${fmt(s.days)} days under shed permit · about ${yrs} years</div>

      <div class="popup-section">Property</div>
      <div class="popup-row"><span>Property owner</span><span>${owner}</span></div>
      ${s.yrbuilt ? `<div class="popup-row"><span>Year built</span><span>${s.yrbuilt}</span></div>` : ''}
      ${bclassFriendly ? `<div class="popup-row"><span>Building type</span><span>${bclassFriendly}</span></div>` : ''}
      ${s.units ? `<div class="popup-row"><span>Residential units</span><span>${s.units}</span></div>` : ''}

      <div class="popup-section">Permit</div>
      <div class="popup-row"><span>Permit run started</span><span>${s.first || '—'}</span></div>
      <div class="popup-row"><span>Current permit expires</span><span>${s.exp || '—'}</span></div>
      ${reason ? `<div class="popup-row"><span>Latest filing</span><span>${reason}</span></div>` : ''}
      ${s.appl ? `<div class="popup-row"><span>Filed by (contractor)</span><span>${titleCase(s.appl)}</span></div>` : ''}

      <div class="popup-section">Building condition</div>
      <div class="popup-row"><span>Façade (Local Law 11)</span><span>${FISP_LABEL[FISP_KEY(s)] || FISP_KEY(s)}${s.fisp_cycle ? ` · cycle ${s.fisp_cycle}` : ''}</span></div>
      ${(s.hpd_c || s.hpd_b) ? `<div class="popup-row"><span>Open housing violations</span><span>${s.hpd_c || 0} immediately hazardous, ${s.hpd_b || 0} significant</span></div>` : ''}
      ${s.aep ? `<div class="popup-row"><span>HPD distress program</span><span>Enrolled in AEP</span></div>` : ''}
      ${s.complaints ? `<div class="popup-row"><span>311 complaints (past 12 months)</span><span><strong>${s.complaints}</strong></span></div>` : ''}

      <div class="popup-section popup-refs">Reference</div>
      ${s.job ? `<div class="popup-row"><span>DOB job number</span><span>${s.job}</span></div>` : ''}
      <div class="popup-row"><span>DOB Building ID (BIN)</span><span>${s.bin}</span></div>
      ${s.block && s.lot ? `<div class="popup-row"><span>Block / Lot</span><span>${s.block} / ${s.lot}</span></div>` : ''}

      ${s.zombie ? '<div class="popup-zombie">Zombie shed — long up, no recent work, no documented hazard</div>' : ''}
    `;
  }

  // ── filters ──────────────────────────────────────────────────────────────
  function getFilters() {
    return {
      boro: document.getElementById('f-boro').value,
      cd: document.getElementById('f-cd').value,
      nta: document.getElementById('f-nta').value.trim(),
      dur: document.getElementById('f-dur').value,
      zombie: document.getElementById('f-zombie').checked,
      q: document.getElementById('f-q').value.trim().toLowerCase(),
    };
  }

  function applyFilters() {
    if (state.timewarp) {
      // Time machine is driving the map; ignore normal filter pipeline.
      return;
    }
    const f = getFilters();
    state.filtered = state.sheds.filter(s => {
      if (f.boro && s.boro !== f.boro) return false;
      if (f.cd && s.cd !== f.cd) return false;
      if (state._cdist && String(s.cdist) !== String(state._cdist)) return false;
      if (f.nta && (s.nta || '').toLowerCase() !== f.nta.toLowerCase()) return false;
      if (state.buckets.size && !state.buckets.has(bucketOf(s.days))) return false;
      if (state.fisp.size && !state.fisp.has(FISP_KEY(s))) return false;
      if (!passesFlags(s)) return false;
      if (f.zombie && !s.zombie) return false;
      if (f.q) {
        const hay = (s.addr + ' ' + s.boro + ' ' + s.owner).toLowerCase();
        if (!hay.includes(f.q)) return false;
      }
      return true;
    });
    document.getElementById('f-count').textContent =
      `${fmt(state.filtered.length)} of ${fmt(state.sheds.length)} sheds`;
    if (isFiltered()) {
      paintFilteredStats();
      document.querySelector('.topbar').classList.add('filtered');
    } else {
      paintSummary(state.summary);
      document.querySelector('.topbar').classList.remove('filtered');
    }
    if (state.view === 'map') renderMap();
    if (state.view === 'zombies') renderZombieTable();
    if (state.view === 'neighborhoods') renderCDTable();
    if (state.view === 'council') renderCouncilTable();
    updateNowShowing();
    syncURL(f);
    // Auto-zoom for neighborhood/CD selections
    if (state._zoomToFiltered && map && state.filtered.length) {
      try {
        const b = L.latLngBounds(state.filtered.map(p => [p.lat, p.lon]));
        map.fitBounds(b, { padding: [40, 40], maxZoom: 15 });
      } catch (e) {}
      state._zoomToFiltered = false;
    }
  }

  function clearActivePreset() {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
  }
  function populateCDDropdown() {
    const sel = document.getElementById('f-cd');
    const boroFilter = document.getElementById('f-boro').value;
    const BORO_PREFIX = { Manhattan: '1', Bronx: '2', Brooklyn: '3', Queens: '4', 'Staten Island': '5' };
    const want = boroFilter ? BORO_PREFIX[boroFilter] : null;
    const cds = state.cd
      .filter(c => !want || c.cd[0] === want)
      .sort((a, b) => a.cd.localeCompare(b.cd));
    const cdLabel = (cd) => {
      const boro = ({1:'Manhattan',2:'Bronx',3:'Brooklyn',4:'Queens',5:'Staten Island'})[cd[0]] || '';
      return `${boro} CD ${parseInt(cd.slice(1), 10)}`;
    };
    const current = sel.value;
    sel.innerHTML = '<option value="">All</option>' + cds.map(c =>
      `<option value="${c.cd}">${cdLabel(c.cd)} (${fmt(c.sheds)})</option>`
    ).join('');
    if (cds.some(c => c.cd === current)) sel.value = current;
  }
  ['f-boro','f-zombie','f-q'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      clearActivePreset();
      if (id === 'f-boro') populateCDDropdown();
      applyFilters();
    });
  });
  document.getElementById('f-cd').addEventListener('change', () => {
    clearActivePreset();
    state._zoomToFiltered = true;
    applyFilters();
  });

  function populateNTADatalist() {
    const counts = {};
    for (const s of state.sheds) {
      if (!s.nta) continue;
      counts[s.nta] = (counts[s.nta] || 0) + 1;
    }
    const dl = document.getElementById('nta-list');
    dl.innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `<option value="${n}">${n} (${c} sheds)</option>`)
      .join('');
  }
  // Apply NTA on change/Enter; debounce 'input' so dropdown selections fire fast.
  let ntaTimer;
  function ntaInputHandler(srcInput, mirrorInput) {
    return (e) => {
      clearTimeout(ntaTimer);
      const val = srcInput.value.trim();
      mirrorInput.value = val;
      const known = [...document.getElementById('nta-list').options].some(o => o.value === val);
      if (!val || known) {
        ntaTimer = setTimeout(() => {
          clearActivePreset();
          state._zoomToFiltered = true;
          applyFilters();
        }, 50);
      }
    };
  }
  const fNta = document.getElementById('f-nta');
  const mapNta = document.getElementById('map-nta');
  fNta.addEventListener('input', ntaInputHandler(fNta, mapNta));
  mapNta.addEventListener('input', ntaInputHandler(mapNta, fNta));
  document.getElementById('f-reset').addEventListener('click', () => {
    document.getElementById('f-boro').value = '';
    document.getElementById('f-zombie').checked = false;
    document.getElementById('f-q').value = '';
    document.getElementById('f-311').checked = false;
    document.getElementById('f-chronic').checked = false;
    state.buckets.clear();
    state.fisp.clear();
    state.flags.clear();
    syncLegend();
    render311();
    applyFilters();
  });

  // ── legend buttons ───────────────────────────────────────────────────────
  function syncLegend() {
    const root = document.getElementById('legend');
    const anyActive = state.buckets.size > 0
      || document.getElementById('f-311').checked
      || document.getElementById('f-chronic').checked;
    root.classList.toggle('has-active', anyActive);
    root.querySelectorAll('.leg-btn[data-bucket]').forEach(b => {
      b.classList.toggle('active', state.buckets.has(b.dataset.bucket));
    });
    root.querySelectorAll('.leg-btn[data-fisp]').forEach(b => {
      b.classList.toggle('active', state.fisp.has(b.dataset.fisp));
    });
    root.querySelectorAll('.leg-btn[data-flag]').forEach(b => {
      b.classList.toggle('active', state.flags.has(b.dataset.flag));
    });
    root.classList.toggle('has-active',
      state.buckets.size > 0 || state.fisp.size > 0 || state.flags.size > 0
      || document.getElementById('f-311').checked
      || document.getElementById('f-chronic').checked);
    root.querySelector('.leg-btn[data-toggle="311"]').classList.toggle('active',
      document.getElementById('f-311').checked);
    root.querySelector('.leg-btn[data-toggle="chronic"]').classList.toggle('active',
      document.getElementById('f-chronic').checked);
  }
  // ── presets ──────────────────────────────────────────────────────────────
  const PRESETS = {
    'zombies': {
      label: 'Why is this still up?',
      desc: '<strong>Zombie sheds.</strong> Up over a year, no recent non-shed work, and no documented unsafe-façade filing — the strongest signal of a shed sitting there for no defensible reason.',
      apply: () => {
        clearAllFilters();
        document.getElementById('f-zombie').checked = true;
      },
    },
    'safe-shedded': {
      label: 'Safe but still shedded',
      desc: '<strong>Sheds at buildings the city has rated SAFE</strong> in their most recent Local Law 11 façade filing. The façade is certified fine — yet the sidewalk shed is still up.',
      apply: () => { clearAllFilters(); state.fisp.add('SAFE'); },
    },
    'distressed-long': {
      label: 'Distressed buildings, sheds >5 years',
      desc: '<strong>Long-standing sheds at distressed buildings.</strong> Five-plus years of permit coverage at buildings with substantial open HPD violations or AEP enrollment. The shed is the visible symptom of a deeper problem.',
      apply: () => {
        clearAllFilters();
        state.flags.add('distress');
        state.buckets.add('1825-99999');
      },
    },
    'chronic': {
      label: 'Where complaints repeat',
      desc: '<strong>Chronic 311 sites.</strong> Locations with two or more scaffold-safety complaints in the past 12 months — the addresses where neighbors keep flagging the same problem.',
      apply: () => {
        clearAllFilters();
        document.getElementById('f-311').checked = true;
        document.getElementById('f-chronic').checked = true;
      },
    },
    'oldest': {
      label: 'The oldest sheds',
      desc: '<strong>Sheds with over five years of continuous permit coverage.</strong> Of these, dozens stretch past a decade. Sort the Top sheds tab by Days up to see the leaderboard.',
      apply: () => { clearAllFilters(); state.buckets.add('1825-99999'); },
    },
    'timewarp': {
      label: 'Replay 2010 → today',
      desc: '<strong>Time machine.</strong> Drag to a month and the map shows only currently-active sheds whose permit run had already started by that date. Watch how today\'s long-runners accumulated.',
      apply: () => { clearAllFilters(); enableTimeWarp(); },
    },
    'reset': {
      label: 'Clear all',
      desc: null,
      apply: () => { clearAllFilters(); disableTimeWarp(); },
    },
  };

  function clearAllFilters() {
    state.buckets.clear();
    state.fisp.clear();
    state.flags.clear();
    state._cdist = null;
    document.getElementById('f-boro').value = '';
    document.getElementById('f-cd').value = '';
    document.getElementById('f-nta').value = '';
    const mn = document.getElementById('map-nta'); if (mn) mn.value = '';
    document.getElementById('f-zombie').checked = false;
    document.getElementById('f-q').value = '';
    document.getElementById('f-311').checked = false;
    document.getElementById('f-chronic').checked = false;
  }

  function applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    p.apply();
    document.querySelectorAll('.preset').forEach(b => b.classList.toggle('active', b.dataset.preset === key && key !== 'reset'));
    syncLegend();
    render311();
    applyFilters();
    if (state.view !== 'map') switchView('map');
  }

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  function describeFilters() {
    const f = getFilters();
    const parts = [];
    if (state.buckets.size) {
      const labels = { '0-90': 'under 90 days', '90-365': '90–365 days', '365-1095': '1–3 years', '1095-1825': '3–5 years', '1825-99999': 'over 5 years' };
      parts.push(`up ${[...state.buckets].map(b => labels[b]).join(' or ')}`);
    }
    if (state.fisp.size) {
      const labels = { UNSAFE: 'documented Unsafe façade', SWARMP: 'SWARMP-rated façade (needs repair)', SAFE: 'Safe-rated façade', NONE: 'no LL11 filing on record' };
      parts.push(`with ${[...state.fisp].map(k => labels[k]).join(' or ')}`);
    }
    if (state.flags.has('distress')) parts.push('at distressed buildings (HPD/AEP)');
    if (state.flags.has('aep')) parts.push('on the HPD AEP list');
    if (f.zombie) parts.push('flagged zombie');
    if (state._cdist) {
      parts.push(`in Council District ${state._cdist}`);
    } else if (f.nta) {
      parts.push(`in ${f.nta}`);
    } else if (f.cd) {
      const boro = ({1:'Manhattan',2:'Bronx',3:'Brooklyn',4:'Queens',5:'Staten Island'})[f.cd[0]] || '';
      parts.push(`in ${boro} CD ${parseInt(f.cd.slice(1), 10)}`);
    } else if (f.boro) {
      parts.push(`in ${f.boro}`);
    }
    if (f.q) parts.push(`with addresses matching "${f.q}"`);
    return parts.join(', ');
  }

  function updateNowShowing() {
    const el = document.getElementById('now-showing');
    if (!el) return;
    const activePreset = document.querySelector('.preset.active');
    if (activePreset && activePreset.dataset.preset && PRESETS[activePreset.dataset.preset].desc) {
      const c311 = document.getElementById('f-311').checked ? ' Plus 311 scaffold-safety complaints (past 12 months) overlaid.' : '';
      el.innerHTML = PRESETS[activePreset.dataset.preset].desc + c311
        + ` <span class="ns-hint">— ${fmt(state.filtered.length)} sheds.</span>`;
      return;
    }
    const desc = describeFilters();
    if (!desc) {
      el.innerHTML = `Showing all <strong>${fmt(state.sheds.length)}</strong> active sheds. <span class="ns-hint">Click a preset above, or use the legend on the map to ask your own question.</span>`;
    } else {
      el.innerHTML = `Showing <strong>${fmt(state.filtered.length)}</strong> sheds that are ${desc}.`;
    }
  }

  document.querySelectorAll('#legend .leg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      clearActivePreset();
      if (btn.dataset.bucket) {
        const b = btn.dataset.bucket;
        if (state.buckets.has(b)) state.buckets.delete(b); else state.buckets.add(b);
        syncLegend();
        applyFilters();
      } else if (btn.dataset.fisp) {
        const k = btn.dataset.fisp;
        if (state.fisp.has(k)) state.fisp.delete(k); else state.fisp.add(k);
        syncLegend();
        applyFilters();
      } else if (btn.dataset.flag) {
        const k = btn.dataset.flag;
        if (state.flags.has(k)) state.flags.delete(k); else state.flags.add(k);
        syncLegend();
        applyFilters();
      } else if (btn.dataset.toggle === '311') {
        const cb = document.getElementById('f-311');
        cb.checked = !cb.checked;
        if (!cb.checked) document.getElementById('f-chronic').checked = false;
        syncLegend();
        render311();
      } else if (btn.dataset.toggle === 'chronic') {
        const cb = document.getElementById('f-chronic');
        cb.checked = !cb.checked;
        if (cb.checked) document.getElementById('f-311').checked = true;
        syncLegend();
        render311();
      }
    });
  });

  // ── tabs ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchView(t.dataset.view));
  });

  function switchView(v) {
    state.view = v;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
    document.querySelectorAll('.view').forEach(e => e.classList.remove('active'));
    document.getElementById('view-' + v).classList.add('active');
    if (v === 'map' && map) {
      setTimeout(() => map.invalidateSize(), 50);
      renderMap();
    }
    if (v === 'zombies') renderZombieTable();
    if (v === 'neighborhoods') renderCDTable();
    if (v === 'council') renderCouncilTable();
    syncURL(getFilters());
  }

  // ── generic sortable table ───────────────────────────────────────────────
  function applySort(rows, sortKey, type, dir) {
    const mul = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (type === 'num') {
        av = Number(av) || 0; bv = Number(bv) || 0;
        return (av - bv) * mul;
      }
      av = (av || '').toString().toLowerCase();
      bv = (bv || '').toString().toLowerCase();
      return av < bv ? -1 * mul : av > bv ? 1 * mul : 0;
    });
  }

  function attachSort(tableId, getRows, render) {
    const table = document.getElementById(tableId);
    table.querySelectorAll('thead th').forEach(th => {
      th.addEventListener('click', () => {
        const cur = th.classList.contains('sorted-desc') ? 'desc'
                  : th.classList.contains('sorted-asc') ? 'asc' : null;
        table.querySelectorAll('thead th').forEach(t => t.classList.remove('sorted-asc','sorted-desc'));
        const next = cur === 'desc' ? 'asc' : 'desc';
        th.classList.add('sorted-' + next);
        render();
      });
    });
  }

  function tableSortState(tableId) {
    const th = document.querySelector(`#${tableId} thead th.sorted-asc, #${tableId} thead th.sorted-desc`);
    if (!th) return null;
    return {
      key: th.dataset.key,
      type: th.dataset.type,
      dir: th.classList.contains('sorted-asc') ? 'asc' : 'desc',
    };
  }

  // ── top-sheds table ──────────────────────────────────────────────────────
  function renderZombieTable() {
    // Apply the same filters as the map so users see a consistent slice.
    const f = getFilters();
    let pool = state.sheds.filter(s => {
      if (f.boro && s.boro !== f.boro) return false;
      if (f.zombie && !s.zombie) return false;
      if (f.q) {
        const hay = (s.addr + ' ' + s.boro + ' ' + s.owner).toLowerCase();
        if (!hay.includes(f.q)) return false;
      }
      if (state.buckets.size && !state.buckets.has(bucketOf(s.days))) return false;
      if (state.fisp.size && !state.fisp.has(FISP_KEY(s))) return false;
      if (!passesFlags(s)) return false;
      return true;
    });
    const sort = tableSortState('zombie-table') || { key: 'days', type: 'num', dir: 'desc' };
    pool = applySort(pool, sort.key, sort.type, sort.dir).slice(0, 200);
    const tbody = document.querySelector('#zombie-table tbody');
    tbody.innerHTML = pool.map(s => `
      <tr data-bin="${s.bin}">
        <td class="num">${fmt(s.days)}</td>
        <td>${s.addr}</td>
        <td class="dim">${s.boro}</td>
        <td>${s.owner === '—' ? '<span class="dim">—</span>' : titleCase(s.owner)}</td>
        <td class="dim">${s.yrbuilt || '—'}</td>
        <td>${s.zombie ? '<span class="zombie-badge">zombie</span>' : '<span class="dim">—</span>'}</td>
        <td>${fispBadge(s)}</td>
        <td class="num">${distressCell(s)}</td>
        <td class="num">${s.complaints ? `<strong>${s.complaints}</strong>` : '<span class="dim">0</span>'}</td>
      </tr>
    `).join('');
    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const bin = tr.dataset.bin;
        const s = state.sheds.find(x => x.bin === bin);
        if (!s) return;
        switchView('map');
        setTimeout(() => {
          map.setView([s.lat, s.lon], 17);
          L.popup({ maxWidth: 280 })
            .setLatLng([s.lat, s.lon])
            .setContent(popupHTML(s))
            .openOn(map);
        }, 100);
      });
    });
  }

  // ── findings ─────────────────────────────────────────────────────────────
  function renderFindings() {
    const s = state.summary || {};
    const sheds = state.sheds;
    const longest = sheds[0] || {};
    const findings = [];

    // 1. Trend / over-10-year headline.
    const trend = state.trend || [];
    findings.push({
      kind: 'severe',
      num: fmt(s.over_10y || 0),
      head: 'Buildings with continuous shed-permit coverage over 10 years',
      body: `These buildings have had a sidewalk-shed permit on file with no gap longer than 30 days for more than a decade. The single longest run is at <strong>${longest.addr}</strong>, ${longest.boro}, since <strong>${longest.first}</strong> (${(longest.days / 365).toFixed(1)} years). Whether a single physical structure has stood the entire time is not certified by the data — but the building has been under shed nearly without interruption.`,
      cta: 'Filter map to over-5-years →',
      action: () => { state.buckets.add('1825-99999'); switchView('map'); syncLegend(); applyFilters(); },
    });

    // 1b. Citywide trend, plain numbers.
    const m2010 = (trend.find(t => t.m === '2010-07') || {}).n;
    const m2020peak = trend.reduce((max, t) => t.n > max.n ? t : max, { n: 0 });
    const now = trend.length ? trend[trend.length - 1] : null;
    if (m2010 && now) {
      findings.push({
        kind: 'context',
        num: `${fmt(now.n)}`,
        head: 'Active sheds today',
        body: `Up from about <strong>${fmt(m2010)}</strong> a decade and a half ago. Citywide totals peaked around <strong>${fmt(m2020peak.n)}</strong> in ${m2020peak.m} and have come off that peak modestly. Median duration has drifted from roughly 250 days in the early 2010s to <strong>${now.med}</strong> days today.`,
        cta: 'See trend →',
        action: () => switchView('trend'),
      });
    }

    // 2. Unsafe-façade share
    findings.push({
      kind: 'context',
      num: `${fmt(s.fisp_unsafe || 0)}`,
      head: 'Sheds tied to a documented unsafe-façade filing',
      body: `Roughly <strong>${Math.round(100 * (s.fisp_unsafe || 0) / (s.total_active || 1))}%</strong> of active sheds are at buildings with an Unsafe filing under Local Law 11. Those sheds are required by law and are the easiest to explain.`,
      cta: 'Filter map to Unsafe →',
      action: () => { state.fisp.add('UNSAFE'); switchView('map'); syncLegend(); applyFilters(); },
    });

    // 3. Safe-but-shedded
    findings.push({
      kind: 'severe',
      num: fmt(s.fisp_safe || 0),
      head: 'Sheds at buildings the city has rated Safe',
      body: `These buildings filed a façade-compliance report saying the façade is <strong>safe</strong> — yet the sidewalk shed is still up. A subset deserves direct scrutiny.`,
      cta: 'Filter map →',
      action: () => { state.fisp.add('SAFE'); switchView('map'); syncLegend(); applyFilters(); },
    });

    // 4. Zombies (now FISP-aware)
    findings.push({
      kind: 'severe',
      num: fmt(s.zombies || 0),
      head: 'Zombie sheds: long-up, no work, no documented hazard',
      body: `Sheds up over a year, with no recent non-shed construction filed at the building, and no Unsafe FISP filing. Strongest signal of a shed that's just sitting there.`,
      cta: 'Filter map →',
      action: () => { document.getElementById('f-zombie').checked = true; switchView('map'); syncLegend(); applyFilters(); },
    });

    // 5. Open class-C violations
    findings.push({
      kind: 'severe',
      num: fmt(s.with_open_class_c || 0),
      head: 'Sheds at buildings with hazardous housing violations',
      body: `<strong>${Math.round(100 * (s.with_open_class_c || 0) / (s.total_active || 1))}%</strong> of shed-bearing buildings have at least one open Class C (immediately hazardous) HPD violation. The shed is often the most visible symptom of a deeper problem.`,
      cta: 'Filter map to distressed →',
      action: () => { state.flags.add('distress'); switchView('map'); syncLegend(); applyFilters(); },
    });

    // 6. AEP buildings
    if (s.in_aep) findings.push({
      kind: 'context',
      num: fmt(s.in_aep),
      head: 'Sheds at HPD AEP-enrolled buildings',
      body: `These buildings are formally enrolled in HPD's Alternative Enforcement Program — the city's official list of severely distressed properties. Each shed there is a public-housing-quality emergency in slow motion.`,
      cta: 'Filter map →',
      action: () => { state.flags.add('aep'); switchView('map'); syncLegend(); applyFilters(); },
    });

    // 7. Longest standing
    if (longest.bin) findings.push({
      kind: '',
      num: `${(longest.days/365).toFixed(1)} yr`,
      head: 'Longest-running shed-permit coverage',
      body: `<strong>${longest.addr}, ${longest.boro}</strong> has had an unbroken run of shed permits (gaps ≤30 days) since <strong>${longest.first}</strong>. Owner per PLUTO: ${titleCase(longest.owner || 'unknown')}. Façade status: ${FISP_LABEL[FISP_KEY(longest)] || 'no filing'}.`,
      cta: 'Show on map →',
      action: () => {
        switchView('map');
        setTimeout(() => {
          map.setView([longest.lat, longest.lon], 17);
          L.popup({ maxWidth: 280 }).setLatLng([longest.lat, longest.lon]).setContent(popupHTML(longest)).openOn(map);
        }, 200);
      },
    });

    // 8. Concentration
    const cdTop = state.cd[0];
    if (cdTop) findings.push({
      kind: 'context',
      num: fmt(cdTop.sheds),
      head: 'Most shed-burdened community district',
      body: `The single CD with the most active sheds. Top three districts together hold roughly <strong>${Math.round(100 * (state.cd.slice(0,3).reduce((a,c)=>a+c.sheds,0)) / (s.total_active || 1))}%</strong> of citywide sheds.`,
      cta: 'See ranking →',
      action: () => switchView('neighborhoods'),
    });

    // 9. Chronic 311 sites
    if (s.chronic_sites) findings.push({
      kind: '',
      num: fmt(s.chronic_sites),
      head: 'Chronic 311 complaint sites',
      body: `Locations with two or more 311 scaffold-safety complaints in the past 12 months. Out of <strong>${fmt(s.complaints_12mo || 0)}</strong> total complaints — most addresses get only one.`,
      cta: 'Filter map →',
      action: () => {
        document.getElementById('f-311').checked = true;
        document.getElementById('f-chronic').checked = true;
        switchView('map'); syncLegend(); render311();
      },
    });

    const grid = document.getElementById('findings-grid');
    grid.innerHTML = findings.map((f, i) => `
      <div class="finding ${f.kind}" data-i="${i}">
        <div class="finding-num">${f.num}</div>
        <div class="finding-head">${f.head}</div>
        <div class="finding-body">${f.body}</div>
        <div class="finding-cta">${f.cta}</div>
      </div>
    `).join('');
    grid.querySelectorAll('.finding').forEach((el, i) => {
      el.addEventListener('click', () => findings[i].action());
    });
  }

  // ── trend charts ─────────────────────────────────────────────────────────
  function renderTrend() {
    const trend = (state.trend || []).filter(t => t.m >= '2018-06');
    if (!trend.length) return;
    document.getElementById('t-now').textContent = fmt(trend[trend.length - 1].n);
    document.getElementById('t-med').textContent = fmt(trend[trend.length - 1].med) + ' days';
    // Year-ago comparisons.
    if (trend.length >= 12) {
      const yago = trend[trend.length - 13];
      const last = trend[trend.length - 1];
      const dCount = last.n - yago.n;
      const dMed = last.med - yago.med;
      document.getElementById('t-delta-count').className = 'trend-delta ' + (dCount > 0 ? 'up' : 'down');
      document.getElementById('t-delta-count').textContent =
        `${dCount >= 0 ? '+' : ''}${fmt(dCount)} vs ${yago.m}`;
      document.getElementById('t-delta-med').className = 'trend-delta ' + (dMed > 0 ? 'up' : 'down');
      document.getElementById('t-delta-med').textContent =
        `${dMed >= 0 ? '+' : ''}${fmt(dMed)} days vs ${yago.m}`;
    }
    drawLine('chart-count', trend.map(t => t.n), trend, 'sheds');
    drawLine('chart-med', trend.map(t => t.med), trend, 'days');
  }

  function drawLine(id, values, labels, unit) {
    const svg = document.getElementById(id);
    const W = 800, H = 200, P = { l: 50, r: 12, t: 12, b: 28 };
    const xMax = values.length - 1;
    const yMax = Math.max(...values, 1) * 1.1;
    const xs = i => P.l + (i / xMax) * (W - P.l - P.r);
    const ys = v => H - P.b - (v / yMax) * (H - P.t - P.b);
    const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${xs(xMax).toFixed(1)},${ys(0)} L${xs(0).toFixed(1)},${ys(0)} Z`;
    // Gridlines + Y axis labels
    const yTicks = 4;
    let grid = '';
    for (let i = 0; i <= yTicks; i++) {
      const v = (yMax / yTicks) * i;
      const y = ys(v);
      grid += `<line class="g" x1="${P.l}" x2="${W - P.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />`;
      grid += `<text x="${P.l - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmt(Math.round(v))}</text>`;
    }
    // X axis: year labels
    let xAxis = '';
    labels.forEach((row, i) => {
      if (row.m.endsWith('-01')) {
        xAxis += `<text x="${xs(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${row.m.slice(0,4)}</text>`;
      }
    });
    svg.innerHTML = `
      <g class="grid"><style>.g{stroke:#e6e6e0;stroke-dasharray:2 3}</style>${grid}</g>
      <path class="area" d="${areaPath}" />
      <path class="line" d="${linePath}" />
      <g class="axis">${xAxis}</g>
    `;
  }

  // ── council district scorecard ───────────────────────────────────────────
  function renderCouncilTable() {
    const tbody = document.querySelector('#council-table tbody');
    if (!tbody || !state.cdistricts) return;
    // When filtered, narrow to council districts that contain matching sheds.
    const cdistsInScope = isFiltered()
      ? new Set(state.filtered.map(s => String(s.cdist)).filter(Boolean))
      : null;
    const data = cdistsInScope
      ? state.cdistricts.filter(c => cdistsInScope.has(String(c.cdist)))
      : state.cdistricts;
    const sort = tableSortState('council-table') || { key: 'shed_days', type: 'num', dir: 'desc' };
    const rows = applySort(data, sort.key, sort.type, sort.dir);
    tbody.innerHTML = rows.map(c => `
      <tr data-cdist="${c.cdist}">
        <td><strong>D ${c.cdist}</strong></td>
        <td class="num">${fmt(c.sheds)}</td>
        <td class="num">${fmt(c.shed_days)}</td>
        <td class="num">${fmt(c.median_days)}</td>
        <td class="num">${fmt(c.over_5y)}</td>
        <td class="num">${fmt(c.zombies)}</td>
        <td class="num">${fmt(c.unsafe)}</td>
        <td class="num">${fmt(c.distressed)}</td>
        <td class="num">${fmt(c.complaints)}</td>
        <td class="dim" style="font-size:11px">${c.worst_days ? `${(c.worst_days/365).toFixed(1)} yr<br><small>${c.worst_addr}</small>` : '—'}</td>
      </tr>
    `).join('');
    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const cdist = tr.dataset.cdist;
        clearAllFilters();
        state._cdist = cdist;
        switchView('map');
        applyFilters();
      });
    });
  }

  // ── community-district table ─────────────────────────────────────────────
  function renderCDTable() {
    const tbody = document.querySelector('#cd-table tbody');
    const cdLabel = (cd) => {
      const boro = ({1:'Manhattan',2:'Bronx',3:'Brooklyn',4:'Queens',5:'Staten Island'})[cd[0]] || '';
      return `${boro} CD ${parseInt(cd.slice(1), 10)}`;
    };
    // Restrict to CDs that actually contain sheds in the active filter set,
    // so picking a neighborhood collapses the list to relevant CDs.
    const f = getFilters();
    const cdsInScope = isFiltered()
      ? new Set(state.filtered.map(s => s.cd).filter(Boolean))
      : null;
    let enriched = state.cd.map(c => ({ ...c, avg: Math.round(c.shed_days / Math.max(c.sheds, 1)) }));
    if (cdsInScope) enriched = enriched.filter(c => cdsInScope.has(c.cd));
    const sort = tableSortState('cd-table') || { key: 'shed_days', type: 'num', dir: 'desc' };
    const rows = applySort(enriched, sort.key, sort.type, sort.dir);
    tbody.innerHTML = rows.map(c => `
      <tr data-cd="${c.cd}">
        <td>${cdLabel(c.cd)}</td>
        <td class="num">${fmt(c.sheds)}</td>
        <td class="num">${fmt(c.shed_days)}</td>
        <td class="num">${fmt(c.zombies)}</td>
        <td class="num">${fmt(c.avg)}</td>
      </tr>
    `).join('');
    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const cd = tr.dataset.cd;
        const boro = ({1:'Manhattan',2:'Bronx',3:'Brooklyn',4:'Queens',5:'Staten Island'})[cd[0]];
        document.getElementById('f-boro').value = boro || '';
        document.getElementById('f-q').value = '';
        switchView('map');
        applyFilters();
        const pts = state.filtered.filter(s => s.cd === cd);
        if (pts.length) {
          const b = L.latLngBounds(pts.map(p => [p.lat, p.lon]));
          map.fitBounds(b, { padding: [40, 40] });
        }
      });
    });
  }

  // ── URL params (for deep-linking from the article) ───────────────────────
  function applyURLParams() {
    const p = new URLSearchParams(location.search);
    if (p.get('view')) state.view = p.get('view');
    if (p.get('boro')) document.getElementById('f-boro').value = p.get('boro');
    if (p.get('buckets')) p.get('buckets').split(',').forEach(b => state.buckets.add(b));
    if (p.get('c311') === '1') document.getElementById('f-311').checked = true;
    if (p.get('chronic') === '1') document.getElementById('f-chronic').checked = true;
    syncLegend();
    if (p.get('zombie') === '1') document.getElementById('f-zombie').checked = true;
    if (p.get('q')) document.getElementById('f-q').value = p.get('q');
    if (state.view !== 'map') switchView(state.view);
  }
  function syncURL(f) {
    const p = new URLSearchParams();
    if (state.view !== 'map') p.set('view', state.view);
    if (f.boro) p.set('boro', f.boro);
    if (state.buckets.size) p.set('buckets', [...state.buckets].join(','));
    if (f.zombie) p.set('zombie', '1');
    if (f.q) p.set('q', f.q);
    if (document.getElementById('f-311').checked) p.set('c311', '1');
    if (document.getElementById('f-chronic').checked) p.set('chronic', '1');
    const url = location.pathname + (p.toString() ? '?' + p : '');
    history.replaceState(null, '', url);
    // notify parent for iframe-resize
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'embed-state', view: state.view, count: state.filtered.length }, '*');
    }
  }

  // ── address lookup + civic action ────────────────────────────────────────
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.asin(Math.sqrt(a));
  }
  const ADDR_RADIUS_M = 400;  // ¼ mile

  async function geocodeNYC(q) {
    const url = `https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(q)}&size=1`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Geocode failed');
    const j = await r.json();
    if (!j.features || !j.features.length) return null;
    const f = j.features[0];
    return {
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      label: f.properties.label,
      borough: f.properties.borough,
      bbl: f.properties.pad_bbl || '',
    };
  }

  async function runAddressLookup(query) {
    const out = document.getElementById('addr-results');
    const btn = document.getElementById('addr-go');
    btn.disabled = true; btn.textContent = 'Searching…';
    out.hidden = false;
    out.innerHTML = '<div class="addr-summary">Looking up address…</div>';
    let geo;
    try {
      geo = await geocodeNYC(query);
    } catch (e) {
      out.innerHTML = `<div class="addr-summary"><span class="err">Geocoding service is offline. Try again in a moment.</span></div>`;
      btn.disabled = false; btn.textContent = 'Find sheds near here';
      return;
    }
    if (!geo) {
      out.innerHTML = `<div class="addr-summary"><span class="err">Couldn't find that address in NYC.</span> Try the full street form, e.g. "350 5th Avenue, Manhattan."</div>`;
      btn.disabled = false; btn.textContent = 'Find sheds near here';
      return;
    }
    const enriched = state.sheds.map(s => ({
      s, dist: haversine(geo.lat, geo.lon, s.lat, s.lon),
    })).filter(x => x.dist <= ADDR_RADIUS_M)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 30);
    paintAddressResults(geo, enriched);
    btn.disabled = false; btn.textContent = 'Find sheds near here';
  }

  function paintAddressResults(geo, hits) {
    const out = document.getElementById('addr-results');
    if (!hits.length) {
      out.innerHTML = `
        <div class="addr-summary">
          Found <strong>${geo.label}</strong>. <strong>No active DOB-permitted sidewalk sheds</strong>
          within a quarter-mile radius. Lucky you.
        </div>`;
      return;
    }
    const total = hits.length;
    const longest = hits.reduce((m, x) => x.s.days > m.s.days ? x : m, hits[0]);
    const zombies = hits.filter(x => x.s.zombie).length;
    out.innerHTML = `
      <div class="addr-summary">
        Found <strong>${geo.label}</strong>. There ${total === 1 ? 'is' : 'are'}
        <strong>${total} active sidewalk shed${total > 1 ? 's' : ''}</strong>
        within a ¼-mile radius${zombies ? `, of which <strong>${zombies}</strong> ${zombies > 1 ? 'are' : 'is'} flagged zombie` : ''}.
        The longest-running is at <strong>${longest.s.addr}</strong> (${(longest.s.days/365).toFixed(1)} years).
      </div>
      ${hits.map(x => shedCardHTML(x.s, x.dist)).join('')}
    `;
    out.querySelectorAll('[data-action="map"]').forEach(b => {
      b.addEventListener('click', () => {
        const bin = b.dataset.bin;
        const s = state.sheds.find(s => s.bin === bin);
        if (!s) return;
        switchView('map');
        setTimeout(() => {
          map.setView([s.lat, s.lon], 18);
          L.popup({ maxWidth: 280 }).setLatLng([s.lat, s.lon]).setContent(popupHTML(s)).openOn(map);
        }, 100);
      });
    });
  }

  function shedCardHTML(s, dist) {
    const cls = s.zombie ? 'zombie' : (s.fisp === 'UNSAFE' ? 'unsafe' : '');
    const distFt = Math.round(dist * 3.28084);
    const fispLbl = FISP_LABEL[FISP_KEY(s)] || FISP_KEY(s);
    return `
      <div class="shed-card ${cls}">
        <div>
          <div class="shed-card-head">${s.addr}, ${s.boro}</div>
          <div class="shed-card-meta">${distFt < 528 ? distFt + ' ft away' : (distFt/5280).toFixed(2) + ' mi away'} · BIN ${s.bin}</div>
          <div class="shed-card-body">
            <div><span class="label">Time under shed</span> <strong>${(s.days/365).toFixed(1)} years</strong> (since ${s.first})</div>
            <div><span class="label">Property owner</span> ${s.owner === '—' ? 'not on file' : titleCase(s.owner)}</div>
            <div><span class="label">Façade (LL11)</span> ${fispLbl}${s.fisp_cycle ? ` · cycle ${s.fisp_cycle}` : ''}</div>
            ${(s.hpd_c || s.hpd_b) ? `<div><span class="label">Open HPD violations</span> ${s.hpd_c || 0} immediately hazardous, ${s.hpd_b || 0} significant</div>` : ''}
            ${s.complaints ? `<div><span class="label">311 complaints (12 mo)</span> <strong>${s.complaints}</strong></div>` : ''}
            ${s.zombie ? '<div><span class="label">Status</span> <strong style="color:#d2232a">Zombie shed</strong></div>' : ''}
          </div>
        </div>
        <div class="shed-card-actions">
          <button data-action="map" data-bin="${s.bin}">Show on map</button>
        </div>
      </div>
    `;
  }


  document.getElementById('addr-go').addEventListener('click', () => {
    const q = document.getElementById('addr-input').value.trim();
    if (q) runAddressLookup(q);
  });
  document.getElementById('addr-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = e.target.value.trim();
      if (q) runAddressLookup(q);
    }
  });

  // ── time machine ─────────────────────────────────────────────────────────
  let twPlayTimer = null;
  function buildTimeWarpAxis() {
    // Months from 2010-01 to current month, inclusive.
    const months = [];
    let y = 2010, m = 1;
    const today = new Date();
    while (y < today.getFullYear() || (y === today.getFullYear() && m <= today.getMonth() + 1)) {
      months.push(`${y}-${String(m).padStart(2, '0')}-01`);
      m++; if (m > 12) { m = 1; y++; }
    }
    return months;
  }
  state.twMonths = buildTimeWarpAxis();
  function enableTimeWarp() {
    state.timewarp = true;
    state.twIdx = state.twMonths.length - 1;
    document.getElementById('timewarp').hidden = false;
    const slider = document.getElementById('tw-slider');
    slider.max = state.twMonths.length - 1;
    slider.value = state.twIdx;
    paintTimeWarp();
  }
  function disableTimeWarp() {
    state.timewarp = false;
    document.getElementById('timewarp').hidden = true;
    if (twPlayTimer) { clearInterval(twPlayTimer); twPlayTimer = null; }
    document.getElementById('tw-play').classList.remove('playing');
    document.getElementById('tw-play').textContent = '▶';
    applyFilters();  // safe now that state.timewarp = false
  }
  function paintTimeWarp() {
    const month = state.twMonths[state.twIdx];
    const cutoff = month;
    const visible = state.sheds.filter(s => s.first && s.first <= cutoff);
    const monthLabel = new Date(month).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    document.getElementById('tw-month').textContent = monthLabel;
    document.getElementById('tw-counts').textContent =
      `${fmt(visible.length)} of today's ${fmt(state.sheds.length)} sheds were already up`;
    state.filtered = visible;
    document.getElementById('f-count').textContent =
      `${fmt(visible.length)} of ${fmt(state.sheds.length)} sheds`;
    paintFilteredStats();
    document.querySelector('.topbar').classList.add('filtered');
    if (state.view === 'map') renderMap();
  }
  document.getElementById('tw-slider').addEventListener('input', (e) => {
    state.twIdx = +e.target.value;
    paintTimeWarp();
  });
  document.getElementById('tw-play').addEventListener('click', () => {
    const btn = document.getElementById('tw-play');
    if (twPlayTimer) {
      clearInterval(twPlayTimer); twPlayTimer = null;
      btn.classList.remove('playing'); btn.textContent = '▶';
      return;
    }
    btn.classList.add('playing'); btn.textContent = '❚❚';
    if (state.twIdx >= state.twMonths.length - 1) state.twIdx = 0;
    twPlayTimer = setInterval(() => {
      state.twIdx++;
      if (state.twIdx >= state.twMonths.length) {
        state.twIdx = state.twMonths.length - 1;
        clearInterval(twPlayTimer); twPlayTimer = null;
        btn.classList.remove('playing'); btn.textContent = '▶';
      }
      document.getElementById('tw-slider').value = state.twIdx;
      paintTimeWarp();
    }, 110);
  });
  document.getElementById('tw-close').addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
    disableTimeWarp();
  });

  // ── fullscreen + embed code ──────────────────────────────────────────────
  function toggleFs() {
    const root = document.querySelector('.embed');
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (root.requestFullscreen) {
      root.requestFullscreen();
    }
  }
  ['btn-fullscreen', 'btn-fullscreen-2'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', toggleFs);
  });

  const embedModal = document.getElementById('embed-modal');
  const embedCode = document.getElementById('embed-code');
  function openEmbed() {
    const url = 'https://vitalcity-nyc.github.io/nyc-sidewalk-sheds/';
    embedCode.value =
      `<iframe src="${url}?mode=compact" width="100%" height="600" frameborder="0" loading="lazy" style="border:1px solid #e6e6e0;display:block" title="NYC sidewalk shed tracker"></iframe>`;
    embedModal.hidden = false;
    embedCode.select();
  }
  ['btn-embed', 'btn-embed-2'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', openEmbed);
  });
  document.getElementById('embed-close').addEventListener('click', () => {
    embedModal.hidden = true;
  });
  embedModal.addEventListener('click', (e) => {
    if (e.target === embedModal) embedModal.hidden = true;
  });
  document.getElementById('embed-copy').addEventListener('click', async () => {
    embedCode.select();
    try {
      await navigator.clipboard.writeText(embedCode.value);
      const btn = document.getElementById('embed-copy');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch (e) {
      document.execCommand('copy');
    }
  });

  // iframe height-resize ping
  function postHeight() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'embed-resize', height: document.body.scrollHeight }, '*');
    }
  }
  window.addEventListener('load', postHeight);
  window.addEventListener('resize', postHeight);
})();
