# Crowded Skies

A private pilot scheduling and crew coordination web app. Tracks flight schedules for a group of pilots, shows live ADS-B positions, calculates location overlaps, and works as an installable mobile webapp.

**Production:** `http://167.71.107.245:3000`
**Pilot bookmarks:** see `PILOT_LINKS.md`

---

## Crew

| Key | Name | Airline | Parser | Base |
|-----|------|---------|--------|------|
| kyle | Kyle Kaestner | Corporate/135 | ICS (Schedaero) | KSUS |
| adam | Adam Burke | Republic Airways | CSV | LGA |
| sam | Sam Byrne | Republic Airways | CSV | LGA |
| logan | Logan Hine | SkyWest | CSV (SkyWest variant) | SFO |
| drew | Drew Sinelli | GoJet | PDF/Netline ICS | STL |

---

## Project Structure

```
├── server.js          # Express API + ADS-B polling + Schedaero sync
├── db.js              # SQLite init and schema
├── dispatch.db        # SQLite database (auto-created)
├── public/
│   └── index.html     # Full frontend (single file)
├── PILOT_LINKS.md     # Personalized bookmarks for each pilot
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
- **Calendar Grid** — monthly view with color-coded flights, DH, layovers, personal/commute flights
- **List View** — day-by-day chronological list with block times and layover durations
- **Route Map** — great circle arcs, live ADS-B trail, predictive arc for in-progress flights
  - *My Routes* — single pilot's month
  - *All Crew — Day* — all pilots on one map for a selected day
  - *All Crew — Month* — everyone's routes for the month, click route lines for details
- **Location Overlap** — shows when any two pilots are in the same city/airport

### Schedule Sync
- **Kyle** — Schedaero sync via saved API token + session cookie. Server pings Schedaero every 20 min to keep the session alive. One-tap sync from mobile once credentials are saved.
- **Drew** — RosterBuster ICS subscription URL, auto-fetched on sync
- **Adam / Sam / Logan** — CSV upload (drag-and-drop or file picker)

### Manual Flights
Add flights manually for any pilot in four categories:
- **Work** — revenue flight
- **Deadhead (DH)** — deadhead with airline lookup
- **Commute** — commute leg (amber color)
- **Personal** — personal travel (violet color)

Flight number lookup auto-fills times via OpenSky for DH, commute, and personal flights.

### Live ADS-B
- Polls ADS-B Exchange every 8 seconds for airborne aircraft
- Smooth Chaikin-algorithm trail rendering
- Trail seeded from OpenSky flight history on server start
- Green animated arc shows predicted path for active flights

### Mobile
- Installable as a home screen webapp (iOS Safari)
- Auto-selects pilot based on `?pilot=` URL parameter or last-used
- Bottom nav bar: Calendar, List, Map, Overlap, Upload
- Upload sheet includes one-tap Schedaero sync (Kyle) and Drew ICS sync

---

## Schedule Parsers

### Kyle — ICS (Schedaero)
`.ics` export from Schedaero. Parses `VEVENT` blocks with `SUMMARY` containing airport pairs and `DESCRIPTION` with tail/trip info.

### Adam & Sam — CSV (Republic/standard)
Required columns: `DATE, DEP, ARR, DEPTIME, ARRTIME`
Optional: `TAIL, DH, FCVTAIL, EQP, FLIGHT, BLOCK, CREW`

Times are local to the departure airport. Block time pulled from `BLOCK` column.

### Logan — CSV (SkyWest variant)
Flexible header matching — accepts `FLIGHTDATE|DATE`, `DEPARTURE|DEP|ORIG`, `DESTINATION|ARR|DEST`, `DEP_TIME|DEPTIME`, `ARR_TIME|ARRTIME`, `AIRCRAFT|TAIL`, `DH|DUTY`.

### Drew — PDF/Netline ICS
ICS subscription URL from RosterBuster stored on server, fetched on each sync.

---

## API Endpoints

```
GET  /api/pilots                              All pilots
GET  /api/pilots/:key                         Pilot + segments
POST /api/pilots/:key/upload                  Upload schedule file
POST /api/pilots/:key/add-segment             Add manual flight
PUT  /api/pilots/:key/segments/:id            Edit manual flight
DEL  /api/pilots/:key/segments/:id            Delete manual flight
DEL  /api/pilots/:key/segments                Clear all segments

POST /api/pilots/kyle/sync-schedaero          Sync one month (body: cookie, schedaeroUrl, apiToken, month, year)
POST /api/pilots/kyle/quick-sync-schedaero    Sync using saved server credentials (no body needed)
POST /api/pilots/drew/sync-ics                Sync Drew's ICS URL

GET  /api/live/:hex                           ADS-B position for aircraft hex code
GET  /api/flight-lookup                       Look up flight times via OpenSky (?flight=UA442&date=2026-05-18)

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
| pilot_key | TEXT UNIQUE | kyle, adam, sam, logan, drew |
| name | TEXT | |
| base | TEXT | Home airport ICAO |

### segments
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| pilot_id | INTEGER FK | |
| type | TEXT | flight, hard, away |
| departure_time | TEXT | ISO 8601, airport local |
| arrival_time | TEXT | ISO 8601, airport local |
| departure_airport | TEXT | IATA code |
| arrival_airport | TEXT | IATA code |
| tail | TEXT | Aircraft tail number |
| trip | TEXT | Trip number, or PERSONAL/COMMUTE for manual |
| flight_number | TEXT | |
| is_dh | BOOLEAN | Deadhead flag |
| is_manual | BOOLEAN | Manually added |
| block_minutes | INTEGER | |

### settings
Generic key/value store. Current keys:
- `schedaero-creds` — Kyle's Schedaero URL, token, cookie, month range
- `drew_ics_url` — Drew's RosterBuster ICS URL

---

## Troubleshooting

**Fields empty in Schedaero modal** — Has a successful sync been completed? Credentials are only saved after a fully successful sync.

**Session expired for Schedaero** — Quick sync will detect this and open the modal in cookie-only mode. Paste a fresh cookie from DevTools → Network → any Schedaero request → Request Headers → Cookie.

**Database locked** — Only one server instance should be running.

**Links not loading on mobile** — Confirm the device is reaching the production server at `167.71.107.245:3000`. Local network links (`192.168.1.x`) only work on the same WiFi.

**Database reset**
```bash
rm dispatch.db
npm start
```
