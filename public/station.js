const METRIC_META = {
  power: { label: 'Power', unit: '%' },
  fuel:  { label: 'Fuel', unit: '%' },
  food:  { label: 'Food', unit: '%' },
  temp:  { label: 'Temp', unit: '°C' },
};

const STATUS_META = {
  on_duty:           { label: 'On Duty', class: 'nominal' },
  resting:           { label: 'Resting', class: 'info' },
  field_ops:         { label: 'Field Ops', class: 'warning' },
  assistance_needed: { label: 'Needs Assistance', class: 'critical' },
};

const params = new URLSearchParams(window.location.search);
const stationId = params.get('id') || 'maitri';

const HERO_IMAGES = {
  maitri: { src: 'images/maitri.jpg', alt: 'Maitri Station, Antarctica' },
  bharati: { src: 'images/bharati.jpg', alt: 'Bharati Station, Antarctica' },
};

function setHeroImage() {
  const hero = HERO_IMAGES[stationId] || HERO_IMAGES.maitri;
  const img = document.getElementById('stationHeroImg');
  img.src = hero.src;
  img.alt = hero.alt;
}
setHeroImage();

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  return res.json();
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
}

function daysAgo(ts) {
  return Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
}

function sparklinePath(points, width, height) {
  if (!points || points.length < 2) return '';
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  return points
    .map((p, i) => {
      const x = i * stepX;
      const y = height - ((p.v - min) / range) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function metricSeverity(metric, value) {
  if (value == null) return 'nominal';
  if (metric === 'temp') {
    if (value <= -42) return 'critical';
    if (value <= -35) return 'warning';
  } else if (metric === 'food') {
    if (value <= 10) return 'critical';
    if (value <= 25) return 'warning';
  } else if (metric === 'power') {
    if (value <= 20) return 'critical';
    if (value <= 40) return 'warning';
  } else {
    if (value <= 15) return 'critical';
    if (value <= 30) return 'warning';
  }
  return 'nominal';
}

function stationOverallStatus(latest) {
  const severities = Object.entries(latest).map(([m, v]) => metricSeverity(m, v));
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('warning')) return 'warning';
  return 'nominal';
}

// ---------- Modal (compliance report only on this page) ----------

function openModal(title, bodyHTML) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHTML;
  document.getElementById('modalOverlay').hidden = false;
}
function closeModal() { document.getElementById('modalOverlay').hidden = true; }
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});

async function openComplianceReport() {
  const r = await fetchJSON(`/api/stations/${stationId}/compliance-report`);
  const fmt = (stat, unit) => stat && stat.c > 0
    ? `avg ${stat.a.toFixed(1)}${unit}, range ${stat.mn.toFixed(1)}–${stat.mx.toFixed(1)}${unit} (${stat.c} readings)`
    : 'no data in period';

  openModal('Compliance Report', `
    <div class="modal-section">
      <p><strong>Station:</strong> ${r.station}</p>
      <p><strong>Period:</strong> last ${r.periodHours} hours</p>
      <p><strong>Generated:</strong> ${new Date(r.generatedAt).toLocaleString()}</p>
    </div>
    <div class="modal-section">
      <h4>Environmental & Resource Summary</h4>
      <div class="modal-list-row"><span>Temperature</span><span>${fmt(r.temperature, '°C')}</span></div>
      <div class="modal-list-row"><span>Power</span><span>${fmt(r.power, '%')}</span></div>
      <div class="modal-list-row"><span>Fuel</span><span>${fmt(r.fuel, '%')}</span></div>
      <div class="modal-list-row"><span>Food</span><span>${fmt(r.food, '%')}</span></div>
    </div>
    <div class="modal-section">
      <h4>Operational Summary</h4>
      <div class="modal-list-row"><span>Alerts raised</span><span>${r.alertsRaised}</span></div>
      <div class="modal-list-row"><span>Automated actions taken</span><span>${r.automatedActionsTaken}</span></div>
    </div>
    <p class="empty-note">Auto-compiled from live sensor data — intended as a starting point for
    MoES/NCPOR environmental and operational reporting requirements.</p>
  `);
}
document.getElementById('complianceBtnPage').addEventListener('click', openComplianceReport);

// ---------- Live flow ----------

async function renderFlow() {
  const [station, syncStatus] = await Promise.all([
    fetchJSON('/api/stations').then((all) => all.find((s) => s.id === stationId)),
    fetchJSON('/api/sync/status'),
  ]);
  if (!station) return;

  const overall = stationOverallStatus(station.latest);
  const bufferState = station.pendingCount > 0 ? 'warning' : 'nominal';
  const syncState = syncStatus.satelliteUp ? 'nominal' : 'warning';

  const nodes = [
    { label: 'Sensors', sub: 'reading every 4s', state: 'nominal' },
    { label: 'Local Buffer', sub: station.pendingCount > 0 ? `${station.pendingCount} buffered` : 'clear', state: bufferState },
    { label: 'Satellite Sync', sub: syncStatus.satelliteUp ? `synced ${timeAgo(station.lastSynced)}` : 'link down', state: syncState },
    { label: 'Digital Twin', sub: 'projecting vs. resupply', state: 'nominal' },
    { label: 'Command Dashboard', sub: overall, state: overall },
  ];

  const track = document.getElementById('flowTrack');
  track.innerHTML = nodes.map((n, i) => `
    <div class="flow-node">
      <div class="flow-dot ${n.state}"></div>
      <div class="flow-label">${n.label}</div>
      <div class="flow-sub">${n.sub}</div>
    </div>
    ${i < nodes.length - 1 ? '<div class="flow-connector"></div>' : ''}
  `).join('');
}

// ---------- Header + metrics ----------

async function renderHeaderAndMetrics() {
  const stations = await fetchJSON('/api/stations');
  const station = stations.find((s) => s.id === stationId);
  if (!station) {
    document.getElementById('stationTitle').textContent = 'Station not found';
    return;
  }
  const overall = stationOverallStatus(station.latest);
  document.getElementById('stationTitle').textContent = station.name;
  document.title = `AntarcNet — ${station.name}`;
  const badge = document.getElementById('stationStatusBadge');
  badge.textContent = overall.toUpperCase();
  badge.className = `station-status ${overall}`;

  const history = await fetchJSON(`/api/stations/${stationId}/history`);
  const grid = document.getElementById('detailMetrics');
  grid.innerHTML = Object.entries(METRIC_META).map(([metric, meta]) => {
    const value = station.latest[metric];
    const severity = metricSeverity(metric, value);
    const path = sparklinePath(history[metric], 260, 60);
    const strokeColor = severity === 'critical' ? 'var(--red)' : severity === 'warning' ? 'var(--amber)' : 'var(--cyan)';
    return `
      <div class="detail-metric-card">
        <div class="detail-metric-label">${meta.label}</div>
        <div class="detail-metric-value ${severity !== 'nominal' ? severity : ''}">${value != null ? value.toFixed(1) : '—'}${meta.unit}</div>
        <svg viewBox="0 0 260 60" class="detail-metric-spark" preserveAspectRatio="none">
          <path d="${path}" fill="none" stroke="${strokeColor}" stroke-width="2" />
        </svg>
      </div>`;
  }).join('');
}

// ---------- Twin outlook ----------

async function renderTwinOutlook() {
  const twin = await fetchJSON(`/api/stations/${stationId}/twin`);
  const container = document.getElementById('detailTwin');

  const rows = twin.resources.map((r) => {
    const meta = METRIC_META[r.metric];
    const statusClass = r.atRisk ? 'critical' : 'nominal';
    const statusLabel = r.atRisk ? 'AT RISK' : 'SAFE';
    const daysText = r.daysUntilCritical != null ? `${r.daysUntilCritical.toFixed(1)}d to critical` : 'stable';
    const resupplyDays = twin.daysUntilResupply != null ? twin.daysUntilResupply : 0;
    const depletionDays = r.daysUntilCritical != null ? r.daysUntilCritical : resupplyDays * 2;
    const maxScale = Math.max(resupplyDays, depletionDays, 1);
    const depletionPct = Math.min(100, (depletionDays / maxScale) * 100);
    const resupplyPct = Math.min(100, (resupplyDays / maxScale) * 100);

    return `
      <div class="twin-resource-row">
        <div class="twin-resource-head">
          <span>${meta.label}</span>
          <span class="worker-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="twin-timeline">
          <div class="twin-timeline-fill ${r.atRisk ? 'at-risk' : ''}" style="width:${depletionPct}%"></div>
          <div class="twin-timeline-marker" style="left:${resupplyPct}%" title="Resupply date"></div>
        </div>
        <div class="twin-resource-sub">${r.currentValue != null ? r.currentValue.toFixed(1) : '—'}% now · ${daysText} · resupply in ${resupplyDays.toFixed(0)}d</div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="twin-station-block">${rows}</div>`;
}

// ---------- Roster + alerts ----------

async function renderRosterAndAlerts() {
  const detail = await fetchJSON(`/api/stations/${stationId}/detail`);
  const rosterEl = document.getElementById('detailRoster');
  rosterEl.innerHTML = detail.roster.map((w) => {
    const meta = STATUS_META[w.status] || STATUS_META.on_duty;
    return `<div class="modal-list-row"><span>${w.name} — ${w.role} · ${daysAgo(w.station_join_date)}d at station</span><span class="worker-status ${meta.class}">${meta.label}</span></div>`;
  }).join('') || '<div class="empty-note">No crew on record.</div>';

  const alertsEl = document.getElementById('detailAlerts');
  alertsEl.innerHTML = detail.recentAlerts.map((a) =>
    `<div class="modal-list-row"><span>${a.message}</span><span class="alert-time">${timeAgo(a.created_at)}</span></div>`
  ).join('') || '<div class="empty-note">No recent alerts.</div>';
}

function refreshAll() {
  renderFlow();
  renderHeaderAndMetrics();
  renderTwinOutlook();
  renderRosterAndAlerts();
}

refreshAll();
setInterval(refreshAll, 4000);
