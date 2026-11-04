# CrewSync: Frontend

Current behavior only. Past bugs and why things were built this way: `CLAUDE_HISTORY.md`.

## Key functions (grep these names)

| Function | Line ~| Role |
|---|---|---|
| `initIdentity()` | 2122 | Auth check on load; sets myPilot/myViewer; calls `_syncPilotRoster()` before any pilot-dependent UI builds |
| `_applyIdentityUI()` | 2267 | Shows/hides UI sections based on who's logged in |
| `_buildCrewVisibilityUI()` | ~2570 | Crew toggle switches — admin/viewer/demo only now |
| `renderFriendsPanel()` | ~2300 | Friends list + incoming/outgoing requests; for a real pilot also renders the crew-visibility toggle + Remove inline per row |
| `render()` | ~6485 | Main calendar/list render dispatcher |
| `renderMap()` | 4857 | Single pilot monthly route map |
| `renderAllPilotsMap()` | 4715 | All-crew monthly map |
| `renderDayMap()` | ~5828 | All-crew single-day map |
| `distanceProportionalArc()` | 4826 | Bezier-bowed great-circle arc for a single route (no de-overlap; `renderMap()` has no cross-route overlap handling at all) |
| `offsetArc()` | 5238 | Bezier arc with perpendicular offset — spreads multiple flights sharing an identical city pair (`renderDayMap()` only) |
| `inferAwayLayovers()` | 2880 | Generates synthetic 'away' events for overnight non-home stays |
| `switchView()` | 3200 | Switches between calendar/list/map/overlap views |
| `switchOverlapTab()` | 3315 | Crossings ↔ Off Days tab switch |
| `computeOverlap()` | 3928 | Crossings pipeline (fetch → buildGroundPeriods → classify → render) |
| `buildGroundPeriods()` | ~3942 | Inside computeOverlap; emits ground windows per pilot |
| `computeOffDays()` | 3517 | Off Days pipeline |
| `renderCommonOffSection()` | ~3152 | Renders off day rows + filter chips |
| `showDayDetail()` | 7194 | Opens day detail bottom sheet for a date key |
| `handleUpload()` | 7160 | File upload handler → `uploadPilotSchedule()` |
| `submitAddFlight()` | 7722 | Saves manual flight from add-flight modal |
| `flightAwareLink()` | ~5288 | Wraps a flight ident in a FlightAware tracking link, gated by `flightAwareEligible()` (departed or within 48h) |
| `startLiveTracking()` | 4946 | ADS-B/SWIM poll loop for one callsign; adaptive cadence |
| `startCalListLivePolling()` | 4848 | Polls `/api/live-position` for `[data-live-callsign]` elements in cal/list every 15s |
| `setupMobileGestures()` | 1636 | Registers swipe + pull-to-refresh handlers |
| `renderIntel()` | 8452 | Crew Intel dispatcher → airports / map / detail sub-renders |
| `renderIntelMap()` | 8524 | Leaflet thumbtack-pin map for intel entries |
| `renderIntelAirports()` | 8633 | Airport card list for Crew Intel |
| `renderIntelDetail()` | 8686 | Per-airport intel tip cards |
| `saveIntelTip()` | 8828 | POST/PUT intel entry to `/api/intel` |
| `openAdminPanel()` | 7508 | Admin users panel + dashboard tab |
| `saveUser()` | 7872 | Admin add/edit user → POST/PUT `/api/pilots` |
| `initServiceWorker()` | 7960 | Registers `/sw.js`; listens for `OPEN_OVERLAP` message |
| `initPushNotifications()` | 7970 | Decides whether to subscribe or show prompt |
| `subscribeToPush()` | 7994 | Gets VAPID key, creates push subscription, POSTs to server |
| `updateCrossingAlert()` | 8132 | Updates badge count + crossing modal from computed overlaps |
| `loadNotifications()` | 8022 | Fetches `/api/notifications` and updates bell badge |
| `_legState()` | ~7024 | Day map's unified per-flight status resolver (see "Durable flight-tracking evidence" below) |
| `_hasNewerLegStarted()` | — | Shared helper: has this pilot's same callsign already started a later-scheduled leg today |
| `isFlightStillActive()` | — | Shared grid/list/day-detail/map "is this flight still active" check (90min grace past scheduled arrival, see "TFDM delay insight" below) |

## `#view-overlap` layout (important for iOS scroll)

Must be flex column with filter bar OUTSIDE the scroll container:
```
#view-overlap (display:flex; flex-direction:column; overflow:hidden)
  ├── #overlap-header        (shrink-0)  ← sticky header + tabs
  ├── #offday-filter-bar     (shrink-0)  ← pilot chips, Off Days only
  └── .flex-1.overflow-y-auto            ← scrollable content
```
Moving the filter bar inside the scroll container breaks iOS horizontal scroll (snaps back).

## Touch gesture system

Two swipe handlers registered in `setupGestures()` (~line 1640):

**Calendar / List month swipe** — main content element. Horizontal swipe (|dx| > 60, more horizontal than vertical by 1.8×) → changes month. Calendar/list views only.

**Overlap tab swipe** — `#view-overlap`. Same thresholds. Swipe left → Off Days; swipe right → Crossings. **Critical:** ignores touches originating inside `#offday-filter-bar`:

```js
overlapEl.addEventListener('touchstart', e => {
    if (e.target.closest('#offday-filter-bar')) { oxStart = null; return; }
    oxStart = e.touches[0].clientX; oyStart = e.touches[0].clientY;
}, { passive: true });
overlapEl.addEventListener('touchend', e => {
    if (oxStart === null) return;
    const dx = e.changedTouches[0].clientX - oxStart;
    // ...
}, { passive: true });
```

## Splash screen (`#splash-screen`)

`app.html` ~line 360. Full-screen overlay while the app initializes; fades out once identity is resolved. Logo: `<img class="splash-plane" src="/icon.svg">` (72×72, rounded, floating animation — not an emoji, don't revert). Title "CrewSync", subtitle "Crew Scheduling", three pulsing blue dots. Dismissed via `splash-hide` (fade) then `splash-gone` (display:none). Repurposed for identity-resolution failure: `_showIdentityError()` shows red subtitle text + a Retry button instead of proceeding with an unresolved identity.

## Branding assets

| File | Usage |
|---|---|
| `public/icon.svg` | App icon — dark navy bg, white plane pointing NE. Splash screen, crew roster header, favicon |
| `public/icon-192.png` | PWA manifest icon (192×192) |
| `public/icon-512.png` | PWA manifest icon (512×512) |
| `public/apple-touch-icon.png` | iOS home screen icon |

Use `<img src="/icon.svg">` with `border-radius` to match the rounded-square style for any new logo placement. Don't use emoji or generic plane glyphs.

## Calendar grid rendering (`render()` → grid branch)

`render()` (~line 5937) rebuilds whichever view is active. It does **not** fetch — call `loadPilot()` first.

**Grid mode logic per calendar cell:**
1. Walks every day in the month; filters `segments[]` by **local** departure/arrival date (`flightLocalDate()`, not raw JS date). Classifies: Hard Off > Vacation > Flying > Reserve > Away (inferAwayLayovers) > personal-away > Off.
2. Border/background: `border-red-600 bg-red-700/80` Hard Off; `border-blue-500/30 bg-blue-500/10` Flying; `border-amber-400/30` Reserve; `border-yellow-500/40 bg-yellow-900/20` Away layover.
3. Flight items sorted chronologically; data attributes `data-dep-time`, `data-arr-time`, `data-tail`, `data-trip`, `data-flight`, `data-live-callsign`.
4. Active flights (`isFlightStillActive()`, see "TFDM delay insight" below): `active-leg` class + `data-live-callsign` for `startCalListLivePolling()`.
5. After render: `attachTooltips()` wires hover tooltips; `startCalListLivePolling()` starts polling.

**Mobile grid:** compact cells (52–96px), text-only flight pills, status pills hidden.

**Perf rule — never accumulate `innerHTML +=` in the day loop.** Build a local string, assign to `innerHTML` once after the loop (history: `CLAUDE_HISTORY.md § Calendar grid rendering`).

**Auto-scroll to a live leg.** Grid branch scrolls any `.flight-item.active-leg` into view (`block: 'nearest'`) after rendering, deferred to `requestAnimationFrame` (must be deferred — see history).

**Overnight/red-eye indicator (grid only).** A flight whose local dep/arr dates differ gets a 🌙 marker on both day cells, with `data-redeye="dep"`/`"arr"` feeding a custom tooltip explanation. **Never use a native `title=` on `.flight-item`** — it visibly collides with the custom tooltip. Extended to reserve shifts that cross midnight (same marker, worded for an on-call shift). Scoped to the monthly grid only.

**Block totals (admin and Kyle).** A Block Hours toggle in the profile sheet (`cs_block_totals`, per device) adds the day's total to the top row of desktop grid cells, between the date and the status tag (they don't fit on a phone), and to the day detail, plus `T` (tour total) on a NetJets tour's last day and on every tour day's detail. Worked legs only: no deadheads, commutes, personal or cancelled legs, and a leg counts on its local departure day. `_blockByDay()` runs once per render. Tour totals only count legs that exist so far, because NetJets legs appear about a day ahead. Airline trips have no tour total.

## List view rendering (`render()` → list branch)

Iterates every day in the month. Day header block with status badge. Flight rows (`.flight-row`) sorted by departure time: route pair, local dep/arr times with tz abbreviation, block time, tail/flight#, layover duration between consecutive legs. Ground legs (type='ground') appear as subdued `VAN ORD→MDW` rows. Reserve slots appear as amber "ON CALL" rows. Past days get `.list-past` (grayscale + dimmed); today highlighted. `layoverLabel(gapMins, atHome, sameDay)` shows overnight duration if >30 min and not at home; suppresses label if >30h at home.

## Day detail sheet (`showDayDetail(dateKey)`)

Opens `#day-detail-sheet` (bottom sheet mobile, centered modal desktop). Built from the same `segments[]` slice as the grid: header status (HARD OFF / IN THE AIR / FLYING / ON CALL / DAY OFF) + date; flight cards (route, times, block, tail#, trip#, DH badge, layover to next leg); reserve cards; ground leg cards; manual flights get Edit/Delete (only if `canEdit()`); live flights show `▶ LIVE` + `deriveCallsign()`.

The live leg's card also shows the speed and altitude line. It starts from the grid/list's `live-<callsign>` element, and `startCalListLivePolling()` keeps it updated through `data-live-mirror`.

`canEdit()` → true if `myPilot === currentPilot` or admin.

## Pull-to-refresh (`setupMobileGestures()`)

Registered on `#view-grid`/`#view-list`. `touchstart`: `ptrActive = el.scrollTop === 0`. `touchmove`: scales/rotates `#ptr-indicator`; at 70px pull → `ptrTriggered`. `touchend`: triggered → `loadPilot(currentPilot)` + toast; else horizontal swipe → `changeMonth()`. `#ptr-indicator` is a fixed 36px circle tracking pull distance.

## Notifications system

### Push notifications
Service worker `/sw.js` registered by `initServiceWorker()`. `initPushNotifications()` → `subscribeToPush()` if already granted, else shows `#notif-prompt-sidebar`. Server sends push on crossings via `broadcastCrossingNotifications()`. SW message `{type:'OPEN_OVERLAP'}` → `switchView('overlap')`. `PUSH_ENABLED` gates the feature; `myToken` ties a subscription to a pilot.

### In-app crossing alerts
`updateCrossingAlert(overlaps)` (~8132): filters to overlaps involving `myPilot` within `XALERT_BADGE_WINDOW` (48h), cross-referenced against `localStorage['cs_xacked']` for unread badge count. Within `XALERT_MODAL_WINDOW` (24h) and not yet shown this session → `#crossing-alert-modal` once per session. `ackMyCrossings()` on opening crossings clears the badge.

### Notification panel (`#notif-panel`)
Bell icon → `loadNotifications()` (`/api/notifications?token=…`). Clicking a notification → `switchView('overlap')` + `PATCH /api/notifications/read`. `navigator.setAppBadge()` where supported (iOS 16.4+).

## Crew Intel view (`#view-intel`)

**State**: `_intelAll`, `_intelView` (`'airports'|'map'|'detail'`), `_intelDetailAirport`, `_intelFilter.category`, `_intelSearch`, `_intelMap`.

**Views**: airports list (`renderIntelAirports()`, alphabetical cards, color-accented border), intel map (`renderIntelMap()`, Leaflet thumbtack pins, red = mixed category), detail view (`renderIntelDetail()`, per-airport tip cards with category filter pills).

**Data flow**: `loadIntelCounts()` → `_intelAll`; `saveIntelTip()` POST/PUT `/api/intel`; `deleteIntelTip()`; `voteIntel(id, vote)`.

**Category colors**: hotel=`#60a5fa`, food=`#fbbf24`, activity=`#4ade80`, tip=`#c4b5fd`; mixed pin=`#ef4444`.

**Clutter filters (both default ON)**, read through `_intelVisible()` everywhere entries are rendered or counted: `_intelHideGeneric` (regex-matches national park/monument/historic-site/seashore/memorial naming), `_intelHideEmptyActivity` (any `activity` entry with a blank body — ~70% of all activity entries have no body). Each persists its own `localStorage` toggle, `'0'` = off.

**Voting** (`intel_votes`, `UNIQUE(intel_id, pilot_key)`, upserted; a cleared vote deletes the row). `GET /api/intel` attaches `score` (SUM) and, with a token, `my_vote`. Sort order is by `score` descending (ties → newest first), not grouped by category — category pills still filter. **Redaction**: entries at or below `INTEL_REDACT_THRESHOLD` (`-3`) collapse to a one-line "Downvoted by the crew (N) — tap to view anyway" placeholder in the detail view only (`_intelExpandedRedacted`, in-memory, not persisted) — doesn't affect `_intelVisible()`, airport totals, or map pin counts.

## PWA / service worker

**Service worker `/sw.js`**: registered on every load; handles background push (parses payload, shows system notification); on click sends `{type:'OPEN_OVERLAP'}` → Crossings tab.

**PWA install prompt (`#pwa-prompt`)**: shown on mobile when not in `standalone` mode. iOS: manual "Add to Home Screen" instructions (no native API). Android: `beforeinstallprompt` → `pwaInstall()`. Dismissed state in `localStorage['pwa_dismissed']`, not shown again for 7 days.

**Auto-refresh on resume** (in `<head>`, runs before any scripts):
```js
if (document.visibilityState === 'hidden') hiddenAt = Date.now();
else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) window.location.reload();
```
Refreshes after 5 minutes backgrounded.

**Manifest**: served with `?u=TOKEN` from the `<link rel="manifest">` tag injected in `<head>`.

## UI components and modals reference

| Element | Opens via | Purpose |
|---|---|---|
| `#day-detail-sheet` | `showDayDetail(dateKey)` | Day events bottom sheet |
| `#add-flight-modal` | `openAddFlight()` | Add/edit manual flight |
| `#edit-ground-modal` | Edit button on ground leg card | Edit ground transfer |
| `#schedaero-modal` | "Sync Schedaero" button | Kyle's Schedaero sync |
| `#drew-ics-modal` | "Sync Schedule (Drew)" button | Drew's RosterBuster ICS URL |
| `#ics-sync-modal` | "Sync Schedule" button | Generic ICS URL |
| `#mobile-upload-sheet` | Mobile nav Upload button | Mobile upload/sync |
| `#profile-sheet` | Avatar button / sidebar identity row | Identity, link, crew visibility, notifications |
| `#admin-panel` | Profile → "Manage Users" | User list + dashboard |
| `#edit-user-modal` | "+" or Edit in admin panel | Add/edit pilot or viewer |
| `#overlap-detail-modal` | "Also Nearby" row tap | Expanded crossing detail |
| `#crossing-alert-modal` | Auto, once per session if crossing within 24h | Crossing alert |
| `#intel-modal` | "+ Add" in Crew Intel | Add/edit intel tip |
| `#notif-panel` | Bell icon | Notification history |
| `#confirm-modal` | `showConfirm(title, body)` | Destructive action confirmation |
| `#overlap-help-modal` | "?" in Crossings | Crossings type explanation |
| `#intel-help-modal` | "?" in Crew Intel | Crew Intel explanation |
| `#grid-help-modal` | "?" in Calendar | Color coding help |
| `#list-help-modal` | "?" in List | List view explanation |
| `#map-help-modal` | "?" in Map | Map modes explanation |

**Bottom sheet swipe-to-dismiss**: `setupSheetSwipe(panelEl, dismissFn)` — dragging down >80px dismisses with a 220ms slide-out.

## Layout structure

```
body (flex row, 100dvh)
  #sidebar (hidden md:flex, 256px)        ← desktop nav + pilot list + upload section
  div.flex-1 (main content column)
    header (desktop or mobile)
    #empty-schedule-banner                 ← shown when pilot has no data
    #mobile-pilot-bar                      ← horizontal scroll pill nav (mobile only)
    #mobile-next-trip                      ← next flight strip (signed-in pilots)
    main.flex-1
      #view-grid    .view-section          ← calendar
      #view-list    .view-section          ← list
      #view-map     .view-section          ← map + mobile mode bar
      #view-overlap .view-section          ← crossings + off days
      #view-intel   .view-section          ← crew intel
    nav.mobile-nav                         ← fixed bottom: Grid, List, Map, Overlap, Intel, Upload
```

Only one `.view-section` has `.view-active` (display:block/flex) at a time. `switchView()` swaps the class. View fade-in is a 0.14s CSS animation on `.view-active`.

**Desktop sidebar**: collapsible via hamburger `toggleSidebar()`. `#sidebar.sidebar-hidden` sets width:0, overflow:hidden, opacity:0 with CSS transition.

## Color constants (pilot colors)

Used in Crew Intel, map legend, sidebar avatar circles, mobile pill active state, flight card accents:
```js
PILOT_COLORS = {
  kyle: '#3b82f6',   // blue-500
  adam: '#2dd4bf',   // teal-400
  sam:  '#f97316',   // orange-500
  logan:'#818cf8',   // indigo-400
  drew: '#fb7185',   // rose-400
}
```
These live in the `pilots.color` DB column now (see "Pilot roster is fully DB-driven") — the object above is just the current values. Additional non-core pilots have colors defined inline; further pilots get `_dynamicColorPool` rotating palette. Hardcoded HTML uses these as rgba, e.g. `#3b82f6` → `rgba(59,130,246,0.15)` for avatar circle background.

## UI theme (server branch — aviation boarding pass style)

### Flight cards (day detail sheet + list view)
- `.bp-card` — boarding pass container, `overflow:hidden`, `border-radius:16px`
- `.bp-apt-code` — 38px monospace airport code (30px mobile)
- `.bp-top-bar` — 3px accent gradient bar at card top
- `.bp-tear-line` / `.bp-stub` — dashed separator + stub section with flight meta + barcode decoration
- `accentColor` hierarchy (day detail & list): `isActiveLeg → #22c55e` > `isPersonal → #a78bfa` > `isCommute → #f59e0b` > `PILOT_COLORS[currentPilot]`

### Sidebar pilot buttons (`#sidebar-pilot-list`)
- `.pilot-avatar-btn` — full-width button with colored initials circle (`w-7 h-7 rounded-full`) + name
- Circle uses `PILOT_COLORS[pilot]` rgba (hardcoded in HTML, must match JS constant)
- Active state set by `loadPilot()`: `btn.style.background = pc + '1a'`, `btn.style.borderColor = pc + '55'`

### Mobile top header (`header.md:hidden`)
- Contains identity avatar (`#identity-avatar`), month info (`#mobile-header-month-info`), prev/next month (`#mobile-prev-btn`/`#mobile-next-btn`), bell (`#notif-bell-btn-mobile`), help, add-flight (`#btn-add-flight-mobile`).
- Calendar-specific controls hidden via `style.display='none'` on `overlap`/`intel` views (`switchView()`'s `calView` check) — only avatar/bell/help remain.
- Height: `calc(env(safe-area-inset-top) + 56px)`, `padding-top: calc(env(safe-area-inset-top) + 6px)`. Fully opaque `bg-black`, no `backdrop-blur-md`. Status bar style is solid `black` (`apple-mobile-web-app-status-bar-style`), not translucent. These values are empirically settled, not spec-derived — full iteration history (and the on-screen-readout diagnostic technique worth reusing for future iOS rendering reports) is in `CLAUDE_HISTORY.md § Mobile header padding`.
- No light mode exists anywhere in the app (was built and fully removed).
- `<body style="height: 100dvh" data-fullheight>` with a `100lvh` override under `@supports`, so the PWA reaches the true bottom edge.
- Bottom nav uses a flat `12px` bottom padding (not `env(safe-area-inset-bottom)`), with matching content-reservation padding below it (grid/list `70px`, map mode bar `68px`).
- `#current-month-display-mobile` must stay `whitespace-nowrap overflow-hidden text-ellipsis` with `min-w-0` on its flex parent — a wrapped long month name pushes its block above the safe-area boundary (looks like a rendering glitch, isn't).

### Mobile nav bar (`.mobile-nav`)
- Each button `56px` tall, `.mbtn-icon-wrap` (38×28px, `border-radius:10px`) wraps the SVG.
- Active: `.mbtn-active .mbtn-icon-wrap` → `background: rgba(59,130,246,0.13)`, icon/label `#3b82f6`.
- Top indicator line (`.mbtn::before`): 2px `#3b82f6`, animates width 0→28px on active.

### Mobile pilot pills (`#mobile-pilot-bar`)
- Active pill uses `PILOT_COLORS[pilot]` (border + color + background) via `loadPilot()` JS.
- Inactive: `border-zinc-700 text-zinc-400`.

## Demo mode (`/demo` route)

`demo-data.js` generates fake pilots (`alex`, `morgan`, `casey`, `jordan`). `GET /api/demo/pilots/:key` calls `buildDemoSegments()` fresh on every request (never cached at module load).

**Three-month window** (previous/current/next month relative to the server's own UTC clock, concatenated) — avoids a server/visitor month-boundary mismatch near midnight UTC. `anchorForMonthOffset(n)` returns the 15th of month `n`; `buildForAnchor(ANCHOR, idStart)` builds one month's segments for all four pilots (`idStart` keeps ids unique across the three calls: 1000/2000/3000).

**Identity display**: no login token, so `myPilot`/`myViewer` are both falsy — same state as admin. `_applyIdentityUI()` checks `isDemo` before falling back to the admin label, showing "Demo" instead. Check `isDemo` the same way for any new identity-driven UI text.

## Offline / connectivity

`#offline-banner` (red bar, top) appears on `window.addEventListener('offline')`, disappears on `'online'`. The service worker does not cache API responses — push-only, no offline data mode; all schedule data requires network.
