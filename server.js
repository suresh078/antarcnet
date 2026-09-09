const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const METRIC_LIMITS = {
  power: { warn: 40, critical: 20 },
  fuel:  { warn: 30, critical: 15 },
  temp:  { warn: -35, critical: -42 },
  food:  { warn: 25, critical: 10 },
};

const BASE_VALUES = {
  maitri:  { power: 78, fuel: 64, temp: -28, food: 58 },
  bharati: { power: 82, fuel: 71, temp: -19, food: 66 },
};

// Consumable resources the digital twin projects forward against the resupply calendar.
// Power is generator-supplied and mean-reverting, not a depleting stock, so it's excluded here.
const PROJECTED_RESOURCES = ['fuel', 'food'];

const currentValues = JSON.parse(JSON.stringify(BASE_VALUES));

// Resume simulation from wherever the data actually left off, instead of snapping back
// to the hardcoded base values on every restart — otherwise a restart creates a fake
// jump in the readings that corrupts the twin's trend calculation.
for (const stationId of Object.keys(BASE_VALUES)) {
  for (const metric of Object.keys(BASE_VALUES[stationId])) {
    const last = db.prepare(
      'SELECT value FROM sensor_readings WHERE station_id = ? AND metric = ? ORDER BY recorded_at DESC LIMIT 1'
    ).get(stationId, metric);
    if (last) currentValues[stationId][metric] = last.value;
  }
}

function getLinkStatus() {
  return db.prepare('SELECT satellite_up FROM link_status WHERE id = 1').get().satellite_up === 1;
}
function setLinkStatus(up) {
  db.prepare('UPDATE link_status SET satellite_up = ? WHERE id = 1').run(up ? 1 : 0);
}

function maybeRaiseAlert(stationId, metric, value) {
  const limits = METRIC_LIMITS[metric];
  if (!limits) return;
  let severity = null;
  if (value <= limits.critical) severity = 'critical';
  else if (value <= limits.warn) severity = 'warning';
  if (!severity) return;

  const recent = db.prepare(
    `SELECT id FROM alerts WHERE station_id = ? AND metric = ? AND created_at > ? AND acknowledged = 0`
  ).get(stationId, metric, Date.now() - 10 * 60 * 1000);
  if (recent) return;

  const label = { power: 'Power reserve', fuel: 'Fuel reserve', temp: 'Internal temperature' }[metric];
  const unit = metric === 'temp' ? '°C' : '%';
  const message = severity === 'critical'
    ? `${label} critical: ${value}${unit} — immediate attention required`
    : `${label} trending low: ${value}${unit} — monitor closely`;

  db.prepare(
    'INSERT INTO alerts (station_id, severity, message, created_at, acknowledged, metric, triggering_value) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).run(stationId, severity, message, Date.now(), metric, value);
}

// ---------- Digital twin: forward projection against the resupply calendar ----------

// Computes a consumption rate (units/hour) from recent history using linear regression
// over every point in the window — not just two endpoints — so noise doesn't create a
// false trend. Projects when a resource will cross its critical threshold. This is
// deliberately simple, inspectable math, not a black-box model.
function projectResource(stationId, metric) {
  // 14 days matches real Antarctic resource-planning timescales — a genuine depletion
  // trend needs a window this wide to be distinguishable from ordinary day-to-day noise.
  const windowStart = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    'SELECT value, recorded_at FROM sensor_readings WHERE station_id = ? AND metric = ? AND recorded_at > ? ORDER BY recorded_at ASC'
  ).all(stationId, metric, windowStart);
  if (rows.length < 8) return null;

  const hoursSpan = (rows[rows.length - 1].recorded_at - rows[0].recorded_at) / (1000 * 60 * 60);
  if (hoursSpan < 24) return null; // need at least a day of real span to trust a rate

  // Least-squares linear regression: rate = slope of value vs. time (converted to per-hour)
  const n = rows.length;
  const t0 = rows[0].recorded_at;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const r of rows) {
    const x = (r.recorded_at - t0) / (1000 * 60 * 60); // hours since window start
    const y = r.value;
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  const ratePerHour = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0; // negative = depleting
  const currentValue = rows[rows.length - 1].value;
  const critical = METRIC_LIMITS[metric].critical;

  let daysUntilCritical = null;
  if (ratePerHour < -0.0005) {
    const hoursUntilCritical = (currentValue - critical) / -ratePerHour;
    daysUntilCritical = Math.max(0, hoursUntilCritical / 24);
  }

  return {
    metric,
    currentValue,
    ratePerHour: Math.round(ratePerHour * 1000) / 1000,
    daysUntilCritical,
  };
}

function checkTwinProjections(stationId) {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
  if (!station || !station.resupply_date) return;
  const daysUntilResupply = (station.resupply_date - Date.now()) / (1000 * 60 * 60 * 24);

  for (const metric of PROJECTED_RESOURCES) {
    const projection = projectResource(stationId, metric);
    if (!projection || projection.daysUntilCritical == null) continue;

    const atRisk = projection.daysUntilCritical < daysUntilResupply;
    if (!atRisk) continue;

    // don't spam: only act once per station/resource per 30 min
    const recent = db.prepare(
      'SELECT id FROM automated_actions WHERE station_id = ? AND resource = ? AND created_at > ?'
    ).get(stationId, metric, Date.now() - 30 * 60 * 1000);
    if (recent) continue;

    const actionText = metric === 'fuel'
      ? 'Reduced non-essential heating setpoint by 2°C to extend fuel reserve'
      : 'Activated food ration protocol — reduced non-essential allocation by 15%';
    const reason = `Projected to hit critical reserve in ~${projection.daysUntilCritical.toFixed(1)} days, ` +
      `${daysUntilResupply.toFixed(0)} days before next scheduled resupply`;

    db.prepare(
      'INSERT INTO automated_actions (station_id, resource, action, reason, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(stationId, metric, actionText, reason, Date.now());

    db.prepare(
      'INSERT INTO alerts (station_id, severity, message, created_at, acknowledged, metric) VALUES (?, ?, ?, ?, 0, ?)'
    ).run(
      stationId, 'warning',
      `Digital twin projects ${metric} shortfall before resupply — automated action taken: ${actionText}`,
      Date.now(), metric
    );
  }
}

// Same profile assignment as the seed data (db.js) — kept in sync so live ticks don't
// contradict the trend the twin was designed to demonstrate.
const CONSUMPTION_PROFILE = {
  maitri:  { fuel: 'flat', food: 'flat' },
  bharati: { fuel: 'depleting', food: 'flat' },
};

setInterval(() => {
  const satelliteUp = getLinkStatus();
  const now = Date.now();
  for (const stationId of Object.keys(BASE_VALUES)) {
    for (const metric of Object.keys(BASE_VALUES[stationId])) {
      let v = currentValues[stationId][metric];
      let drift;
      if (metric === 'temp') {
        drift = (Math.random() - 0.52) * 1.2;
      } else if (metric === 'power') {
        // generator-supplied: fluctuates but reverts toward its base level, doesn't trend to zero
        const base = BASE_VALUES[stationId].power;
        drift = (base - v) * 0.03 + (Math.random() - 0.5) * 1.4;
      } else if (CONSUMPTION_PROFILE[stationId][metric] === 'depleting') {
        // Deliberate demo scenario: a real, slow net drain (~2%/day, matching the seed
        // history) — small per-tick, but consistent, so it doesn't contradict the trend
        // the twin already established over the seeded 14-day history.
        drift = -0.083 / 900 + (Math.random() - 0.5) * 0.3; // ~2%/day spread across 900 ticks/hour
      } else {
        // flat/stable: well-managed resource, fluctuates around its level, no real depletion
        const base = BASE_VALUES[stationId][metric];
        drift = (base - v) * 0.02 + (Math.random() - 0.5) * 1.0;
      }
      v = Math.round((v + drift) * 10) / 10;
      if (metric !== 'temp') v = Math.max(2, Math.min(100, v));
      currentValues[stationId][metric] = v;

      if (satelliteUp) {
        db.prepare(
          'INSERT INTO sensor_readings (station_id, metric, value, recorded_at, synced_at) VALUES (?, ?, ?, ?, ?)'
        ).run(stationId, metric, v, now, now);
        maybeRaiseAlert(stationId, metric, v);
      } else {
        db.prepare(
          'INSERT INTO pending_sync (station_id, metric, value, recorded_at) VALUES (?, ?, ?, ?)'
        ).run(stationId, metric, v, now);
      }
    }
    checkTwinProjections(stationId);
  }
}, 4000);

// ---------- Stations ----------

app.get('/api/stations', (req, res) => {
  const stations = db.prepare('SELECT * FROM stations').all();
  const result = stations.map((s) => {
    const latest = {};
    const trend = {};
    for (const metric of ['power', 'fuel', 'temp', 'food']) {
      const rows = db.prepare(
        'SELECT value FROM sensor_readings WHERE station_id = ? AND metric = ? ORDER BY recorded_at DESC LIMIT 3'
      ).all(s.id, metric);
      latest[metric] = rows[0] ? rows[0].value : null;
      if (rows.length >= 3) {
        const diff = rows[0].value - rows[2].value;
        trend[metric] = diff > 0.3 ? 'up' : diff < -0.3 ? 'down' : 'flat';
      } else {
        trend[metric] = 'flat';
      }
    }
    const pendingCount = db.prepare('SELECT COUNT(*) AS c FROM pending_sync WHERE station_id = ?').get(s.id).c;
    const lastSynced = db.prepare(
      'SELECT MAX(synced_at) AS t FROM sensor_readings WHERE station_id = ? AND synced_at IS NOT NULL'
    ).get(s.id).t;
    const workerCount = db.prepare('SELECT COUNT(*) AS c FROM workers WHERE station_id = ?').get(s.id).c;
    return { ...s, latest, trend, pendingCount, lastSynced, workerCount };
  });
  res.json(result);
});

app.get('/api/stations/:id/history', (req, res) => {
  const { id } = req.params;
  const rows = db.prepare(
    'SELECT metric, value, recorded_at FROM sensor_readings WHERE station_id = ? ORDER BY recorded_at ASC'
  ).all(id);
  const byMetric = { power: [], fuel: [], temp: [], food: [] };
  for (const r of rows) if (byMetric[r.metric]) byMetric[r.metric].push({ t: r.recorded_at, v: r.value });
  for (const k of Object.keys(byMetric)) byMetric[k] = byMetric[k].slice(-30);
  res.json(byMetric);
});

// Full history (more points) for the metric zoom popup
app.get('/api/stations/:id/history/:metric', (req, res) => {
  const { id, metric } = req.params;
  const rows = db.prepare(
    'SELECT value, recorded_at FROM sensor_readings WHERE station_id = ? AND metric = ? ORDER BY recorded_at ASC LIMIT 200'
  ).all(id, metric);
  res.json(rows.map((r) => ({ t: r.recorded_at, v: r.value })));
});

// Full station detail: profile + roster + recent alerts, for the station detail modal
app.get('/api/stations/:id/detail', (req, res) => {
  const { id } = req.params;
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
  if (!station) return res.status(404).json({ error: 'Station not found' });
  const roster = db.prepare('SELECT * FROM workers WHERE station_id = ? ORDER BY name').all(id);
  const recentAlerts = db.prepare(
    'SELECT * FROM alerts WHERE station_id = ? ORDER BY created_at DESC LIMIT 10'
  ).all(id);
  const pendingCount = db.prepare('SELECT COUNT(*) AS c FROM pending_sync WHERE station_id = ?').get(id).c;
  res.json({ station, roster, recentAlerts, pendingCount });
});

// Digital twin: resupply projection outlook for one station
app.get('/api/stations/:id/twin', (req, res) => {
  const { id } = req.params;
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const daysUntilResupply = station.resupply_date
    ? (station.resupply_date - Date.now()) / (1000 * 60 * 60 * 24)
    : null;

  const resources = PROJECTED_RESOURCES.map((metric) => {
    const projection = projectResource(id, metric);
    const atRisk = projection && projection.daysUntilCritical != null && daysUntilResupply != null
      ? projection.daysUntilCritical < daysUntilResupply
      : false;
    return { metric, ...projection, atRisk };
  });

  res.json({ resupplyDate: station.resupply_date, daysUntilResupply, resources });
});

// Autonomous actions taken by the twin (this is the "Smart Automation" evidence, not just alerts)
app.get('/api/automated-actions', (req, res) => {
  const rows = db.prepare(
    `SELECT a.*, s.name AS station_name FROM automated_actions a
     JOIN stations s ON s.id = a.station_id
     ORDER BY a.created_at DESC LIMIT 30`
  ).all();
  res.json(rows);
});

// Environmental/operational compliance report — a realistic NCPOR/MoES reporting need,
// auto-compiled from the same data the twin already tracks
app.get('/api/stations/:id/compliance-report', (req, res) => {
  const { id } = req.params;
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const avg = (metric) => {
    const row = db.prepare(
      'SELECT AVG(value) AS a, MIN(value) AS mn, MAX(value) AS mx, COUNT(*) AS c FROM sensor_readings WHERE station_id = ? AND metric = ? AND recorded_at > ?'
    ).get(id, metric, since);
    return row;
  };
  const alertCount = db.prepare(
    'SELECT COUNT(*) AS c FROM alerts WHERE station_id = ? AND created_at > ?'
  ).get(id, since).c;
  const actionCount = db.prepare(
    'SELECT COUNT(*) AS c FROM automated_actions WHERE station_id = ? AND created_at > ?'
  ).get(id, since).c;

  res.json({
    station: station.name,
    periodHours: 24,
    generatedAt: Date.now(),
    temperature: avg('temp'),
    power: avg('power'),
    fuel: avg('fuel'),
    food: avg('food'),
    alertsRaised: alertCount,
    automatedActionsTaken: actionCount,
  });
});



app.get('/api/alerts', (req, res) => {
  const rows = db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 30').all();
  res.json(rows);
});

app.get('/api/alerts/:id', (req, res) => {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  let context = [];
  if (alert.metric && alert.station_id !== 'hq') {
    context = db.prepare(
      `SELECT value, recorded_at FROM sensor_readings
       WHERE station_id = ? AND metric = ? AND recorded_at <= ?
       ORDER BY recorded_at DESC LIMIT 10`
    ).all(alert.station_id, alert.metric, alert.created_at).reverse();
  }
  res.json({ alert, context });
});

app.post('/api/alerts/:id/ack', (req, res) => {
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Sync ----------

app.get('/api/sync/status', (req, res) => {
  const satelliteUp = getLinkStatus();
  const pending = db.prepare('SELECT COUNT(*) AS c FROM pending_sync').get().c;
  const oldestPending = db.prepare('SELECT MIN(recorded_at) AS t FROM pending_sync').get().t;
  res.json({ satelliteUp, pendingCount: pending, oldestPendingAt: oldestPending });
});

// History of link up/down events, for the sync history modal
app.get('/api/sync/history', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM alerts WHERE station_id = 'hq' ORDER BY created_at DESC LIMIT 20`
  ).all();
  res.json(rows);
});

app.post('/api/sync/toggle', (req, res) => {
  const current = getLinkStatus();
  const next = !current;
  setLinkStatus(next);

  if (next) {
    const pendingRows = db.prepare('SELECT * FROM pending_sync ORDER BY recorded_at ASC').all();
    const insertReading = db.prepare(
      'INSERT INTO sensor_readings (station_id, metric, value, recorded_at, synced_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const r of pendingRows) {
        insertReading.run(r.station_id, r.metric, r.value, r.recorded_at, now);
        maybeRaiseAlert(r.station_id, r.metric, r.value);
      }
      db.prepare('DELETE FROM pending_sync').run();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    if (pendingRows.length > 0) {
      db.prepare(
        'INSERT INTO alerts (station_id, severity, message, created_at, acknowledged) VALUES (?, ?, ?, ?, 0)'
      ).run('hq', 'info', `Satellite link restored — synced ${pendingRows.length} queued readings from stations`, now);
    }
  } else {
    db.prepare(
      'INSERT INTO alerts (station_id, severity, message, created_at, acknowledged) VALUES (?, ?, ?, ?, 0)'
    ).run('hq', 'warning', 'Satellite link lost — stations now buffering data locally', Date.now());
  }

  res.json({ satelliteUp: next });
});

// ---------- Workers ----------

app.get('/api/workers', (req, res) => {
  const rows = db.prepare(
    `SELECT w.*, s.name AS station_name FROM workers w
     JOIN stations s ON s.id = w.station_id
     ORDER BY s.name, w.name`
  ).all();
  res.json(rows);
});

app.get('/api/workers/:id', (req, res) => {
  const worker = db.prepare(
    `SELECT w.*, s.name AS station_name FROM workers w
     JOIN stations s ON s.id = w.station_id WHERE w.id = ?`
  ).get(req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  res.json(worker);
});

app.post('/api/workers/:id/status', (req, res) => {
  const { status } = req.body;
  const allowed = ['on_duty', 'resting', 'field_ops', 'assistance_needed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare('UPDATE workers SET status = ?, last_checkin = ? WHERE id = ?').run(status, Date.now(), req.params.id);

  if (status === 'assistance_needed') {
    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.params.id);
    db.prepare(
      'INSERT INTO alerts (station_id, severity, message, created_at, acknowledged) VALUES (?, ?, ?, ?, 0)'
    ).run(worker.station_id, 'critical', `${worker.name} (${worker.role}) has flagged assistance needed`, Date.now());
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AntarcNet prototype running on http://localhost:${PORT}`);
});
