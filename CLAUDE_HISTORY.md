# CrewSync — Development History

This file holds the chronological "how we got here" narrative that used to live inline in CLAUDE.md: dated investigations, "confirmed live" findings, bugs found and fixed, things tried and reverted. CLAUDE.md itself now only describes current behavior. Sections here are organized to match CLAUDE.md's own headings, so "find the history for topic X" means searching this file for the same heading.

---

## Friends system — full history

Added 2026-10-01, replacing "every pilot sees every other pilot's schedule" (the original design). Built as a flat social graph (not org/tenant isolation) deliberately simpler than a multi-tenancy idea floated earlier in planning.

**Mutual simultaneous request → instant friends.** If Bob requests Alice (pending) and Alice separately requests Bob before Bob responds, `POST /api/friends/request` recognizes Alice is the *recipient* of an existing pending row and upgrades it straight to `accepted` instead of creating a crossed second pending row. Verified directly: Bob→Alice returned `"status":"pending"`, the immediate Alice→Bob returned `"status":"accepted"`.

**Migration — importing the old "Your Crew" toggle as a starting friend list.** The pre-existing crew-visibility toggle (`getCrewVisible()`/`_visKey()`) was client-side only, stored in `localStorage`, never synced to the server — so there was no server-side record of "who a pilot currently considers their crew" to seed friendships from directly. `_maybeSeedFriends()` runs once per pilot on login: reads the *raw* stored `crewVisible_<pilot>` array directly from `localStorage` (bypassing `getCrewVisible()` itself, which filters down to `visiblePilotKeys()` — at seed time that's just `[self]`) and POSTs those keys to `POST /api/friends/seed`, creating already-accepted friendships directly. Guarded by `pilots.friends_seeded` so it only ever runs once per pilot. One real constraint accepted deliberately: since this reads from the *visiting* pilot's own browser, a relationship only gets seeded once that specific pilot opens the app post-migration — if only Pilot A ever opens the app, the seed still creates an accepted friendship unilaterally (not a request A's side waits on B to approve).

**Admin override.** Added 2026-10-01 so admin can manage the social graph without needing both pilots to act. Verified end-to-end against the real endpoints with throwaway test pilots: assign, the pending-upgrade path, read-back, and remove all behave correctly; a non-admin token correctly 403s.

**Crew visibility is server-persisted, and defaults to visible (changed 2026-10-01).** Two problems reported together after the friends system shipped: (1) toggling a friend's visibility on desktop didn't show up on mobile for the same pilot, and (2) "since we're on a friends model now, a new friend should default to visible, not require a second manual toggle." Both came from the same root design: crew visibility used to be a localStorage-only preference, storing the list of who's *visible*, defaulting to "just yourself." That's inherently per-browser (cause of #1) and meant every new friend started hidden until manually turned on (cause of #2). Fixed by flipping both the storage layer (now `pilots.hidden_crew`, server-persisted, storing *explicitly hidden* keys) and the default. Removed the now-obsolete "Your crew is hidden" one-time nudge banner entirely — with the new default of "everyone on," the zero-visible state it watched for can no longer occur. Verified against the real endpoints on a local test server: `GET` before any write returns `{hidden:[]}`; `PUT` with a key persists and reads back correctly; both reject with 401 for a missing/invalid token.

**Verified against the real HTTP endpoints** (not just read through), with throwaway test pilots on a local server: a non-friend fetch 403s with `not_friends`; `GET /api/pilots` 401s with no token and 403s for a non-admin token; the directory endpoint works for any authenticated pilot; send → pending → accept → both sides can now see each other; unfriend correctly revokes access both ways; the mutual-simultaneous-request auto-accept; and the seed migration adds exactly the given keys once, then no-ops on a second call.

**Startup-ordering bug (fixed 2026-10-01) — friend-based UI built before the roster synced.** `initIdentity()` used to call `_applyIdentityUI()` (which calls `_buildCrewVisibilityUI()`) before `_syncPilotRoster()` had run. `_buildCrewVisibilityUI()` indexed `PILOT_NAMES[friendKey]` with no fallback — for any pilot whose friend list includes a non-core/newly-joined pilot, this threw `undefined` before that pilot was registered, aborting the rest of `initIdentity()` and the rest of the `DOMContentLoaded` handler (uncaught rejection on an unguarded `await`), so `loadPilot(defaultPilot)` never ran — the pilot's own schedule silently failed to auto-select on load, and every later call to `_applyIdentityUI()` kept throwing the same way, so clicking the "Signed in as" button did nothing, permanently, for the rest of that session. Admin/viewer never hit this (their `visiblePilotKeys()` is just the hardcoded `PILOT_KEYS`, always already registered). Fixed two ways: root cause (`_syncPilotRoster()` now called inside `initIdentity()` itself, before `loadFriends()`/`_applyIdentityUI()`) and defense-in-depth (`_buildCrewVisibilityUI()` now falls back to the raw pilot key instead of indexing an unregistered name).

**Viewers are friend-gated too (2026-10-01, same day).** A view-only guest used to be completely exempt from the friends system. `_canViewPilot` no longer auto-exempts `role === 'viewer'`. Deliberately admin-assigned only, no self-service. Migration for existing viewers (Nick, Jack, Sandy, Antoine) seeded each an already-accepted friendship with every real pilot at migration time, preserving current access exactly — a viewer created after this migration starts with zero friends.

**Viewers leaked into real pilots' own friends list / map legends (fixed same day).** Friendship is symmetric once accepted, so the migration's viewer→pilot edges also showed up on the pilot's side: a real pilot's own `GET /api/friends` returned every viewer friended with them. Since viewers are deliberately never registered into `PILOT_NAMES`/`PILOT_COLORS` client-side, this rendered as a nameless, generic-gray entry anywhere a pilot's friend list fed UI. Fixed in two layers: `_getFriendsData` tags each friend entry with `isViewer`, and `visiblePilotKeys()` filters out `isViewer` friends before building the crew list that feeds map/legend/prefetch consumers (the Friends panel itself still shows a friended viewer, just labeled, since `renderFriendsPanel()` reads `myFriends` directly, unfiltered). The first attempt at this fix excluded viewers from `_getFriendsData`'s result outright, which also fixed the legend leak but silently hid real connections from the Friends panel — moving the filter down to `visiblePilotKeys()` specifically was the correction.

**Re-friending someone kept them hidden from a past unfriend (fixed same day).** `removeFriend()` explicitly hides the unfriended person, but nothing ever reversed it — re-friending later left them silently toggled off. Fixed with `_unhideFromEachOther(db, keyA, keyB)`, called for both parties whenever a friendship newly becomes accepted.

**Friends panel ↔ crew-visibility UI merged for real pilots (2026-10-01).** The Friends panel and the separate "Your Crew" visibility section listed the exact same set of people in two places. Combined into one row per friend in `renderFriendsPanel()`.

**`setCrewVisible()` toggle only worked once per Profile-sheet open (fixed same day).** It refreshed `_buildCrewVisibilityUI()` after a change, but for a real pilot the actual visible toggle lives inline in `renderFriendsPanel()`'s rows now — that function was never called, so clicking a second time just re-sent the same value. Fixed by adding the missing `renderFriendsPanel()` call inside `setCrewVisible()`.

---

## Crossings pipeline — history notes

The "stay until next flight" no-cap rule and the commuter 3h-home-assumption were added 2026-10-04ish, confirmed live and explicitly requested: "we just assume he's gone until a new flight segment, except for commuter returns." An earlier attempt to exclude personal trips from location inference (`allDeps`) was built, shipped, and then fully reverted — personal travel is real travel and should move the pilot's known location like any other flight. Reserve windows being included as ground periods is a clarification of older docs that incorrectly described reserve as unhandled.

The perf fix for `computeOverlap()`/`computeOffDays()` needing a real paint yield before heavy work — forcing `await new Promise(r => setTimeout(r, 0))` right after setting the spinner HTML — was needed because opening the Overlap view felt like it hung before the view even appeared, due to the `await Promise.all(...)` resolving via microtasks with no macrotask boundary when every pilot was already cached.

---

## "Here Now" / pilot location pins — history notes

**Step 5 "last known location" folding in reserve shifts (fixed 2026-10-08).** Found live: Logan's last logged *flight* arrival was 11 days old at an airport that wasn't even his base anymore, but he'd worked two reserve shifts at his real current base since then — without folding reserve in, he stayed pinned at that stale arrival indefinitely, labeled "Overnight."

**Mid-trip "quick turn" measured from the arrival, not "now" (fixed 2026-10-08).** Used to measure `nextDepUTC - now` instead of `nextDepUTC - lastArrUTC` — a commuter who landed at base, had days to go home, and simply had their next departure creep inside the 18h window got relabeled "Overnight at base" purely because of how close "now" happened to be to that departure. Found live: Adam landed at LGA, next departure wasn't for ~2.5 days, but ~14h before it he started showing "Overnight at LGA" instead of "Home" in Tulsa.

---

## RosterBuster ICS parser — history notes

Reserve (`🛰`) support didn't exist until 2026-09-21 — Drew had 5 upcoming "Long Call Reserve" blocks completely invisible in CrewSync because they never made it past the flight-only match. Found by fetching the raw feed and diffing every line against what the regex matches, not by assuming.

## Delta "MiCrew" ICS parser — history notes

Added 2026-09-30, built against one real Delta pilot's feed before he had a CrewSync account. The `blockMinutes` timezone-math bug and the `syncPilotICS()` hardcoded-null bug were both found live: a pilot (Mark, Delta) re-synced after the parser fix shipped and still saw wrong block times, which is what exposed the second, deeper bug (the write path discarding the correctly-computed value). Lesson stated explicitly: a parser returning the right data isn't the same as that data reaching the database. The `O`-prefix, `I`-prefix, missing-equipment, and `G 0000` ground-leg gaps were all found by fetching the raw feed directly and diffing every leg-shaped line against the parser's regex, across the pilot's *entire* feed history, not just the reported missing date.

## American Airlines "MobileCCI" parser — history notes

Added 2026-10-01, built against one real pilot's export.

## Southwest Airlines "CrewHub BYO" parser — history notes

Added 2026-10-01, built against one real pilot's export. Two skip cases (`RPRT` report marker, blank-time equipment-swap artifact) were both found in one real sample trip.

## Parser warnings system — history notes

Scoped deliberately to just American + Southwest, not a system-wide refactor, since extending it to the other parsers "would be a reasonable next step — not done yet."

---

## Calendar grid rendering — history notes

**Perf gotcha, `innerHTML +=` in the day loop** — caused a reported lag swiping between months on mobile (O(n²) re-serialize/re-parse). Fixed by accumulating into a local string and assigning once.

**Auto-scroll to a live leg (2026-10-01)** — had to be deferred to `requestAnimationFrame`; calling `scrollIntoView` synchronously right after the `innerHTML` assignment measured against a layout the browser hadn't committed yet and silently did nothing — confirmed live, shipped broken first, fixed in a follow-up commit.

**Overnight/red-eye indicator (2026-10-01)** and its extension to reserve shifts crossing midnight (2026-10-11) — the native `title=` attribute was tried and found to visibly collide with the app's own custom tooltip; don't use it on `.flight-item`.

---

## ADS-B live tracking — full history

**Adaptive poll cadence (added 2026-10-02)** — requested directly: taxiing and landing/initial-climb both involve rapid changes the flat 8s cruise cadence rendered as a choppy trail. `finishTracking()` needed a `_pollerStopped` flag because the self-rescheduling loop (switched from `setInterval`) would otherwise revive a poller that was just supposed to stop — a failure mode a plain `setInterval` never had.

**Live-tracking reliability fixes (2026-10-01/02) — several bugs in the same ~150 lines**, all found live and confirmed against real in-progress flights (Drew's GJS4577/GJS4552, Mark's DAL2011):

- **Flight marked "LANDED EARLY"/"COMPLETED" while genuinely still airborne.** `hasBeenAirborne` was conflating two different lifetimes (poller-local first-confirmation vs. server historical knowledge). A miss response with `d.hasBeenAirborne: true` flipped the local flag before the plane was ever actually found by *this* poller, skipping the "first confirmation" cleanup block. Fixed by splitting into `hasBeenAirborne` (strictly poller-local) and `serverConfirmedAirborne`.
- **Static scheduled-route line never removed once the plane appeared** — direct consequence of the above.
- **Dashed remaining-arc flickered off and back on** — miss-handling removed it on the very first missed poll with no threshold; now requires `missCount >= 3`.
- **A flight with a genuine ADS-B signal gap got declared "landed" too eagerly** — confirmed live: Drew's real ICT→IAH flight went around weather, lost signal >40s, got marked landed while still flying. Threshold now scales with proximity to scheduled arrival.
- **Stale trail from a previous leg bled into a new flight's live map** — fixed with `_hexToCallsign`: a changed callsign on the same hex is treated as an unambiguous "new leg" signal.
- **Duplicate live-tracking arcs from overlapping map renders** — surfaced specifically when pilot data isn't already cached; the real network fetch opens a wide enough async window for two render passes to interleave. Fixed with `_liveLayersByCallsign`.
- **One flight's cleanup nuking every other live flight** — confirmed live: two unrelated live flights (Drew's and Mark's) disappeared and restarted simultaneously the instant either poller gave up, looking like a shared ADS-B outage but actually one flight's cleanup calling the global `renderMap()`. Fixed with `finishTracking()`, scoped to one flight.
- **`isPositionOnRoute()` froze the live display on a real weather deviation** — the old 25% slack was too tight for short regional hops. Confirmed live: Drew's real ICT-IAH flight deviated for weather and exceeded the ~135mi the old 25% allowed. Fixed with a 300mi floor.

## Route overlap on `renderMap()` — tried and reverted, full history

A fix was built and shipped (2026-09-21/22) and then reverted (2026-09-23) after it made the map actively worse. `computeRouteDeclutterOffsets()` sampled each route's interior, flagged conflicts within 110mi, and unioned them into clusters via BFS connected-components. Worked against small hand-built test cases but broke badly against Kyle's actual "My Routes" data: the BFS treats conflict as transitive, so around a busy hub this chains into large clusters with wild, unreadable loops (arcs sweeping up into Canada with no business being there). Never tested against a real multi-destination hub before shipping. If revisited: don't reuse transitive clustering; consider pairwise-only offsetting, an absolute magnitude cap, or scoping offset to actual interior overlap. Test against Kyle's real live route data, not a hand-picked 3-leg trip.

---

## FAA SWIM integration — full history

Three backend modules (`swim.js`/`stdds.js`/`tfms.js`, plus `tfdm.js` added later) built from scratch against real production SWIM credentials, starting 2026-10-02.

**Two separate relevance windows (split 2026-10-02).** `runActiveFlightPoller` used to compute one `polled` set and hand it to both the real ADS-B calls and all four SWIM-family `setRelevantCallsigns()` calls — wrong for two opposite reasons: ADS-B costs a real rate-limited call so its window should stay tight; SWIM is a push stream with no per-check cost and flight plans are commonly filed well before departure — raised directly: "I'd think the flight plan information could start sending preflight." Now two separate windows drive two independently-computed sets.

**Route resolution** — the airway sub-sequence resolution was never actually tested against a real route as of the note being written; every real route exercised so far only hit that path after ATC had already shortcut past the airway-heavy portion.

**Preflight route display (added 2026-10-02)** — requested directly, deliberately short (30min window) "so a flight hours or days out doesn't show 'all the route BS' (verbatim)."

**Click target bug (fixed 2026-10-14)** — the detailed preflight route was only clickable at one spot. Root cause: `removeArc()` only removed the *visible* arc, not the separate wide invisible hit-line layer, which kept tracing the *old* straight-line path. Confirmed live on Sam's JFK-CVG preflight route.

**Real ATC frequency via VATSIM's vNAS (added 2026-10-02)** — requested directly. First confirmed SFDPS has no frequency field at all (checked against real captured messages); found VATSIM's vNAS data API instead, confirmed directly against the live API (ZID sector 21 → `IND_21_CTR` at 124.625 MHz, matching reality). Defaulted off originally, changed to default on 2026-10-14 (requested directly) to match Route Detail's pattern. **Instant toggle repaint** needed `_liveLabelRefreshers` — confirmed live the toggle felt laggy/broken without it, since the plane's label HTML is rebuilt inside each flight's private closure with no shared marker set to sweep externally.

**Temporary test infrastructure** — `POST /api/debug/seed-route` + `swim._testSeedRoute()`, still in use as of the note (per-session testing ongoing).

**Route/trail persistence across restarts (added 2026-10-02)** — requested directly after a real incident: restarting the server used to wipe all in-memory SWIM state, confirmed live on a real deploy restart (SWA3492's already-resolved route disappeared mid-flight). Renamed `.swim_trail_cache.json` → `.swim_state_cache.json`. Verified directly: seeded a fake cache file, required the module fresh, confirmed the route (including `resolvedPath`) restored correctly and a deliberately-stale entry did not. TFMS/TFDM state is deliberately NOT persisted — only SWIM's route/trail, since neither was the subject of the actual complaint.

**Local dev server contending with prod for the same SWIM session (confirmed 2026-10-02)** — a live flight (SWA133) was observed flapping `source` between `swim` and ADS-B. Root cause: a leftover `node server.js` process still running locally with the same `.env` SFDPS credentials/queue — the FAA SFDPS queue binding only tolerates one consumer. Confirmed by killing the stray process: `source` immediately stabilized. **Never leave a local dev server running with real SWIM credentials while prod is also live-tracking.**

**TFMS airport-configuration (APTC) runway fallback (added 2026-10-02)** — asked directly: is there a feed showing an airport's general runway flow as a fallback? A first capture pass caught 20 samples of the wrong `fiOutput` subtype (`TMI_FLIGHT_LIST`); a second pass narrowed to catch 20 real APTC samples across 20 airports. Verified live: `GET /api/debug/tfms-aptc/:code` returned real, fresh JFK data shortly after deploy. **Third fallback tier (added 2026-10-14)** — confirmed live: DAL788 arriving DTW had no arrival-runway signal from either TFDM or TFMS's `arrRunwayConf`, so it fell to the arbitrary guess; added the destination's own `depRunwayConf` as a wind-direction proxy. **Open question being tested empirically, not assumed (logging added 2026-10-14)** — is a long APTC silence "config unchanged" or a sign of a problem? No logging existed to check either way; temporary logging added, revisit the 30min staleness window with real evidence once enough samples accumulate.

**Trail backfill from ADS-B (added 2026-10-02)** — fixed at the root the same day: `setRelevantCallsigns()` now also calls `_watched.add()` proactively instead of lazily. **Fixed same day: `_swimTrailBackfilled` was marked done before attempting `fetchAdsbPosition()`, not after success** — ADS-B rate-limiting (429/403) meant one transient failure permanently skipped the backfill. Confirmed live on SWA3492, added after already airborne.

**NOTAMs via SWIM — built, tested, and deliberately abandoned (2026-10-07).** A full real AIXM 5.1 parser (`notams.js`) was built against 20 live-captured samples, confirmed working end-to-end, then fully reverted and deleted once the real architectural problem surfaced: SWIM only ever pushes live deltas, with no snapshot/backlog of already-active NOTAMs. Decided directly: "ok we won't use swim for notams then." If NOTAMs come up again, start from the FAA NOTAM Search API as the baseline instead.

---

## Resource usage — full history (audited 2026-10-02)

Prompted by the droplet's history of real CPU incidents (the SWIM local-dev-contention incident above). Added indexes were purely additive. `runActiveFlightPoller()`'s unconditional `fetchAdsbPosition()` call was swapped for `fetchLivePosition()` which checks STDDS/SWIM first.

---

## TFDM delay insight + "don't mark completed while still flying" — full history (added 2026-10-02)

The real bug: a flight delayed on the ground (literal example given: a long ORD taxi-out pushing departure ~30min late) stays genuinely airborne well past its originally scheduled arrival time, but every "is this flight active" check was pure schedule-time math, so the UI immediately called it "COMPLETED" the moment scheduled arrival passed. Real TFDM fields were confirmed against actual captured messages in `scratch/tfdm-samples/`, not guessed. The new `isFlightStillActive()` replaced **eight** separate ad-hoc checks that had drifted inconsistent across the grid, list, day-detail sheet, and every map view.

---

## Durable flight-tracking evidence + the day map's `_legState()` — full history (2026-10-03/04)

A long run of live-status bugs (Sam's RPA4410/RPA4525/RPA4581 among others) converged on two fixes. The explicit instruction given was: "do whatever you think will be consistently stable and reliable." Found live that a restart was silently erasing airborne/parked evidence (the GSP flight stuck "delayed" across a restart was the symptom that prompted persisting it to SQLite).

`isClearlyAirborne()`'s absolute low-altitude thresholds alone misfired at elevated airports (PIT ~1200ft, DEN ~5400ft) — this is why it requires altitude OR speed, not altitude alone.

**ADS-B cache-TTL fix (2026-10-07/08)** — verified live against a real airborne flight: first successful fetch took ~6s, a poll 5s later (within the new TTL) returned in ~0.15s.

The `_legState()` rule order itself (landedEarlyFlag → newerLegStarted → parked → liveSeen → airborne-and-before-effA → OOOI → flown-and-past-effA → never-flown-but-3h-past → scheduled → delayed → due) is current behavior and is kept in CLAUDE.md itself, not here — only the discovery narrative lives here: the "never seen flying but 3h past" fallback was added after RPA4581 flew for ~2 hours with zero airborne evidence from any source and sat stuck "DEPARTURE DUE."

---

## Same-day round trip sharing one callsign — full history (2026-10-09 through 2026-10-20)

Confirmed live, twice, independently: a callsign does not uniquely identify one leg. Kyle's corporate flights derive a callsign from the tail number, identical for every leg flown on that tail the same day. Separately, Mark's real Delta round trip (ATL→MDW then MDW→ATL, same day, same tail) genuinely files the same real flight number both directions — confirmed straight from Delta's own raw feed. Six separate places broke, found one at a time against Mark's real DL2417 round trip:

1. **Background poller never tracked Kyle's corporate flights** — `runActiveFlightPoller()`'s SQL required a non-null `flight_number`, which Kyle's SJJ legs never have.
2. **Stale "parked" state leaked from one leg into the next** — `unparkIfNewLeg()` only cleared a stale flag on a fresh live-feed-reported origin, which might never arrive at a quiet field. Fixed by preferring CrewSync's own known scheduled `departure_airport`.
3. **`_legState`'s parked→completed and liveSeen→active rules trusted evidence before this leg's own departure** — leg 1 landing marked the shared callsign "parked" before leg 2 even left the gate; once leg 2 departed, leg 1 (already completed) started showing "active" using leg 2's genuinely-real position.
4. **`_landedEarly` was keyed by bare callsign** — re-keyed by `` `${callsign}|${scheduledArrMs}` ``.
5. **The live map poller could outlive the leg it was tracking** — a stale in-flight `update()` tick could arm an unreachable timer forever, redrawing leg 1's stale coords against leg 2's real position data; worse, it could mark the shared callsign parked while leg 2 was genuinely still flying. Fixed with a per-call instance id.
6. **A 4h-then-90min time ceiling still wasn't enough for a short turnaround** — Mark's real ~1h MDW layover was shorter than the grace period tried first (4h, "far too generous"). Added `_hasNewerLegStarted()`.

**Performance regression, found and fixed the same day** — `_hasNewerLegStarted()` scanned a pilot's entire unbounded segment history on every render and every live-poll tick, confirmed live as the cause of the map taking noticeably longer to load.

**A seventh, related bug** — `/api/flight-status`'s `live` list had no parked exclusion (unlike `airborne`), letting `parked:true` and `live:true` both be true simultaneously. Confirmed live: DAL788 showed IN THE AIR well after TFMS's own OOOI confirmed landing.

**TFMS's real OOOI arrival time (added 2026-10-13)** — found on the same DAL788: it had landed and reached the gate, but the event-driven position pipeline apparently never had an active fix right at touchdown, so `_legState` fell through to `delayed` with a stale ETD. TFMS already knew regardless.

**TAXIING IN vs. IN THE AIR (added 2026-10-13)** — scoped to just the day-map popup for now; the grid/list/day-detail sheet have the same limitation and weren't touched.

**An eighth, genuinely different flavor, found 2026-10-20** — Republic reuses flight number RPA4605 the same day for a real TUL→LGA return under the exact same callsign as Sam's own LGA→TUL leg, a flight neither Sam nor CrewSync has any record of at all. Confirmed live: Sam's leg showed completed on grid/list but "in the air" on the map, then a nonsense "DELAYED · ETD 03:37pm." Fixed with `matchesExpectedOrigin()`, applied at every mutation/read site this bug reached. The one field this couldn't reach by borrowing another feed's evidence was TFMS's own `_flightTimes` cache, which has no origin of its own — `tfms.js` now parses the real origin straight out of its own filed-route string. Verified against the real endpoint after deploy: `GET /api/flight-status?callsigns=RPA4605&origins=LGA` and the same call with no `origins` param both returned identical, internally-consistent times for Sam's actual landed leg.

---

## NetJets manual tracking — full history (added 2026-10-30)

**Confirmed: tail → ATC callsign rule**, against 3 real tails: `N14QS`→`EJA14`, `N163QS`→`EJA163`, `N22QS`→`EJA22`.

**Verified end-to-end against a real live flight (2026-10-30).** Set Mack on-duty (7&7) and saved tail `458`; found `N458QS` (a real NetJets Phenom 300) genuinely airborne via ADS-B and used it for the test. Within one poll cycle: TFDM picked up the callsign with real origin/dest, and the leg-creation poller correctly auto-created the segment — confirmed via the real `GET /api/pilots/mack` response, not just the DB row.

**F70 (French Valley Airport) had no timezone anywhere in the app — found and fixed the same day.** Root cause: `scripts/build-airports.js` parsed each row's `local_code` field into a variable but never added it to the output maps. **That first fix attempt caused a real regression, caught before deploy**: adding `local_code` to the same per-row pass as `ident`/`icao`/`gps`/`iata` let Suswa Airstrip in Indonesia (explicitly marked `[UNUSABLE]`, local_code "SUS") silently clobber Kyle's own home airport KSUS, since Suswa's row happened to appear earlier in the raw CSV. Caught by diffing the full regenerated `airports.json` against the git-committed baseline (every one of the 100,179 pre-existing codes had to be byte-identical) before considering the fix complete. Fixed properly with a strict two-pass structure. Net result: 10,744 new airport codes added, zero of the 100,179 pre-existing codes changed.

**Same-callsign concurrent-leg filing, confirmed and fixed (2026-10-30).** Mack's real EJA458 leg later showed wrong departure/arrival times. Root cause, confirmed by broadening research logging to every real EJA callsign nationwide for ~2 hours: of 322 TFDM-tracked callsigns in that window, 190 (59%) showed 2+ distinct concurrently-active legs, 179 alternating message-to-message, with gaps up to ~27h between the two legs' scheduled departures. Fixed with a parallel per-leg store in each feed (`tfdm.getAllLegs()`/`tfms.getAllLegTimes()`), purely additive. Proof-of-concept verified live post-deploy: EJA777 and EJA858 each held two cleanly separated legs, and EJA742 held a real filed leg with accurate times ~4 hours before its own scheduled departure.

**`isParked()`'s own same disease, fixed (2026-10-30).** Confirmed live the same day the per-leg fix shipped: Mack's still-open EUG leg got marked complete immediately after deploy, because `isParked('EJA458')` returned true from a *different* leg's parked evidence. Fixed with `isParkedForOrigin()`.

**The per-leg stores are now disk-persisted and scoped to NetJets only.** Found during review: both stores were populating for ANY currently-tracked callsign, not just EJA ones — harmless but needless scope. Verified live that the persisted cache contains zero non-EJA callsigns.

**Rewritten to materialize every known leg, not just the current one (2026-10-30).** The research log showed 29% of the active fleet already has legs filed across both today and tomorrow under one callsign, some holding 3-4 concurrent legs. This meant dropping the old hard "live origin must match `expectedOrigin`" guard — it was protecting against the wrong risk, since EJA+tail-digits uniquely identifies one physical aircraft (no "different flight, same callsign" ambiguity the way a recurring airline flight number has). `FUTURE_LEG_GUARD_MS` and `_createNetjetsLeg()` were both dropped as superseded.

**Matching is fuzzy, not an exact key** — because a leg's own estimated time genuinely drifts poll to poll (confirmed live: EJA742's TFMS igtd moved from 01:18Z to 01:48Z while TFDM's own offBlockTime never changed). Verified live immediately post-deploy: zero duplicate rows created.

**`start_airport` changed from a hard gate to informational (2026-10-30)** — confirmed live against a real mismatch (Mack's assumed `SGR` vs. the aircraft's actual position inbound from `MRY`) that the old hard-reject's failure mode is silent and indistinguishable from "nothing's happening," with no visibility into why.

**Line-switch seam transition (built 2026-10-30).** Confirmed directly against `qspilot.info`'s own `seam-visualizer.js` source and its real transition data files. Duplicate-row bug fixed the same day: `PUT /rotation` now upserts on `UNIQUE(pilot_id, effective_from)` instead of blind-inserting.

**CC schedule override (built 2026-10-30).** Confirmed directly from a real NetJets Yahoo Mail monthly schedule export. A paste-into-a-textarea fallback was built first, then fully removed per direct request ("get rid of the paste option for CC") once the upload path was verified working.

**PDF support requires real OCR — confirmed live, not assumed.** Tested directly against a real sample: two different `pdf-parse` versions both returned effectively empty text despite the page visually showing crisp, apparently-selectable text. **Deliberately NOT the `tesseract.js` npm package — tried first and reverted after a live resource leak.** Confirmed live sitting at ~70% CPU and 188MB RSS for minutes after `terminate()` resolved, on a box with only ~425MB available; had to be killed manually. **Real-world latency is meaningfully higher than isolated testing** — a standalone test completed in ~7.4s; the same PDF through the real live process (sharing one vCPU with SWIM/STDDS/ADS-B pollers) took ~53s.

**Verified live against Mack's real November 2026 CC72 export**, through the actual `/upload` endpoint with the real PDF file: all 30 days parsed and persisted correctly, matching the document exactly, with only two harmless warnings (both bare-4-digit-number false positives, expected noise, same posture as the Southwest parser's own documented warning).

### `isParked()` leg-mix-up fix, the per-leg persistence/scoping follow-up, and the leg-creation rewrite's own bugs (all 2026-10-30/31, same investigation thread)

After the initial per-leg fix, several more rounds of real bugs surfaced on Mack's live test tail, each confirmed and fixed the same session:

- **Arrival-before-departure, confirmed live.** The leg-creation refine step originally cleared an inconsistent `arrival_time` to `NULL` rather than leave a nonsensical "lands before it takes off" value. Confirmed live this broke MORE than it fixed: several places in app.html (the day map's here-now pin builder's own `pilotFlights` filter among them) assume a `type='flight'` segment always has both `departure_time` AND `arrival_time`, and silently drop any segment where that's not true. A null `arrival_time` made Mack's genuinely-airborne leg invisible to that whole pipeline, which fell through every here-now rule to the final "show at home" fallback — a worse, more confusing bug than the one being fixed. Corrected to set `arrival_time = departure_time` (a neutral "unknown yet" placeholder) instead of `NULL`.
- **Grid/list live poller had no way to resolve "completed" for a non-airline operator.** `startCalListLivePolling()`'s only "is this actually landed" fallback checked the airline's real OOOI `airlineOnTime` field — genuinely authoritative when present, but essentially never populated for a charter operator like NetJets. Confirmed live: Mack's EJA742 showed the map correctly as "COMPLETED" (via `_legState()`'s own "flown && past effective arrival" fallback) while the grid disagreed, stuck on "DEPARTURE DUE," for the same flight, same moment. Fixed by adding the same `airborne`-array + past-known-arrival fallback to the grid poller.
- **Tail display**: a NetJets pilot enters just the tail digits ("742") for convenience; added `displayTail()` to show the full `N742QS` everywhere a reader actually sees it, without changing what's stored (the digits are what `deriveCallsign()`'s EJA branch needs).
- **NetJets tail lookup page** (`/crew-roster/netjets-lookup`) — a human-readable exploration tool over the same `tfdm.getAllLegs()`/`tfms.getAllLegTimes()` data, built after repeated raw-JSON debug-endpoint queries during this same investigation.
- **TFDM's own estimated runway arrival/departure time, found by re-auditing raw samples instead of assuming.** Confirmed via real math in a live sample (`etd` + a fix's `elapsedTime` in seconds === `eta`, exactly) that a filed flight plan's ETE is already baked into TFMS's `eta` the moment one exists — the real gap was that NO flight plan existed yet for a leg still ~12-18h out, not a missing field. Checked the TFDM `scheduled`-state inclusion window empirically across 590 real legs fleet-wide: zero exceptions beyond ~18h before departure, and TFDM's own `estArrivalTime` (once connected) was found to be inconsistent even then (confirmed: EJA815's own two legs, both similarly far out, disagreed with each other on whether they had one at all).
- **ETA placeholder / historical-duration estimate, built in direct response to "we need a placeholder ETA until the real data comes in."** Priority order: NetJets' own real average duration for that exact city pair (from genuinely completed legs only) → any other tracked pilot's real scheduled `block_minutes` for the same city pair (raised directly: "we could also use other airline flight's block time as historical information between airport pairs" — a pure read against existing segments data, added `idx_segments_route` to keep it off a full table scan) → great-circle distance over an assumed 420kt cruise speed, only once neither real source has anything. `block_minutes` is never written from the estimate itself, only from real evidence, so an estimate never shows alongside a falsely-precise duration.
- **Research tooling built and then removed in the same thread**: a one-off raw-message capture for EJA815 specifically (`.eja815_debug.xml`), added then removed once its purpose was served; a `dumpFltdSample()` mechanism added to tfms.js mirroring tfdm.js's own, since `scratch/tfms-samples/` turned out to only ever hold the old APTC-only capture, never a real per-flight message — used to audit and discover `etdType`/`etaType` (ACTUAL vs ESTIMATED), TFMS's own `diversionIndicator`, `arrivalInformation`'s `timeOfArrival` field, and GUFI (Globally Unique Flight Identifier — confirmed stable across 6 repeated messages for the same real flight in one capture batch). All extracted additively (never changing `getFlightTimes()`'s existing return shape, so the general SWIM pipeline every other pilot relies on is untouched) per explicit instruction to keep the hot path safe while still gathering useful NetJets-specific data. GUFI itself was deliberately NOT wired into the actual leg-matching logic yet — flagged as a real, separate architectural decision for later, not bundled into the extraction pass.
- **TFDM's `diversionRecoveryIndicator`**, confirmed real via a corroborating second field on the same real flight (`smpExemptionReason = "DIVERSION_RECOVERY"` on SKW487W, which had diverted into KDEN and was recovering) — surfaced app-wide via `withTfdmInfo()`, not NetJets-specific, since any tracked flight could divert.

---

## Pilot roster is fully DB-driven — full history (2026-10-01)

The admin-panel airline display bug turned out to be one symptom of pilot identity/config being duplicated in three separate places: `server.js`'s hardcoded maps, `app.html`'s initial object literals, and literal static HTML for the 5 original pilots. Whichever of these three a given piece of code happened to read determined whether an admin's edit actually took effect — exactly why editing Drew's airline through the admin panel silently did nothing before this fix.

Also found and fixed in the same pass: a second, independent copy of the same anti-pattern lived entirely client-side (`PILOT_HOMES`/`PILOT_CARRIER`). `PILOT_CARRIER` was live and dangerous: `deriveCallsign()` checked it *before* the DB-sourced value, meaning if any of the 5 original pilots' real airline code ever changed in the DB, ADS-B callsign lookups would have kept using the stale original value — the exact bug class this whole refactor existed to eliminate, just not yet discovered because nobody had changed one yet.

**Kyle's Schedaero needed one explicit addition, not just a deletion** — removing the hardcoded override meant `parser_type`/`airline_code` became real, admin-editable fields for Kyle too, and Schedaero was never in the public `AIRLINE_OPTIONS` list at all. Verified against the real endpoint: saving Kyle's profile with the new SpiritJets entry round-trips `schedaero`/`SJJ` unchanged.

**This required fixing a real, pre-existing security hole first** — `PUT`/`DELETE /api/pilots/:pilotKey` and `POST .../regenerate-token` had no authentication at all, sitting there since before the friends-system security pass. Verified against the real endpoints: a pilot editing their own base succeeds; targeting someone else's key gets 403; smuggling a `role` change into a self-edit succeeds but the role column is left untouched; all three 401 with no token.

**Second security pass (2026-10-08, same day)** — found while auditing further: six more schedule-mutation endpoints had no authentication, plus a seventh, worse one (`GET /:pilotKey/token`, labeled admin-only in its own comment but with zero enforcement, handing back any pilot's actual real login token). All seven verified live against a throwaway local DB copy.

**A related, separate bug found the same pass** — a failed identity lookup silently became indistinguishable from admin. Confirmed live: a lagged connection on a real pilot's own login showed admin-style UI instead of their own identity, with no actual admin token ever presented.

---

## Mobile header padding — history notes

This went through several iterations and reverts (2026-10-02/03), not a final spec-derived answer. Tried, in order: a `max(68px, ...)` floor, moving the header fully under the status bar, a translucent status bar (reverted back to solid black after a reported haze/blur persisted either way). The `68px`-floor issue was diagnosed via a temporary on-screen readout technique (`getBoundingClientRect()` + a hidden probe for the resolved safe-area-inset value) — worth reusing for any future "something looks visually wrong on iOS" report rather than guessing blind. A light-mode toggle was built and then fully removed per explicit request ("remove the light toggle"). A full map-overlay/floating-controls redesign and a deferred tab-switch-render perf change were both tried and fully reverted — explicitly rejected ("revert what you did to mess up the map controls", "not the page pops in idk if I like that"). The `#current-month-display-mobile` no-wrap fix was also diagnosed via the same on-screen-readout technique — a wrapped long month name pushed its block above the safe-area boundary, looking like a rendering glitch but actually just wrapped text pushed out of bounds.

---

## Schedaero sync — Kyle's corporate flight number, full history (fixed 2026-10-09)

Confirmed directly: SpiritJets' real flight numbers are `SJJ` + the first three digits of the tail, not every digit — found via a real live confusion on Kyle's AMA-SUS leg (showed "completed" while still genuinely airborne, after a long ground delay at AMA pushed actual departure past the originally scheduled SUS arrival). Three compounding bugs found together: `parseSchedaeroData()` hardcoded `flightNumber: null`; `importSchedaeroEvents()`'s own INSERT hardcoded the bind parameter to `null` regardless of what the parser returned (same bug class as the Delta MiCrew `blockMinutes` issue); and both tail-based callsign fallbacks took ALL digits from the tail, not just the first three.

**Background poller never tracked Kyle's corporate flights at all — fixed 2026-10-09, same investigation.** Before the fix above, every Schedaero segment had `flight_number: null`, so every one of Kyle's flights was silently skipped by server-side tracking. Verified against a copy of prod's real database: the widened query matched both of Kyle's real segments that day, where it previously matched zero.

**A second, independent bug in the same investigation** — a reused same-day callsign kept a stale "parked" flag from blocking the next leg. This exact same-callsign-reuse problem turned out to be much bigger than just Kyle's corporate flights — see "Same-day round trip sharing one callsign" above, which this fix was the first instance of.

---

## FRAT Autofill userscript — full history

**`@match` covers the whole origin, not just the report URL** — a hard-won fix: PRISM is an Angular SPA, and Tampermonkey only auto-injects on an actual navigation, so a script scoped to just the report URL would never be running to see the SPA's pushState-based routing happen.

**Hard-won lesson on clicking PRISM's UI elements — verify the actual DOM before guessing event types.** The template-dropdown click failed for several iterations, each diagnosed as a different wrong theory (event type, dropdown scope, search-box side effects) before a live DOM dump revealed the real bug: the "smallest textContent" heuristic was tying against purely-decorative empty wrapper divs and picking an inert ancestor instead of the real button. Lesson generalizes: when a click on a found DOM element doesn't do what a real click would, get the actual `outerHTML` of the target before changing the event-dispatch mechanism.

**Sends Kyle's real CrewSync login token — fixed 2026-10-07.** `GET /api/pilots/:key` started requiring `?token=` once the friends-system auth pass shipped, and the userscript never sent one, so it silently stopped finding any upcoming flights. **Known, accepted exposure, not an accident**: the file is both committed to the public GitHub remote and served unauthenticated (Tampermonkey needs to fetch it directly), so the hardcoded token is effectively public. Don't paste the literal token value into this file or anywhere else committed to the repo.

**A non-200 schedule-fetch response used to fail silently** — fixed (`@version 3.11`) to log the actual HTTP status first. Confirmed live on a real subsequent run that PIC auto-fill works correctly once the underlying Schedaero data is actually available.

---

## Crew Intel — history notes

Clutter filters added after auditing the full intel dataset (434 entries, 426 from one pilot — Drew) for low-value, easily-googled content. Voting added 2026-10-01 as a crowd-sourced complement to the keyword/blank-body filters.
