(() => {
  'use strict';

  const COLORS = [
    { max: 90,    fill: '#57aa4a' },
    { max: 365,   fill: '#dde44c' },
    { max: 1095,  fill: '#ff7c53' },
    { max: 1825,  fill: '#e7466d' },
    { max: 99999, fill: '#d2232a' },
  ];
  const colorFor = (d) => COLORS.find(c => d <= c.max).fill;
  const fmt = (n) => n.toLocaleString('en-US');
  const titleCase = (s) => s.replace(/\w\S*/g, t => t[0].toUpperCase() + t.slice(1).toLowerCase());

  const state = { sheds: [], cd: [], complaints: [], chronic: [], filtered: [], view: 'map', layer: null, complaintLayer: null, buckets: new Set() };

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
  ]).then(([sheds, summary, cd, complaints, chronic]) => {
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
    document.getElementById('s-asof').textContent = s.as_of;
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
        radius: s.days >= 1825 ? 6 : (s.days >= 365 ? 5 : 4),
        weight: 0.5,
        color: '#000',
        fillColor: colorFor(s.days),
        fillOpacity: 0.85,
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
      const radius = n === 1 ? 6 : Math.min(6 + (n - 1) * 3, 16);
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

  function popupHTML(s) {
    const owner = s.owner && s.owner !== '—' ? titleCase(s.owner) : 'Owner not on file';
    const yrs = (s.days / 365).toFixed(1);
    return `
      <div class="popup-addr">${s.addr}</div>
      <div class="popup-days">${fmt(s.days)} days up · ${yrs} years</div>
      <div class="popup-row"><span>Owner</span><span>${owner}</span></div>
      <div class="popup-row"><span>First erected</span><span>${s.first || '—'}</span></div>
      <div class="popup-row"><span>Permit expires</span><span>${s.exp || '—'}</span></div>
      <div class="popup-row"><span>Borough</span><span>${s.boro}</span></div>
      ${s.yrbuilt ? `<div class="popup-row"><span>Year built</span><span>${s.yrbuilt}</span></div>` : ''}
      ${s.bclass ? `<div class="popup-row"><span>Building class</span><span>${s.bclass}</span></div>` : ''}
      ${s.zombie ? '<div class="popup-zombie">Zombie shed</div>' : ''}
    `;
  }

  // ── filters ──────────────────────────────────────────────────────────────
  function getFilters() {
    return {
      boro: document.getElementById('f-boro').value,
      dur: document.getElementById('f-dur').value,
      zombie: document.getElementById('f-zombie').checked,
      q: document.getElementById('f-q').value.trim().toLowerCase(),
    };
  }

  function applyFilters() {
    const f = getFilters();
    state.filtered = state.sheds.filter(s => {
      if (f.boro && s.boro !== f.boro) return false;
      if (state.buckets.size && !state.buckets.has(bucketOf(s.days))) return false;
      if (f.zombie && !s.zombie) return false;
      if (f.q) {
        const hay = (s.addr + ' ' + s.boro + ' ' + s.owner).toLowerCase();
        if (!hay.includes(f.q)) return false;
      }
      return true;
    });
    document.getElementById('f-count').textContent =
      `${fmt(state.filtered.length)} of ${fmt(state.sheds.length)} sheds`;
    if (state.view === 'map') renderMap();
    if (state.view === 'zombies') renderZombieTable();
    syncURL(f);
  }

  ['f-boro','f-zombie','f-q'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyFilters);
  });
  document.getElementById('f-reset').addEventListener('click', () => {
    document.getElementById('f-boro').value = '';
    document.getElementById('f-zombie').checked = false;
    document.getElementById('f-q').value = '';
    document.getElementById('f-311').checked = false;
    document.getElementById('f-chronic').checked = false;
    state.buckets.clear();
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
    root.querySelector('.leg-btn[data-toggle="311"]').classList.toggle('active',
      document.getElementById('f-311').checked);
    root.querySelector('.leg-btn[data-toggle="chronic"]').classList.toggle('active',
      document.getElementById('f-chronic').checked);
  }
  document.querySelectorAll('#legend .leg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.bucket) {
        const b = btn.dataset.bucket;
        if (state.buckets.has(b)) state.buckets.delete(b); else state.buckets.add(b);
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

  // ── community-district table ─────────────────────────────────────────────
  function renderCDTable() {
    const tbody = document.querySelector('#cd-table tbody');
    const cdLabel = (cd) => {
      const boro = ({1:'Manhattan',2:'Bronx',3:'Brooklyn',4:'Queens',5:'Staten Island'})[cd[0]] || '';
      return `${boro} CD ${parseInt(cd.slice(1), 10)}`;
    };
    const enriched = state.cd.map(c => ({ ...c, avg: Math.round(c.shed_days / Math.max(c.sheds, 1)) }));
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

  // iframe height-resize ping
  function postHeight() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'embed-resize', height: document.body.scrollHeight }, '*');
    }
  }
  window.addEventListener('load', postHeight);
  window.addEventListener('resize', postHeight);
})();
