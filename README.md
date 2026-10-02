# CrewSync

A private pilot scheduling and crew coordination web app. Tracks flight schedules for a group of pilots, shows live ADS-B positions, calculates location overlaps, and works as an installable mobile webapp.

---

## Project Structure

```
├── server.js          # Express API + parsers + auto-sync scheduler
├── db.js              # SQLite init and schema
├── dispatch.db        # SQLite database (auto-created)
├── airports.dat       # OpenFlights airport database (coords + timezones)
├── data/              # airports.json (city labels) + airports_raw.csv (OurAirports source)
├── scripts/           # build-airports.js, gen-icons.js, import-intel.js
├── public/
│   ├── app.html       # Main app (calendar, map, list, overlap, intel) -- single file, all JS inline
│   ├── join.html      # New pilot onboarding form
│   ├── landing.html   # Public landing page
│   ├── manual.html    # User manual / help page
│   ├── airports.json  # Client-side airport coordinate lookup
│   └── frat-autofill.user.js  # Tampermonkey userscript (Kyle only) -- see CLAUDE.md
└── README.md
```

See `CLAUDE.md` for the full, actively-maintained technical reference (data flow, every parser's quirks, the friends/visibility system, live-tracking internals, etc.) -- this README is a lighter overview.

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
- **Crew Planning** — two tabs:
  - *Crossings* — shows when any two pilots are in the same city/airport at the same time
  - *Off Days* — finds days every selected pilot is simultaneously off, list or calendar view
- **Crew Intel** — crowd-sourced hotel/food/activity/tip entries per airport, with upvote/downvote and map view

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

### Live Route Detail (FAA SWIM)
- For a tracked live flight, the remaining route (dashed plane→next-fix, solid fix-to-fix, dashed last-fix→destination) is resolved from real FAA data feeds (SFDPS/STDDS/TFMS/TFDM) and FAA NASR navigation data, not just a straight line between departure/arrival
- **✦ RTE** toggle shows/hides named route points (VOR/fix/RNAV waypoint) using real chart symbology (hexagon/triangle/four-point star); labels appear progressively with zoom, symbols always show
- A small green VCI-style glyph next to a live flight's label marks a position confirmed via real SWIM data rather than the public ADS-B fallback
- See `CLAUDE.md`'s "FAA SWIM integration" section for the full pipeline (route string parsing, NASR fix/procedure/airway resolution, runway-aware SID/STAR body selection)

### Mobile
- Installable as a home screen webapp (iOS Safari)
- Pilot identity resolved from personalized link
- Bottom nav bar: Calendar, List, Map, Overlap, Upload/Sync
- One-tap sync for ICS pilots; upload for CSV/VCS pilots

### Identity & access
Three kinds of logged-in identity, resolved from a URL token (`?u=TOKEN`):
- **Pilot** — sees their own schedule plus any pilot they've friended (mutual, accepted request required)
- **Viewer** — a read-only guest account; also friend-gated, but admin-assigned only (no self-service request/accept UI)
- **Admin** — sees everyone unconditionally, manages users/parsers/friendships from the admin panel

A pilot or viewer only sees another pilot's schedule once an accepted friendship exists between them — sent/accepted via the Friends panel (pilots) or assigned directly by admin (viewers, or as an override for pilots). Friend request/accept events generate in-app notifications (bell icon + a small badge on the profile avatar for pending requests).

### Notifications
- In-app notification bell with unread badge; crossing alerts and friend-request events land here
- Web Push supported (requires HTTPS for the service worker to register — not active until the app is served over SSL)

---

## Schedule Parsers

Every pilot has a `parser_type` in the DB that determines which parser runs on upload/sync — set via the admin panel's Airline/Operator dropdown (or the pilot's own self-service "My Info" editor), which maps a real company name to the actual `parser_type` string. Listed below by company, with each one's real `parser_type` value and which current pilots use it (so "what is the blank CSV one" has a concrete answer instead of a guess).

### Republic Airways — `parser_type: 'csv_republic'`
Required columns: `DATE, DEP, ARR, DEPTIME, ARRTIME`. Optional: `TAIL, DH, FCVTAIL, EQP, FLIGHT, BLOCK, CREW`. Times are local to the departure airport; block time pulled from the `BLOCK` column. Currently used by Adam and Sam. (Renamed 2026-10-02 from the bare `'csv'` — it was always Republic's format specifically, never a generic catch-all, and the bare name made that easy to mistake; an unset `parser_type` now defaults to `'other'` instead of silently assuming Republic's exact column layout.)

### SkyWest Airlines — `parser_type: 'vcs_skywest'`
SkyWest SkedPlus+ `.vcs` export (quoted-printable encoded). Parses day headers and flight leg lines from `DESCRIPTION`. Reserve types (RE2) mapped to `type: reserve`; training pairings (IOE, TRN, and similar prefixes) supported. Currently used by Logan and Ben.

**`parser_type: 'csv_skywest'` is a separate, legacy parser for an older SkyWest CSV export format — the code (`parseCSV_skywest`, server.js) still exists, but no current pilot uses it and the admin dropdown no longer offers it as an option.** Flexible header matching: `FLIGHTDATE|DATE`, `DEPARTURE|DEP|ORIG`, `DESTINATION|ARR|DEST`, `DEP_TIME|DEPTIME`, `ARR_TIME|ARRTIME`, `AIRCRAFT|TAIL`, `DH|DUTY`.

### GoJet Airlines — `parser_type: 'ics_rosterbuster'`
ICS subscription URL from RosterBuster, fetched on each sync. Currently used by Drew.

### Atlas Air — `parser_type: 'ics_ecrew'`
### Sun Country Airlines — `parser_type: 'ics_scx'`
Both use the same underlying AIMS eCrew parser (`parseECrewICS`), parameterized by airline code (`GTI` for Atlas, `SCX` for Sun Country) — the dropdown just offers two separate airline entries pointing at one shared parser. ICS subscription URL from calendar publish; each `VEVENT` is a duty period, with individual legs parsed from `DESCRIPTION`:
- **Reserves** (RESR/RESP/RESA): `type: reserve`, airports from `LOCATION` field
- **Operating flights** (numeric codes): `type: flight`, `dh: false`
- **Deadhead flights**: `type: flight`, `dh: true`
- **Own-ticket deadhead** (OWN####): `type: flight`, `dh: true`, no flight number stored
- **Ground transport** (GRND####): `type: ground`, stored for map location tracking only
- **RAP / same-airport legs**: skipped

Each airport's timezone is resolved from `airports.dat` for accurate UTC conversion of local leg times. Currently used by Brett (Sun Country) and Hunter (should be Atlas/`ics_ecrew`, but his profile is currently mis-set to `ics_scx` — a known, not-yet-fixed data entry error; his `airline_code` of `GTI` is already correct, only `parser_type` is wrong).

### Delta Air Lines (MiCrew) — `parser_type: 'ics_delta_micrew'`
Currently used by Mark. See `CLAUDE.md` for the full parser detail (multi-day pairings in one `VEVENT`, deadhead/reserve detection, leg-line prefix letters).

### American Airlines (MobileCCI) — `parser_type: 'ics_american'`
One `VEVENT` per leg (not per pairing, unlike the others). No current pilot uses this one yet. Reports unrecognized schedule items back to admin as warnings (`pilots.parser_warnings`) rather than silently dropping them — see `CLAUDE.md`.

### Southwest Airlines (CrewHub) — `parser_type: 'ics_southwest'`
Multi-day pairings like Delta's, but with a timezone abbreviation on every leg instead of airport-timezone lookup. No current pilot uses this one yet. Also reports parser warnings to admin.

### Kyle's SpiritJets (Corporate, Part 91/135) — `parser_type: 'schedaero'`
Not a generic ICS/CSV parser at all — Schedaero has its own dedicated sync endpoints (`POST /api/pilots/kyle/sync-schedaero` / `quick-sync-schedaero`) and admin-panel modal, gated purely on `parser_type === 'schedaero'`. Kyle only.

### Other / unrecognized — `parser_type: 'other'`
No airline selected, or a format that doesn't match any of the above. On first upload, `autoDetectParser()` sniffs the file and tries to match it to a known format; if it can't, the pilot's upload is rejected with a message to contact admin rather than silently mis-parsed. This is also where a bare, unlabeled `.ics`/`.csv` would fall through to the generic `parseICS()`/`parseCSV()` functions — not tied to any specific real airline today.

---

## API Endpoints

All endpoints below that touch a specific pilot's data require `?token=` (or `{token}` in the body), resolved to a `(pilot_key, role)` pair server-side. "Admin only" / "self or admin" notes indicate the actual access check, not just presence of a token.

```
GET  /api/pilots                              All pilots incl. tokens -- admin only
GET  /api/pilots-directory                    Name/base/home/role/color, no tokens -- any authenticated pilot
GET  /api/pilots/:key                         Pilot + segments -- self, admin, or an accepted friend (403 not_friends otherwise)
PUT  /api/pilots/:key                         Update pilot profile -- self or admin (self can't change role)
DEL  /api/pilots/:key                         Delete pilot -- admin only
POST /api/pilots/:key/regenerate-token        Reissue login token -- admin only
GET  /api/pilots/:key/ics-url                 Get stored ICS URL
POST /api/pilots/:key/upload                  Upload schedule file (.ics, .csv, .vcs)
POST /api/pilots/:key/sync-ics                Sync ICS URL (saves URL, then fetches)
POST /api/pilots/:key/add-segment             Add manual flight
PUT  /api/pilots/:key/segments/:id            Edit manual flight
DEL  /api/pilots/:key/segments/:id            Delete manual flight
DEL  /api/pilots/:key/segments                Clear all non-manual segments
POST /api/pilots/kyle/sync-schedaero          Full Schedaero sync (Kyle only)
POST /api/pilots/kyle/quick-sync-schedaero    Sync using saved credentials (Kyle only)

GET  /api/friends                             My friends + pending incoming/outgoing
POST /api/friends/request                     Send a friend request (auto-accepts a mutual simultaneous request)
POST /api/friends/respond                     Accept/decline an incoming request
DEL  /api/friends/:key                        Unfriend
GET  /api/admin/friends/:key                  Any pilot's friends -- admin only
POST /api/admin/friends                       Directly create an accepted friendship -- admin only
DEL  /api/admin/friends                       Directly remove a friendship -- admin only
GET  /api/crew-visibility                     My hidden-pilot list
PUT  /api/crew-visibility                     Update my hidden-pilot list

GET  /api/notifications                       My notifications
PATCH /api/notifications/read                 Mark all read
POST /api/notifications/crossing              Broadcast crossing notifications (called after upload/sync)
GET  /api/push/vapid-key                      Public key for Web Push subscription
POST /api/push/subscribe                      Save a push subscription
DEL  /api/push/subscribe                      Remove a push subscription

GET  /api/intel                               Crew Intel entries (hotel/food/activity/tip)
POST /api/intel                               Add an entry
PUT  /api/intel/:id                           Edit an entry
DEL  /api/intel/:id                           Delete an entry
POST /api/intel/:id/vote                      Upvote/downvote an entry

GET  /api/live-position?callsign=XX           Live ADS-B position for a callsign (polled every 8s client-side)
POST /api/early-landing                       Report an early landing
GET  /api/early-landings?date=YYYY-MM-DD      Callsigns confirmed landed early for a date

GET  /api/settings/:key                       Read a server-side settings value
POST /api/settings/:key                       Write a server-side settings value
GET  /api/health                              Health check
GET  /api/version                             App version

GET  /demo                                    Read-only demo with fake pilots -- no login required
GET  /crew-roster                             Server-rendered pilot roster + personal links -- password-protected, admin
GET  /admin/users                             Admin user management page
```

Not exhaustive — see `server.js` for the full route list (airport lookups, analytics, NOTAMs, a few debug/legacy endpoints).

---

## Database Schema

### pilots
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| pilot_key | TEXT UNIQUE | Short identifier for each pilot |
| name | TEXT | |
| base | TEXT | Crew base (airline domicile) |
| home_airport | TEXT | Where the pilot actually lives (may differ from base) |
| role | TEXT | Optional cosmetic text (e.g. "Regional · STL"), **or** the literal string `'viewer'` marking a read-only guest account -- not a rank/seat designation |
| parser_type | TEXT | `csv`, `csv_skywest`, `vcs_skywest`, `ics`, `ics_rosterbuster`, `ics_ecrew`, `ics_scx`, `ics_delta_micrew`, `ics_american`, `ics_southwest`, `schedaero`, `other` |
| airline_code | TEXT | IATA/ICAO airline code |
| color | TEXT | Hex color for map/legend/avatar display |
| token | TEXT | URL token for personalized bookmark — the sole auth mechanism, no passwords |
| hidden_crew | TEXT | JSON array of pilot_keys this pilot has explicitly hidden from their own calendar/map |
| friends_seeded | INTEGER | One-time flag: has this pilot's pre-friends-system "Your Crew" toggle been imported as a starting friend list? |
| parser_warnings | TEXT | JSON array of unrecognized items from the last parse (American/Southwest parsers only), surfaced to admin |
| last_active | TEXT | ISO timestamp of last app access |

### friend_requests
One row per pilot pair. `status` is `'pending'` or `'accepted'` (a decline just deletes the row). A pair counts as friends once an accepted row exists in either direction. Gates `GET /api/pilots/:key` — a pilot (or admin-managed viewer) can only see another pilot's schedule once this relationship exists; admin is exempt.
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| requester_key | TEXT | |
| recipient_key | TEXT | |
| status | TEXT | `pending` or `accepted` |
| created_at / responded_at | DATETIME | |

### notifications
In-app notification feed (friend requests/accepts, crossing alerts). `crossing_key` dedupes crossing notifications; left `NULL` for other types.

### push_subscriptions
Web Push subscription objects per pilot, for the notification bell's push delivery (requires HTTPS to actually activate).

### crew_intel / intel_votes
Crew Intel entries (hotel/food/activity/tip per airport) and one vote row per `(intel_id, pilot_key)` for the upvote/downvote system.

### usage_events
Lightweight event log for feature-adoption tracking (`POST /api/analytics`).

### segments
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| pilot_id | INTEGER FK | |
| type | TEXT | `flight`, `reserve`, `ground`, `hard`, `vacation`, `training` (personal/commute travel is `type: 'flight'` with `trip: 'PERSONAL'`/`'COMMUTE'`, not a separate type) |
| departure_time | TEXT | **Local airport time, no timezone suffix** for most pilots (e.g. `2026-05-26T13:30:00`) — only Kyle's Schedaero feed stores true UTC (`Z` suffix). Never compare raw `new Date(string)` across pilots; use `flightUTCTime()`/`flightLocalDate()` client-side. |
| arrival_time | TEXT | Same local-time convention as `departure_time` |
| departure_airport | TEXT | IATA or ICAO code depending on source feed |
| arrival_airport | TEXT | IATA or ICAO code depending on source feed |
| tail | TEXT | Aircraft tail number |
| trip | TEXT | Trip/pairing number, or `'PERSONAL'`/`'COMMUTE'` for those flight types |
| flight_number | TEXT | |
| is_dh | BOOLEAN | Deadhead flag |
| is_manual | BOOLEAN | Manually added/edited — excluded from auto-sync's delete-and-replace |
| block_minutes | INTEGER | |

### settings
Generic key/value store for server-side configuration (sync URLs, credentials, app settings).

---

## Troubleshooting

**Fields empty in Schedaero modal** — Has a successful sync been completed? Credentials are only saved after a fully successful sync.

**Session expired for Schedaero** — Quick sync will detect this and open the modal in cookie-only mode. Paste a fresh cookie from DevTools → Network → any Schedaero request → Request Headers → Cookie.

**Sync button shows "Upload Schedule"** — The pilot's `parser_type` is purely DB-driven (`pilots.parser_type`) — there's no hardcoded fallback table anywhere in the code anymore. Check/fix it via the admin panel's Edit User modal, or the pilot's own self-service "My Info" editor.

**Reserve shows wrong location on map** — Reserve airport is set from `pilots.base` at parse time and baked into the segment — changing `base` afterward does **not** retroactively update already-stored reserve segments. Re-sync (ICS pilots) or re-upload (file-upload pilots) to pick up the new base, or patch the existing rows directly.

**A pilot can't see another pilot's schedule** — They need an accepted friendship first (Friends panel in the Profile sheet, or ask admin to connect them directly via the Edit User modal). A `403 { error: 'not_friends' }` response is expected and correct in this case, not a bug.

**New viewer can't see anyone** — Viewers are friend-gated too (admin-assigned only, no self-service). A newly created viewer starts with zero access until admin grants it via the Edit User modal's friend toggle list.

**Database locked** — Only one server instance should be running.

**Database reset**
```bash
rm dispatch.db
npm start
```
