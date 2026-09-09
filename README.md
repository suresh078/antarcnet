# AntarcNet — Digital Twin & Smart Automation Prototype
### SIH26060, Team Polar Pioneers

A working prototype built around the actual problem statement: a digital twin
of Maitri and Bharati stations that projects resource consumption forward
against the real resupply calendar, and takes automated conservation action
before a human needs to intervene — not just a monitoring dashboard.

## Important: Node version requirement

Uses Node's **built-in SQLite** (`node:sqlite`) — needs **Node.js 22.5.0+**,
no native compilation required. Check with `node -v`.

## Running it

```bash
npm install
npm start
```
Open **http://localhost:3000**.

## The core idea this version is built around

Antarctic resupply happens in fixed, scheduled seasonal windows — not on
demand. A resource shortfall discovered after the fact has no quick fix.
So the twin doesn't just show current fuel/food levels — it:

1. **Projects forward** — calculates the real consumption rate from recent
   sensor history and extrapolates when fuel/food will hit a critical
   reserve level
2. **Compares against the resupply date** — each station has a fixed,
   known resupply date; if the projected shortfall comes before that date,
   it's a real risk, not just a low number
3. **Acts automatically** — reduces non-essential heating (fuel) or
   activates a ration protocol (food) *before* raising an alert to a human
   — this is the "Smart Automation" the theme asks for, not just IoT + alerts
4. **Still tells HQ** — an alert is logged alongside the automated action,
   so nothing is hidden from human oversight

See the **Digital Twin — Resupply Outlook** panel and **Autonomous Actions**
panel in the dashboard for this live. The "How the Digital Twin works"
collapsible section explains the mechanism in the UI itself.

## What's in this version

**Digital twin & automation (new)**
- Per-resource forward projection (fuel, food) vs. a fixed resupply date
- Autonomous conservation actions, logged separately from alerts
- Auto-compiled compliance report (environmental + operational summary) —
  click a station → "Generate Compliance Report"

**Core dashboard (carried over)**
- Live station cards — power, fuel, food, temp with sparklines and trend arrows
- Personnel status panel, click-to-detail
- Alert feed with critical-alert flash banner
- Satellite link toggle — offline buffer → auto-sync, demonstrated live
- Click a station name → **dedicated station page** (station.html) with a hero
  illustration, a live data-flow visualization (sensors → buffer → sync → twin
  → dashboard), full metric cards, twin outlook, crew, and recent alerts —
  Generate Compliance Report lives here too
- Click-to-explore elsewhere: metric zoom, alert detail, full roster,
  sync history log
- "ⓘ About" and "❔ Tour" built into the UI, "Roadmap" and architecture
  explainer sections

## What's simulated vs. real

- **Real:** server, database, API, twin projection math, automated-action
  rules, offline-buffer/sync logic, alerting, every interactive feature
- **Simulated:** sensor hardware (a timer generates readings) and the
  conservation actions themselves (logged as taken, not wired to real
  actuators — this is a prototype, not a deployed control system)
- **Database:** SQLite via `node:sqlite` instead of MySQL — same relational
  schema, a driver swap away from production

## Honest gaps to mention if asked

- Automated actions are logged, not actually actuating real equipment —
  the rule-triggering logic is real, the "actuator" is simulated
- Projection is a simple linear rate calculation over a 2-hour window, not
  a trained model — deliberately inspectable rather than a black box;
  framed honestly as the first version of the predictive layer
- No per-equipment asset registry yet — the twin models station-level
  resources, not individual components (see Roadmap panel in-app)
- No authentication/roles — anyone reaching the dashboard sees everything

## Project structure

```
antarcnet/
  server.js        Express app, sensor simulator, twin projection engine, all API routes
  db.js             SQLite schema, independent per-table seeding, resupply dates
  public/
    index.html      Main dashboard markup incl. twin/actions panels, modal/tour overlays
    style.css        Light theme, shared across both pages
    app.js            Main dashboard rendering, polling, all click handlers
    station.html     Dedicated per-station page (hero, live flow, metrics, twin, roster)
    station.js        Station page rendering and compliance report
```

## Resetting demo data

```bash
rm antarcnet.db antarcnet.db-shm antarcnet.db-wal
npm start
```
(Windows PowerShell: `Remove-Item antarcnet.db*` then `npm start`)
