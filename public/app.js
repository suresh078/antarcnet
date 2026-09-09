const METRIC_META = {
  power: { label: 'Power', unit: '%' },
  fuel:  { label: 'Fuel', unit: '%' },
  food:  { label: 'Food', unit: '%' },
  temp:  { label: 'Temp', unit: '°C' },
};
const TREND_ARROW = { up: '↑', down: '↓', flat: '' };
const TREND_GOOD = { power: 'up', fuel: 'up', food: 'up', temp: 'down' };
const STATUS_META = {
  on_duty:           { label: 'On Duty', class: 'nominal' },
  resting:           { label: 'Resting', class: 'info' },
  field_ops:         { label: 'Field Ops', class: 'warning' },
  assistance_needed: { label: 'Needs Assistance', class: 'critical' },
};

let knownCriticalIds = new Set();
let latestStationsCache = [];

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
    // fuel
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

// ---------- Modal system ----------

function openModal(title, bodyHTML) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHTML;
  document.getElementById('modalOverlay').hidden = false;
}
function closeModal() {
  document.getElementById('modalOverlay').hidden = true;
}
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});

// ---------- Stations ----------

async function renderStations() {
  const stations = await fetchJSON('/api/stations');
  latestStationsCache = stations;
  const container = document.getElementById('stations');
  container.innerHTML = '';

  for (const station of stations) {
    const history = await fetchJSON(`/api/stations/${station.id}/history`);
    const overallStatus = stationOverallStatus(station.latest);

    const card = document.createElement('div');
    card.className = 'station-card';

    const metricsHTML = Object.entries(METRIC_META)
      .map(([metric, meta]) => {
        const value = station.latest[metric];
        const severity = metricSeverity(metric, value);
        const path = sparklinePath(history[metric], 100, 24);
        const strokeColor =
          severity === 'critical' ? 'var(--red)' : severity === 'warning' ? 'var(--amber)' : 'var(--cyan)';
        const trendDir = station.trend ? station.trend[metric] : 'flat';
        const trendClass = trendDir === 'flat' ? '' : trendDir === TREND_GOOD[metric] ? 'trend-good' : 'trend-bad';
        return `
          <div class="metric-row" data-metric="${metric}" data-station="${station.id}">
            <span class="metric-label">${meta.label}</span>
            <span class="metric-spark">
              <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                <path d="${path}" fill="none" stroke="${strokeColor}" stroke-width="1.6" />
              </svg>
            </span>
            <span class="metric-value ${severity !== 'nominal' ? severity : ''}">
              ${value != null ? value.toFixed(1) : '—'}${meta.unit}
              <span class="trend-arrow ${trendClass}">${TREND_ARROW[trendDir]}</span>
            </span>
          </div>`;
      })
      .join('');

    const pendingTag = station.pendingCount > 0
      ? `<div class="pending-tag">⌁ ${station.pendingCount} readings buffered, awaiting sync</div>`
      : '';

    card.innerHTML = `
      <div class="station-head clickable" data-station-detail="${station.id}">
        <span class="station-name">${station.name}</span>
        <span class="station-status ${overallStatus}">${overallStatus}</span>
      </div>
      <div class="station-sub">Last synced ${timeAgo(station.lastSynced)} · ${station.workerCount} crew</div>
      <div class="metrics">${metricsHTML}</div>
      ${pendingTag}
    `;
    container.appendChild(card);
  }

  // click station header -> navigate to dedicated station page
  container.querySelectorAll('[data-station-detail]').forEach((el) => {
    el.addEventListener('click', () => {
      window.location.href = `station.html?id=${el.dataset.stationDetail}`;
    });
  });
  // click metric row -> zoom modal
  container.querySelectorAll('.metric-row').forEach((el) => {
    el.addEventListener('click', () => openMetricZoom(el.dataset.station, el.dataset.metric));
  });
}

async function openMetricZoom(stationId, metric) {
  const points = await fetchJSON(`/api/stations/${stationId}/history/${metric}`);
  const meta = METRIC_META[metric];
  const path = sparklinePath(points, 560, 160);
  const values = points.map((p) => p.v);
  const min = values.length ? Math.min(...values).toFixed(1) : '—';
  const max = values.length ? Math.max(...values).toFixed(1) : '—';
  const latest = values.length ? values[values.length - 1].toFixed(1) : '—';

  openModal(`${meta.label} — full trend`, `
    <div class="zoom-stats">
      <span>Latest: <strong>${latest}${meta.unit}</strong></span>
      <span>Min: ${min}${meta.unit}</span>
      <span>Max: ${max}${meta.unit}</span>
    </div>
    <svg viewBox="0 0 560 160" class="zoom-chart" preserveAspectRatio="none">
      <path d="${path}" fill="none" stroke="var(--cyan)" stroke-width="2" />
    </svg>
  `);
}

// ---------- Workers ----------

async function renderWorkers() {
  const workers = await fetchJSON('/api/workers');
  const list = document.getElementById('workersList');
  list.innerHTML = '';

  let currentStation = null;
  for (const w of workers) {
    if (w.station_name !== currentStation) {
      currentStation = w.station_name;
      const header = document.createElement('div');
      header.className = 'worker-station-header';
      header.textContent = currentStation;
      list.appendChild(header);
    }
    const meta = STATUS_META[w.status] || STATUS_META.on_duty;
    const row = document.createElement('div');
    row.className = 'worker-row clickable';
    row.dataset.workerId = w.id;
    row.innerHTML = `
      <div class="worker-info">
        <span class="worker-name">${w.name}</span>
        <span class="worker-role">${w.role}</span>
      </div>
      <span class="worker-status ${meta.class}">${meta.label}</span>
    `;
    list.appendChild(row);
  }

  list.querySelectorAll('.worker-row').forEach((row) => {
    row.addEventListener('click', () => openWorkerDetail(row.dataset.workerId));
  });
}

async function openWorkerDetail(workerId) {
  const w = await fetchJSON(`/api/workers/${workerId}`);
  const meta = STATUS_META[w.status] || STATUS_META.on_duty;
  openModal(w.name, `
    <div class="modal-section">
      <p><strong>Role:</strong> ${w.role}</p>
      <p><strong>Station:</strong> ${w.station_name}</p>
      <p><strong>Current status:</strong> <span class="worker-status ${meta.class}">${meta.label}</span></p>
      <p><strong>Last check-in:</strong> ${timeAgo(w.last_checkin)}</p>
      <p><strong>Time at station:</strong> ${daysAgo(w.station_join_date)} days</p>
    </div>
  `);
}

async function openRosterModal() {
  const workers = await fetchJSON('/api/workers');
  const rows = workers.map((w) => {
    const meta = STATUS_META[w.status] || STATUS_META.on_duty;
    return `<div class="modal-list-row"><span>${w.name} — ${w.role} (${w.station_name})</span><span class="worker-status ${meta.class}">${meta.label}</span></div>`;
  }).join('');
  openModal('Full Personnel Roster', rows);
}

// ---------- Digital Twin: resupply outlook ----------

async function renderTwin() {
  const stations = await fetchJSON('/api/stations');
  const container = document.getElementById('twinList');
  container.innerHTML = '';

  for (const station of stations) {
    const twin = await fetchJSON(`/api/stations/${station.id}/twin`);
    const row = document.createElement('div');
    row.className = 'twin-station-block';

    const resourceRows = twin.resources.map((r) => {
      const meta = METRIC_META[r.metric];
      const statusClass = r.atRisk ? 'critical' : 'nominal';
      const statusLabel = r.atRisk ? 'AT RISK' : 'SAFE';
      const daysText = r.daysUntilCritical != null ? `${r.daysUntilCritical.toFixed(1)}d to critical` : 'stable';
      // simple visual: bar showing depletion-date vs resupply-date, clamped for display
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

    row.innerHTML = `<div class="twin-station-name">${station.name}</div>${resourceRows}`;
    container.appendChild(row);
  }
}

async function renderAutomatedActions() {
  const actions = await fetchJSON('/api/automated-actions');
  const list = document.getElementById('actionsList');
  list.innerHTML = '';

  if (actions.length === 0) {
    list.innerHTML = '<div class="empty-note">No automated actions taken yet — all projections within safe range.</div>';
    return;
  }

  for (const a of actions) {
    const item = document.createElement('div');
    item.className = 'action-item';
    item.innerHTML = `
      <div class="alert-meta">
        <span>${a.station_name}</span>
        <span>${timeAgo(a.created_at)}</span>
      </div>
      <div class="action-message"><strong>⚙ ${a.action}</strong></div>
      <div class="action-reason">${a.reason}</div>
    `;
    list.appendChild(item);
  }
}

// ---------- Alerts ----------

function flashCriticalBanner(alert) {
  const flash = document.createElement('div');
  flash.className = 'critical-flash';
  flash.textContent = `⚠ CRITICAL — ${alert.station_id.toUpperCase()}: ${alert.message}`;
  document.body.appendChild(flash);
  setTimeout(() => flash.classList.add('show'), 10);
  setTimeout(() => {
    flash.classList.remove('show');
    setTimeout(() => flash.remove(), 400);
  }, 4000);
}

async function renderAlerts() {
  const alerts = await fetchJSON('/api/alerts');
  for (const alert of alerts) {
    if (alert.severity === 'critical' && !alert.acknowledged && !knownCriticalIds.has(alert.id)) {
      knownCriticalIds.add(alert.id);
      flashCriticalBanner(alert);
    }
  }

  const list = document.getElementById('alertsList');
  list.innerHTML = '';
  const unacked = alerts.filter((a) => !a.acknowledged);

  if (unacked.length === 0) {
    list.innerHTML = '<div class="empty-note">No alerts yet. All systems nominal.</div>';
    return;
  }

  for (const alert of unacked) {
    const item = document.createElement('div');
    item.className = `alert-item ${alert.severity}`;
    item.innerHTML = `
      <div class="alert-meta">
        <span>${alert.station_id}</span>
        <span>${timeAgo(alert.created_at)}</span>
      </div>
      <div class="alert-message clickable" data-alert-id="${alert.id}">${alert.message}</div>
      <button class="alert-ack" data-id="${alert.id}">Acknowledge</button>
    `;
    list.appendChild(item);
  }

  list.querySelectorAll('.alert-ack').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetchJSON(`/api/alerts/${btn.dataset.id}/ack`, { method: 'POST' });
      renderAlerts();
    });
  });
  list.querySelectorAll('.alert-message').forEach((el) => {
    el.addEventListener('click', () => openAlertDetail(el.dataset.alertId));
  });
}

async function openAlertDetail(alertId) {
  const { alert, context } = await fetchJSON(`/api/alerts/${alertId}`);
  const contextHTML = context.length
    ? `<svg viewBox="0 0 300 80" class="zoom-chart small" preserveAspectRatio="none">
         <path d="${sparklinePath(context, 300, 80)}" fill="none" stroke="var(--amber)" stroke-width="2" />
       </svg>`
    : '<p class="empty-note">No sensor context available for this alert.</p>';

  openModal('Alert Detail', `
    <div class="modal-section">
      <p><strong>Station:</strong> ${alert.station_id}</p>
      <p><strong>Severity:</strong> ${alert.severity}</p>
      <p><strong>Message:</strong> ${alert.message}</p>
      <p><strong>Raised:</strong> ${timeAgo(alert.created_at)}</p>
      ${alert.metric ? `<p><strong>Triggering value:</strong> ${alert.triggering_value}</p>` : ''}
    </div>
    ${alert.metric ? `<div class="modal-section"><h4>Reading trend leading up to this alert</h4>${contextHTML}</div>` : ''}
  `);
}

async function openSyncHistory() {
  const rows = await fetchJSON('/api/sync/history');
  const html = rows.map((r) =>
    `<div class="modal-list-row"><span>${r.message}</span><span class="alert-time">${timeAgo(r.created_at)}</span></div>`
  ).join('') || '<div class="empty-note">No sync events logged yet.</div>';
  openModal('Satellite Sync History', html);
}

// ---------- Sync status / banner ----------

async function renderSyncStatus() {
  const status = await fetchJSON('/api/sync/status');
  const pill = document.getElementById('linkToggle');
  const dot = document.getElementById('linkDot');
  const label = document.getElementById('linkLabel');
  const banner = document.getElementById('queueBanner');
  const bannerText = document.getElementById('queueBannerText');

  if (status.satelliteUp) {
    pill.classList.remove('down');
    dot.classList.remove('down');
    label.textContent = 'SATELLITE LINK: UP';
    banner.hidden = true;
  } else {
    pill.classList.add('down');
    dot.classList.add('down');
    label.textContent = 'SATELLITE LINK: DOWN';
    banner.hidden = false;
    bannerText.textContent = `${status.pendingCount} readings buffered at stations, waiting for satellite window`;
  }
}

// ---------- Clock ----------

function tickClock() {
  const now = new Date();
  const ist = new Date(now.getTime() + (330 - now.getTimezoneOffset()) * 60000);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  document.getElementById('missionClock').textContent = `${hh}:${mm}:${ss} IST`;
}

// ---------- About panel ----------

function openAboutPanel() {
  openModal('About AntarcNet', `
    <div class="modal-section">
      <p><strong>Problem statement:</strong> SIH26060 — Digital Twin framework for Maitri and Bharati
      stations, integrating infrastructure, energy, logistics and environmental monitoring for
      efficient remote management. Ministry of Earth Sciences (MoES) / NCPOR. Theme: Smart Automation.</p>
      <p><strong>The problem:</strong> Antarctic resupply only happens in scheduled seasonal windows,
      not on demand. A resource shortfall discovered too late has no quick fix. Manual logs and
      unreliable satellite links mean HQ often finds out only after a threshold is already crossed.</p>
      <p><strong>The solution:</strong> a digital twin of each station that simulates fuel and food
      consumption forward against the actual resupply calendar — predicting shortfalls weeks in
      advance, not just alerting when a value is already low. When a shortfall is projected, the
      system takes an automated conservation action first, and escalates to HQ alongside it.</p>
      <p><strong>What makes this different:</strong> most monitoring dashboards notify a human and
      stop there. This system acts autonomously within safe limits before a human is even needed —
      that's the "Smart Automation" the theme is asking for, not just IoT + alerts.</p>
      <p><strong>Team:</strong> Polar Pioneers</p>
    </div>
  `);
}

// ---------- Guided tour ----------

const TOUR_STEPS = [
  { selector: '[data-tour="stations"]', text: 'Live station cards — power, fuel, food, and temperature for Maitri and Bharati, updating every few seconds.' },
  { selector: '[data-tour="twin"]', text: 'The digital twin projects fuel and food forward against each station\'s fixed resupply date — not just a threshold, an actual forecast.' },
  { selector: '[data-tour="actions"]', text: 'When a shortfall is projected, the system takes an automated conservation action here — before it ever needs a human.' },
  { selector: '[data-tour="link"]', text: 'Click this to simulate the satellite link going down. Data keeps recording locally and syncs automatically once it comes back.' },
  { selector: '[data-tour="workers"]', text: 'Personnel status for both stations — click any name for details, or the header for the full roster.' },
  { selector: '[data-tour="alerts"]', text: 'Automatic alerts fire alongside automated actions, or when a metric crosses a safe threshold. Click any alert for more detail.' },
];
let tourIndex = 0;

function showTourStep(i) {
  if (i >= TOUR_STEPS.length) {
    document.getElementById('tourOverlay').hidden = true;
    return;
  }
  document.getElementById('tourOverlay').hidden = false;
  document.getElementById('tourText').textContent = TOUR_STEPS[i].text;
}

document.getElementById('tourBtn').addEventListener('click', () => {
  tourIndex = 0;
  showTourStep(tourIndex);
});
document.getElementById('tourNext').addEventListener('click', () => {
  tourIndex += 1;
  showTourStep(tourIndex);
});
document.getElementById('tourSkip').addEventListener('click', () => {
  document.getElementById('tourOverlay').hidden = true;
});

// ---------- Collapsible sections ----------

document.getElementById('archToggle').addEventListener('click', () => {
  const body = document.getElementById('archBody');
  body.hidden = !body.hidden;
});
document.getElementById('roadmapToggle').addEventListener('click', () => {
  const body = document.getElementById('roadmapBody');
  body.hidden = !body.hidden;
});

// ---------- Wire up buttons ----------

document.getElementById('linkToggle').addEventListener('click', async () => {
  await fetchJSON('/api/sync/toggle', { method: 'POST' });
  refreshAll();
});
document.getElementById('syncHistoryBtn').addEventListener('click', openSyncHistory);
document.getElementById('aboutBtn').addEventListener('click', openAboutPanel);
document.getElementById('rosterHeader').addEventListener('click', openRosterModal);

// ---------- Main refresh loop ----------

function refreshAll() {
  renderStations();
  renderTwin();
  renderAutomatedActions();
  renderAlerts();
  renderSyncStatus();
  renderWorkers();
}

tickClock();
setInterval(tickClock, 1000);
refreshAll();
setInterval(refreshAll, 4000);
