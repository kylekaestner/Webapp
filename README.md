# CrewSync

A private pilot scheduling and crew coordination web app. Tracks flight schedules for a group of pilots, shows live ADS-B positions, calculates location overlaps, and works as an installable mobile webapp.

---

## Project Structure

```
├── server.js          # Express API + parsers + auto-sync scheduler
├── db.js              # SQLite init and schema
├── dispatch.db        # SQLite database (auto-created)
├── airports.dat       # OpenFlights airport database (coords + timezones)
├── public/
│   ├── app.html       # Main app (calendar, map, list, overlap)
│   ├── join.html      # New pilot onboarding form
│   └── index.html     # Landing page
└── README.md
```

---

## Setup

```bash
npm install
npm start          # production
npm run dev        # nodemon (auto-restart)
```

Server starts on port 3000. Database auto-initializes on first run.

---

## Features

### Views
- **Calendar Grid** — monthly view with color-coded flights, DH, reserve, layovers, personal/commute flights
- **List View** — day-by-day chronological list with block times, layover durations, ground transfers
- **Route Map** — great circle arcs, live ADS-B trail, predictive arc for in-progress flights
  - *My Routes* — single pilot's month
  - *All Crew — Day* — all pilots on one map for a selected day
  - *All Crew — Month* — everyone's routes for the month, click route lines for details
- **Location Overlap** — shows when any two pilots are in the same city/airport

### Schedule Sync & Upload
- **Auto-sync** — ICS-based schedules sync automatically at 06:00, 14:00, and 22:00 UTC
- **Manual sync** — one-tap sync button available for all ICS pilots in addition to auto-sync
- **Upload** — CSV and VCS file upload supported for applicable pilots

### Reserve Periods
On-call reserve shifts (RESR, RESP, RESA) are parsed and displayed:
- Amber color coding on calendar and list
- Shows type label (Red-Eye / PM / AM Reserve), times, and duration
- Location set to pilot's **base** airport
- Counted as working days for common-off-days calculation

### Ground Transfers
Some trips include van/bus legs between nearby airports. These are stored as `type: ground` segments:
- Appear as small subdued rows in the list view and day detail sheet
- Used by the map to correctly place the pilot's "here now" location
- Not drawn as flight arcs on the map

### Manual Flights
Add flights manually for any pilot in four categories:
- **Work** — revenue flight
- **Deadhead (DH)** — deadhead leg
- **Commute** — commute leg (amber color)
- **Personal** — personal travel (violet color)

### Live ADS-B
- Polls ADS-B Exchange every 8 seconds for airborne aircraft
- Smooth Chaikin-algorithm trail rendering
- Trail seeded from flight history on server start
- Green animated arc shows predicted path for active flights

### Mobile
- Installable as a home screen webapp (iOS Safari)
- Pilot identity resolved from personalized link
- Bottom nav bar: Calendar, List, Map, Overlap, Upload/Sync
- One-tap sync for ICS pilots; upload for CSV/VCS pilots

---

## Schedule Parsers

### ICS (Schedaero)
`.ics` export from Schedaero. Parses `VEVENT` blocks with `SUMMARY` containing airport pairs and `DESCRIPTION` with tail/trip info.

### CSV (Republic/standard)
Required columns: `DATE, DEP, ARR, DEPTIME, ARRTIME`  
Optional: `TAIL, DH, FCVTAIL, EQP, FLIGHT, BLOCK, CREW`

Times are local to the departure airport. Block time pulled from `BLOCK` column.

### CSV (SkyWest variant)
Flexible header matching — accepts `FLIGHTDATE|DATE`, `DEPARTURE|DEP|ORIG`, `DESTINATION|ARR|DEST`, `DEP_TIME|DEPTIME`, `ARR_TIME|ARRTIME`, `AIRCRAFT|TAIL`, `DH|DUTY`.

### VCS (SkedPlus+)
SkyWest SkedPlus+ `.vcs` export. Quoted-printable encoded. Parses day headers and flight leg lines from `DESCRIPTION`. Reserve types (RE2) mapped to `type: reserve`. Training pairings (IOE, TRN, and similar prefixes) are supported.

### ICS (RosterBuster)
ICS subscription URL stored on server, fetched on each sync.

### ICS (AIMS eCrew)
ICS subscription URL from calendar publish. Each `VEVENT` is a duty period; individual legs are parsed from the `DESCRIPTION` field.

- **Reserves** (RESR/RESP/RESA): `type: reserve`, airports from `LOCATION` field
- **Operating flights** (numeric codes): `type: flight`, `dh: false`
- **Deadhead flights**: `type: flight`, `dh: true`
- **Own-ticket deadhead** (OWN####): `type: flight`, `dh: true`, no flight number stored
- **Ground transport** (GRND####): `type: ground`, stored for map location tracking only
- **RAP / same-airport legs**: skipped

Each airport's timezone is resolved from `airports.dat` for accurate UTC conversion of local leg times.

---

## API Endpoints

```
GET  /api/pilots                              All pilots
GET  /api/pilots/:key                         Pilot + segments (parser_type resolved server-side)
PUT  /api/pilots/:key                         Update pilot profile
DEL  /api/pilots/:key                         Delete pilot
POST /api/pilots/:key/upload                  Upload schedule file (.ics, .csv, .vcs, .pdf)
POST /api/pilots/:key/sync-ics               Sync ICS URL (saves URL, then fetches)
POST /api/pilots/:key/add-segment             Add manual flight
PUT  /api/pilots/:key/segments/:id            Edit manual flight
DEL  /api/pilots/:key/segments/:id            Delete manual flight
DEL  /api/pilots/:key/segments                Clear all segments
POST /api/pilots/:key/sync-schedaero          Sync one month (Schedaero pilots)
POST /api/pilots/:key/quick-sync-schedaero    Sync using saved credentials

GET  /api/live/:hex                           ADS-B position for aircraft hex code

GET  /api/settings/:key                       Read a settings value
POST /api/settings/:key                       Write a settings value
GET  /api/health                              Health check
```

---

## Database Schema

### pilots
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| pilot_key | TEXT UNIQUE | Short identifier for each pilot |
| name | TEXT | |
| base | TEXT | Crew base (airline city) |
| home_airport | TEXT | Where the pilot lives |
| role | TEXT | e.g. Captain, FO |
| parser_type | TEXT | csv, csv_skywest, vcs_skywest, ics, ics_rosterbuster, ics_scx, schedaero, other |
| airline_code | TEXT | IATA/ICAO airline code |
| token | TEXT | URL token for personalized bookmark |
| last_active | TEXT | ISO timestamp of last app access |

### segments
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| pilot_id | INTEGER FK | |
| type | TEXT | flight, reserve, ground, hard, away |
| departure_time | TEXT | ISO 8601 UTC |
| arrival_time | TEXT | ISO 8601 UTC |
| departure_airport | TEXT | IATA code |
| arrival_airport | TEXT | IATA code |
| tail | TEXT | Aircraft tail number |
| trip | TEXT | Trip/pairing number |
| flight_number | TEXT | |
| is_dh | BOOLEAN | Deadhead flag |
| is_manual | BOOLEAN | Manually added |
| block_minutes | INTEGER | |

### settings
Generic key/value store for server-side configuration (sync URLs, credentials, app settings).

---

## Troubleshooting

**Fields empty in Schedaero modal** — Has a successful sync been completed? Credentials are only saved after a fully successful sync.

**Session expired for Schedaero** — Quick sync will detect this and open the modal in cookie-only mode. Paste a fresh cookie from DevTools → Network → any Schedaero request → Request Headers → Cookie.

**Sync button shows "Upload Schedule"** — The pilot's `parser_type` may not be resolved correctly. Check that the pilot has a correct entry in `pilotParsers` (server.js) or in the DB.

**Reserve shows wrong location on map** — Reserve airport is set from `pilots.base`. Confirm the pilot's base is correct in the DB.

**Database locked** — Only one server instance should be running.

**Database reset**
```bash
rm dispatch.db
npm start
```
