# CrewSync: Backend and admin

Current behavior only. Past bugs and why things were built this way: `CLAUDE_HISTORY.md`.

## Friends system

A real pilot can only see another real pilot's schedule once an **accepted, mutual** friendship exists between them (`friend_requests` table). **Admin alone is exempt** — sees every pilot unconditionally. Viewers are friend-gated too, same as real pilots, just admin-assigned instead of self-service (no self-service Friends UI for a viewer). This is a flat social graph, not org/tenant isolation — any pilot can send anyone a friend request; a pair counts as friends once an accepted row exists in either direction.

**Data model:** `friend_requests(requester_key, recipient_key, status)` — `UNIQUE` on the ordered pair, `status` is `'pending'` or `'accepted'` (no `'declined'` — a decline deletes the row). `pilots.friends_seeded` (one-time migration flag), `pilots.hidden_crew` (per-pilot explicit-hide list).

**Server-side (`server.js`):**
- `_resolvePilotToken(token, db, cb)` → `(pilot_key, role)`.
- `_canViewPilot(db, viewerKey, viewerRole, targetKey, cb)` — `true` if `viewerKey === 'admin'`, self, or an accepted friendship exists in either direction.
- `GET /api/pilots/:pilotKey` requires `?token=`; denied → `403 { error: 'not_friends', pilotKey, name }`.
- `GET /api/pilots` (admin user list) is admin-gated; returns `token` column, so admin-only matters.
- `GET /api/pilots-directory` — non-admin-gated, token-required listing (`pilot_key, name, base, home_airport, role, color`, no token) — used by the friends search UI and `_syncPilotRoster()`.
- Friend endpoints: `GET /api/friends`, `POST /api/friends/request` (auto-accepts on mutual-simultaneous-request), `POST /api/friends/respond`, `DELETE /api/friends/:key`, `POST /api/friends/seed` (one-time migration).
- `_unhideFromEachOther(db, keyA, keyB)` — called whenever a friendship newly becomes accepted, so a past unfriend's hide-flag doesn't persist across a later re-friend.
- `_getFriendsData` tags each entry with `isViewer` so the UI can label/filter viewer friends separately.
- Admin override endpoints: `GET /api/admin/friends/:pilotKey`, `POST /api/admin/friends`, `DELETE /api/admin/friends` (all admin-token-gated) — directly assign/remove friendships without request/accept.
- `GET /api/crew-visibility` / `PUT /api/crew-visibility` — token-gated, operate on the caller's own `hidden_crew`.

**Frontend (`app.html`):**
- `visiblePilotKeys()` — single source of truth for "which pilots can I actually fetch data for": `[...PILOT_KEYS]` for admin/viewer, or `[myPilot, ...myFriends]` (viewer friends filtered out) for a real pilot. Every bulk-fetch loop (`computeOverlap()`, `computeOffDays()`, grid-view prefetch) uses this, never raw `PILOT_KEYS`.
- `_pilotFetchUrl(key)` — appends `?token=` when `myToken` is set.
- `fetchPilotData()` → on `403 not_friends`, returns `{ __notFriends: true, pilotKey, name }`; `loadPilot()` renders `_renderNotFriendsState()` instead of an empty schedule.
- Friends UI lives in the Profile sheet (`#friends-section`, real-pilot-only): `renderFriendsPanel()` (friends list with inline visibility toggle + Remove, incoming/outgoing requests, viewer friends collapsed under "View Only · N"), `#add-friend-modal` + `renderFriendSearchResults()`.
- `_buildCrewVisibilityUI()` renders into `#crew-visibility-section`, shown for admin/viewer/demo only (`!!myPilot` hides it for a real pilot, whose equivalent control is inline in the Friends panel).
- `_hiddenCrew` (Set) loaded via `loadCrewVisibility()` inside `initIdentity()`; `getCrewVisible()` = `visiblePilotKeys().filter(p => p === myPilot || !_hiddenCrew.has(p))`.
- Friend request / accept / admin-connect all trigger notifications via `_notifyPilot()` + `pushToAll()` (badge: `#friend-badge-mobile`/`#friend-badge-desktop`). Not live-pushed to an already-open tab — only on page load or after your own action.

Full build history, every bug found/fixed along the way, and the security holes this uncovered: `CLAUDE_HISTORY.md § Friends system`.

## Crew roster page (`/crew-roster`)

Server-side HTML in `server.js` (~line 2068). Protected by `rosterAuth` middleware (password from env), admin only. Per-pilot card: initials avatar (viewers get 👁, blue bg), name/pilot_key/base/home_airport, last-active timestamp + colored dot.

**Last-active color scale:**

| Recency | Color | Label example |
|---|---|---|
| < 1 hour | `#22c55e` green | `3m ago` |
| 1–24 hours | `#84cc16` lime | `5h ago` |
| 1–3 days | `#eab308` yellow | `2d ago · Jun 26` |
| 3–7 days | `#f97316` orange | `5d ago · Jun 23` |
| > 1 week | `#ef4444` red | `Jun 15` |
| Never | `#52525b` gray | `Never` |

`last_active` updates whenever a pilot loads the app. `fmtActive()`/`activeColor()` live inside the route handler.

There's also a NetJets-specific lookup sub-page, `/crew-roster/netjets-lookup` — see "NetJets manual tracking" below.

## API endpoints (server.js)

```
GET  /api/pilots                          all pilots — admin-gated (token required, pilot_key==='admin')
GET  /api/pilots/:key                     pilot + all segments — token required, friend-gated
GET  /api/pilots-directory                non-admin-gated directory listing (no token column)
POST /api/pilots/:key/upload              upload schedule file — token required, admin-or-self
DELETE /api/pilots/:key/segments          clear all non-manual segments — token required, admin-or-self
POST /api/pilots/:key/add-segment         add manual segment — token required, admin-or-self
PUT  /api/pilots/:key/segments/:id        edit segment — token required, admin-or-self
DELETE /api/pilots/:key/segments/:id      delete segment — token required, admin-or-self
PUT  /api/pilots/:key                     update pilot profile — token required; admin or self only, self can't touch role
DELETE /api/pilots/:key                   delete pilot + segments — token required, admin only
POST /api/pilots/:key/regenerate-token    reissue login token — token required, admin only
POST /api/pilots/:key/sync-ics            trigger ICS sync — token required, admin-or-self
GET  /api/pilots/:key/ics-url             get stored ICS URL — token required, admin-or-self
POST /api/pilots/kyle/sync-schedaero      full Schedaero sync (Kyle only)
POST /api/pilots/kyle/quick-sync-schedaero  quick sync (Kyle only)
POST /api/early-landing                   report early landing
GET  /api/live-position                   live position for one callsign (SWIM/STDDS/ADS-B, accepts ?origin=)
GET  /api/flight-status                   batched live/airborne/parked/times for several callsigns (accepts ?origins=)
GET  /api/friends                         my friends + pending incoming/outgoing
POST /api/friends/request                 send friend request (auto-accepts on mutual-simultaneous)
POST /api/friends/respond                 accept/decline incoming request
DELETE /api/friends/:key                  unfriend
POST /api/friends/seed                    one-time crew→friends migration
GET  /api/crew-visibility / PUT ...       read/write caller's hidden_crew
GET  /api/admin/friends/:pilotKey         admin: any pilot's friends/incoming/outgoing
POST /api/admin/friends / DELETE ...      admin: directly assign/remove a friendship
GET  /api/intel / POST / PUT /:id / DELETE /:id / POST /:id/vote
GET  /api/notifications / PATCH /read
GET  /api/push/vapid-key / POST /api/push/subscribe
PUT  /api/pilots/:key/rotation            NetJets duty rotation (admin-or-self)
PUT  /api/pilots/:key/tour-tail           NetJets per-tour tail + start airport (admin-or-self)
GET  /api/health                          health check
GET  /admin/users                         admin user management page
GET  /api/pilots/:key/here-now            debug: HERE-NOW priority-chain reimplementation
```

## Admin panel (`openAdminPanel()`, ~line 8255)

Full-page takeover (`#admin-panel`), header with back arrow/title/"+ Add User", Users/Dashboard tab switcher (`switchAdminTab()`).

**Users tab**: `loadAdminUsers()` → `/api/pilots` → `renderAdminUserList()` as a responsive card grid, search box (`#admin-user-search` → `filterAdminUsers()`).

**Dashboard tab**: app stats — total segments, pilots, segments per pilot, last sync times.

**Edit/Add User modal (`#edit-user-modal`)**: view-only toggle (role='viewer', hides pilot-specific fields); airline selector determines `parser_type` (GoJet→`ics_rosterbuster`, SkyWest→`vcs_skywest`, Republic→`csv`, Sun Country→`ics_scx`, Atlas Air→`ics_ecrew`, Delta→`ics_delta_micrew`, American→`ics_american`, Southwest→`ics_southwest`, SpiritJets(corporate)→`schedaero`, NetJets(admin-only)→`manual_netjets`, Other→`other`); friends toggle list (`#edit-user-friends-section`); `saveUser()` → POST/PUT `/api/pilots`; after save alerts the generated `?u=TOKEN` personal link.

**`role` field** is optional, cosmetic metadata (Profile sheet subtitle + a small label on Crossings cards) — nothing in parsing/sync/access-control/friends reads it.

Full airline/parser-display-bug narrative: `CLAUDE_HISTORY.md § Admin panel`.

## Pilot roster is fully DB-driven — no hardcoded pilot config anywhere

The `pilots` table (including `color`) is the **only** source of truth for every pilot's config, including the original 5. `server.js` has no hardcoded parser/airline-code maps (`getParserForPilot()` is just `pilotRow?.parser_type || 'csv'`). `app.html`'s `PILOT_KEYS`/`PILOT_COLORS`/`PILOT_NAMES`/`PILOT_ROLES`/`PILOT_HOME` all start **empty** for a real session and are populated entirely by `_syncPilotRoster()` from `/api/pilots-directory`, called inside `initIdentity()` before any pilot-dependent UI builds. Pill bar/sidebar order is alphabetical by name (`ORDER BY name`) with the signed-in pilot's own pill always pinned first via `_reorderPilotPills()` — no insertion-order or hardcoded ordering anywhere. The 5 static sidebar/pill `<button>` elements and the `PILOT_HOMES`/`PILOT_CARRIER` client-side fallback objects were removed outright — every pilot (including the original 5) is rendered/resolved dynamically now. `AIRLINE_OPTIONS` has a real SpiritJets/Schedaero entry for Kyle so his profile has a stable, selectable match (not "Other"). `PILOT_HOME_AIRPORTS` (Kyle's dual SUS/STL) remains a deliberate, scoped hardcoded exception (see "Key constants" above) — the schema has no second-home-airport column.

**Self-service profile editing** (base / home airport / airline): `#my-info-section` (real pilots only) → `#edit-my-info-modal` → `openEditMyInfoModal()`/`_onMyInfoAirlineChange()`/`saveMyInfo()`, PUTs `/api/pilots/:pilotKey` (admin-or-self; a self-edit's SQL `UPDATE` omits the `role` column entirely, so a pilot can't grant themselves a role change through this path), then re-syncs ICS if a new URL was given and refreshes the view.

**Every schedule-mutation endpoint requires auth** (see API list above) — admin, or the pilot acting on their own data, enforced via `_resolvePilotToken`.

**A failed identity lookup never silently becomes admin.** `initIdentity()` retries a failed token lookup up to 3x (network error/5xx only, not a 4xx), and on total failure stops startup and shows `_showIdentityError()` instead of proceeding with `myPilot`/`myToken` left `null` (the same state the app treats as admin everywhere).

**Known, deliberately out-of-scope remainders**: Hunter's `parser_type` is still wrong (`ics_scx`, should be `ics_ecrew` — his `airline_code` is already correct, so this never affected his real parsed schedule, only display); `PILOT_HOME_AIRPORTS` remains hardcoded by design; `join.html`'s own airline list is separate/shorter and untouched (new-pilot signup, not existing-pilot editing).

Full three-places-duplicated-config story and the two security-hole discoveries: `CLAUDE_HISTORY.md § Pilot roster is fully DB-driven`.

## FRAT Autofill userscript (`public/frat-autofill.user.js`)

Tampermonkey userscript (Kyle only) that autofills PRISM SMS (`prismsms.argus.aero`) flight risk assessment reports from his CrewSync schedule: Date, Origin, Dest, Trip ID, PIC, SIC, Aircraft, TSA, and ~24 risk questions computed from schedule + `aviationweather.gov` + FAA NOTAM data. Served from `/frat-autofill.user.js` with `@updateURL`/`@downloadURL` pointing at prod for Tampermonkey auto-update.

**`@match` covers the whole `prismsms.argus.aero` origin**, not just the report URL — needed because PRISM is an Angular SPA using `history.pushState` navigation (full story: `CLAUDE_HISTORY.md § FRAT Autofill userscript`). The script patches `history.pushState`/`replaceState` + listens for `popstate`, idling via `isFratReportRoute()`/`isFratLandingRoute()` route checks.

**Full automated pipeline** (landing page → filled, saved report):
1. On `/tools/frat-landing`, shows the leg-select panel (`mode:'landing'`).
2. Picking a leg sets `_pendingFlight`; `triggerCreateReport()` clicks "Create Risk Assessment" + the template option in the dropdown.
3. The new report routes via pushState; the SPA-navigation watcher re-runs `main('report')`, finds `_pendingFlight`, fills immediately.
4. `saveReport()` clicks "Save as Pending" → "Yes", routing back to landing.
5. Any failed automated click preserves the pending flight and prompts a manual click — finishing manually still triggers auto-fill once the report opens.

`triggerCreateReport()` prefers the known static `#btn-frat-add` id over generic text search (see history for why). The leg-select panel's "dbg" button calls `debugDump()` — check console output there before assuming a selector is broken.

**Sends Kyle's real CrewSync login token** (hardcoded `const TOKEN`) since `GET /api/pilots/:key` requires `?token=`. **Known, accepted exposure**: the file is both committed to the public GitHub remote and served unauthenticated, so the token is effectively public — anyone who finds it can act as Kyle through the API, though not as admin or any other pilot. Regenerating the token via the admin panel both revokes this and requires updating this constant to match. Don't paste the literal token value anywhere else committed to the repo — reference it by name/location instead.

A non-200 schedule-fetch response logs the actual HTTP status + a response snippet (`@version 3.11`+) rather than failing silently.
