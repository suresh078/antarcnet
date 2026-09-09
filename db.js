const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'antarcnet.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'nominal',
  resupply_date INTEGER
);

CREATE TABLE IF NOT EXISTS automated_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  recorded_at INTEGER NOT NULL,
  synced_at INTEGER,
  FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE TABLE IF NOT EXISTS pending_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  metric TEXT,
  triggering_value REAL
);

CREATE TABLE IF NOT EXISTS link_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  satellite_up INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'on_duty',
  last_checkin INTEGER NOT NULL,
  station_join_date INTEGER NOT NULL,
  FOREIGN KEY (station_id) REFERENCES stations(id)
);
`);

// --- Add columns to existing tables if upgrading from an older DB that predates them ---
const alertCols = db.prepare("PRAGMA table_info(alerts)").all().map((c) => c.name);
if (!alertCols.includes('metric')) db.exec('ALTER TABLE alerts ADD COLUMN metric TEXT');
if (!alertCols.includes('triggering_value')) db.exec('ALTER TABLE alerts ADD COLUMN triggering_value REAL');

const stationCols = db.prepare("PRAGMA table_info(stations)").all().map((c) => c.name);
if (!stationCols.includes('resupply_date')) db.exec('ALTER TABLE stations ADD COLUMN resupply_date INTEGER');

// --- Independent seeding per table, so adding new tables later never requires wiping the DB ---

const stationCount = db.prepare('SELECT COUNT(*) AS c FROM stations').get().c;
if (stationCount === 0) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const insertStation = db.prepare('INSERT INTO stations (id, name, status, resupply_date) VALUES (?, ?, ?, ?)');
  // Fixed, known resupply windows (this is realistic: Antarctic resupply is scheduled, not on-demand)
  insertStation.run('maitri', 'Maitri Station', 'nominal', now + 52 * day);
  insertStation.run('bharati', 'Bharati Station', 'nominal', now + 38 * day);

  const insertLink = db.prepare('INSERT INTO link_status (id, satellite_up) VALUES (1, 1)');
  insertLink.run();

  const insertReading = db.prepare(
    'INSERT INTO sensor_readings (station_id, metric, value, recorded_at, synced_at) VALUES (?, ?, ?, ?, ?)'
  );
  const baseValues = {
    maitri:  { power: 78, fuel: 64, temp: -28, food: 58 },
    bharati: { power: 82, fuel: 71, temp: -19, food: 66 },
  };
  for (const [stationId, metrics] of Object.entries(baseValues)) {
    for (let i = 40; i >= 0; i--) {
      const t = now - i * 5 * 60 * 1000;
      const elapsedSteps = 40 - i; // 0 at the oldest seed point, 40 at "now"
      for (const [metric, base] of Object.entries(metrics)) {
        // fuel/food trend downward as we approach "now" — real depletion, not growth.
        // Jitter is kept small relative to the consumption slope so the projection's
        // rate calculation reads a clear trend rather than noise.
        const consumed = (metric === 'fuel' || metric === 'food') ? (elapsedSteps * 0.2) : 0;
        const jitterRange = metric === 'temp' ? 3 : (metric === 'fuel' || metric === 'food') ? 0.8 : 2.5;
        const jitter = (Math.random() - 0.5) * jitterRange;
        insertReading.run(stationId, metric, Math.round((base - consumed + jitter) * 10) / 10, t, t);
      }
    }
  }
} else {
  // Backfill resupply_date for DBs created before this feature existed
  const missing = db.prepare('SELECT id FROM stations WHERE resupply_date IS NULL').all();
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const defaults = { maitri: 52, bharati: 38 };
  for (const row of missing) {
    const days = defaults[row.id] || 45;
    db.prepare('UPDATE stations SET resupply_date = ? WHERE id = ?').run(now + days * day, row.id);
  }
}

const workerCount = db.prepare('SELECT COUNT(*) AS c FROM workers').get().c;
if (workerCount === 0) {
  const insertWorker = db.prepare(
    'INSERT INTO workers (station_id, name, role, status, last_checkin, station_join_date) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const wnow = Date.now();
  const day = 24 * 60 * 60 * 1000;
  insertWorker.run('maitri', 'A. Sharma', 'Station Engineer', 'on_duty', wnow - 10 * 60000, wnow - 62 * day);
  insertWorker.run('maitri', 'R. Iyer', 'Medical Officer', 'resting', wnow - 45 * 60000, wnow - 40 * day);
  insertWorker.run('maitri', 'K. Verma', 'Research Scientist', 'field_ops', wnow - 20 * 60000, wnow - 15 * day);
  insertWorker.run('bharati', 'S. Nair', 'Station Engineer', 'on_duty', wnow - 5 * 60000, wnow - 88 * day);
  insertWorker.run('bharati', 'P. Das', 'Communications Officer', 'on_duty', wnow - 15 * 60000, wnow - 30 * day);
  insertWorker.run('bharati', 'M. Rao', 'Research Scientist', 'field_ops', wnow - 90 * 60000, wnow - 8 * day);
}

module.exports = db;
