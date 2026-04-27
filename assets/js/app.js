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

  const state = { sheds: [], cd: [], complaints: [], filtered: [], view: 'map', layer: null, complaintLayer: null };

  // ── load data ────────────────────────────────────────────────────────────
  Promise.all([
    fetch('data/sheds.json').then(r => r.json()),
    fetch('data/summary.json').then(r => r.json()),
    fetch('data/cd.json').then(r => r.json()),
    fetch('data/complaints311.json').then(r => r.json()).catch(() => []),
  ]).then(([sheds, summary, cd, complaints]) => {
    state.sheds = sheds;
    state.cd = cd;
    state.complaints = complaints;
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
    document.querySelector('.legend-311').hidden = !on;
    if (!on) return;
    const g = L.layerGroup();
    for (const c of state.complaints) {
      const m = L.circleMarker([c.lat, c.lon], {
        radius: 7,
        weight: 2,
        color: '#0a4f80',
        fillColor: '#217ebe',
        fillOpacity: 0.55,
      });
      m.bindPopup(`
        <div class="popup-addr">311 complaint</div>
        <div class="popup-row"><span>Filed</span><span>${c.created || '—'}</span></div>
        <div class="popup-row"><span>Status</span><span>${c.status || '—'}</span></div>
        <div class="popup-row"><span>Address</span><span>${c.addr}, ${c.boro}</span></div>
        <div class="popup-row"><span>Descriptor</span><span style="text-align:right;max-width:170px">${c.desc}</span></div>
      `, { maxWidth: 280 });
      g.addLayer(m);
    }
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
    let [lo, hi] = [0, 99999];
    if (f.dur) [lo, hi] = f.dur.split('-').map(Number);
    state.filtered = state.sheds.filter(s => {
      if (f.boro && s.boro !== f.boro) return false;
      if (f.dur && (s.days < lo || s.days > hi)) return false;
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

  ['f-boro','f-dur','f-zombie','f-q'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyFilters);
  });
  document.getElementById('f-311').addEventListener('change', render311);
  document.getElementById('f-reset').addEventListener('click', () => {
    document.getElementById('f-boro').value = '';
    document.getElementById('f-dur').value = '';
    document.getElementById('f-zombie').checked = false;
    document.getElementById('f-q').value = '';
    applyFilters();
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

  // ── zombie table ─────────────────────────────────────────────────────────
  function renderZombieTable() {
    const rows = state.sheds.filter(s => s.zombie)
      .sort((a, b) => b.days - a.days).slice(0, 200);
    const tbody = document.querySelector('#zombie-table tbody');
    tbody.innerHTML = rows.map(s => `
      <tr data-bin="${s.bin}">
        <td class="num">${fmt(s.days)}</td>
        <td>${s.addr}</td>
        <td class="dim">${s.boro}</td>
        <td>${s.owner === '—' ? '<span class="dim">—</span>' : titleCase(s.owner)}</td>
        <td class="dim">${s.yrbuilt || '—'}</td>
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
    tbody.innerHTML = state.cd.map(c => `
      <tr data-cd="${c.cd}">
        <td>${cdLabel(c.cd)}</td>
        <td class="num">${fmt(c.sheds)}</td>
        <td class="num">${fmt(c.shed_days)}</td>
        <td class="num">${fmt(c.zombies)}</td>
        <td class="num">${fmt(Math.round(c.shed_days / Math.max(c.sheds,1)))}</td>
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
    if (p.get('dur')) document.getElementById('f-dur').value = p.get('dur');
    if (p.get('zombie') === '1') document.getElementById('f-zombie').checked = true;
    if (p.get('q')) document.getElementById('f-q').value = p.get('q');
    if (state.view !== 'map') switchView(state.view);
  }
  function syncURL(f) {
    const p = new URLSearchParams();
    if (state.view !== 'map') p.set('view', state.view);
    if (f.boro) p.set('boro', f.boro);
    if (f.dur) p.set('dur', f.dur);
    if (f.zombie) p.set('zombie', '1');
    if (f.q) p.set('q', f.q);
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
