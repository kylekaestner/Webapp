# frontend/

Source for `public/app.html`, `public/app.js` and `public/app.css`. **Edit here, never those three**: they're generated.

```
npm run watch    # while working: rebuilds public/app.html every time you save (then refresh)
npm run build    # one build, e.g. before committing
```

Commit `public/app.html`, `public/app.js`, `public/app.js.map` and `public/app.css` together with your source changes. Building needs the dev dependencies (`npm install` once). The droplet serves it as-is, so deploys need no build step.

## How it fits together

- `app.template.html`: the page markup, CSS and head scripts. It loads `/app.js?v=@@APP_JS_VERSION@@` at the end of `<body>` (where the inline script used to be) and `/app.css?v=@@APP_CSS_VERSION@@` last in `<head>`; the build fills in each file's content hash. The server lets browsers keep a file for a year when `v` matches it, so unchanged code is never re-downloaded and a deploy is picked up at once.
- `src/**/*.js`: the app's script, split by feature.
- `tailwind.config.js` / `tailwind.input.css`: Tailwind 3.4.17 (default theme). The build scans the template and `src/` for class names and writes `public/app.css`, linked last in `<head>` with a version so a changed stylesheet is always fetched fresh. **Write class names out in full**: `text-${color}-400` never gets CSS because the scanner can't see it. Use a lookup object of full names (`{ ok: 'text-green-400', bad: 'text-red-400' }`) or an inline style for a truly dynamic color.
- `files.json`: the order the files are joined in. **A new file must be added here**; the build stops if a file in `src/` isn't listed.

`public/app.js` ships without comments and blank space (esbuild, whitespace only, nothing renamed). `public/app.js.map` maps it back to your files, so the browser's developer tools and error locations show `frontend/src/<file>:<line>`. `npm run build -- --readable` builds an unstripped app.js for debugging (don't commit that one).

The files are joined, in that order, into `public/app.js`, one classic script (not a module), so they all share one global scope, just like when it was a single file. Any file can call any function, and `onclick="fn()"` in the markup works. Order matters only for top-level `let`/`const` variables and code that runs at load time: a file can't use a top-level variable declared in a later file while the page is loading. Function declarations can go in any file.

`public/app.html` and `public/app.js` carry a hash of their content. If someone edits one by hand, the next build stops and says so, so the edit isn't silently lost. `--force` discards it.

## Files

| Folder | What's there |
|---|---|
| `core/` | `globals.js` (architecture overview, `pilotsCache`), `state.js` (app state, landed/parked keys), `identity.js` (`initIdentity`), `roster.js` (`_syncPilotRoster`, pilot UI rebuild, crossing broadcast) |
| `ui/` | confirm dialog, toasts, haptics, swipe and pull-to-refresh, double-tap zoom, sheet swipe |
| `crew/` | `friends.js`, `visibility-and-profile.js` (crew visibility, identity UI, profile, next-trip widget, upload sheet), `off-days.js` (Off Days, crossings filter bar and tabs), `crossings.js` (`computeOverlap`), `intel.js` (Crew Intel) |
| `schedule/` | `airports-and-bases.js` (`normApt`, `sameApt`, bases over time, route progress), `load-pilot.js` (airport DB, `fetchPilotData`, `inferAwayLayovers`, `loadPilot`), `parsers-and-upload.js`, `sync.js` (Schedaero / ICS sync) |
| `netjets/` | `duty-and-tours.js`: on-duty and tour logic, CC schedules, home windows, tail and last-leg reminders |
| `views/` | `navigation.js` (`switchView`), `render.js` (`render()`, calendar and list), `day-detail.js`, `tooltips-and-time-format.js` (`tzAbbr`, `formatTimeISO`, tooltips) |
| `maps/` | `map-core.js` (`initMap`, world arcs), `route-map.js` (map modes, `renderMap`, all-pilots map), `day-map.js` (`renderDayMap`, `_legState`, plane icons) |
| `live/` | `flight-helpers.js` (callsigns, basemap, radar, landed-early), `calendar-list-polling.js` (grid/list live polling, label de-overlap), `live-tracking.js` (`startLiveTracking`) |
| `modals/` | `add-flight.js`: Add/Edit Flight, block totals, and the time helpers `flightLocalDate` / `flightUTCTime` |
| `profile/` | `my-info-and-netjets-tour.js`: My Info, rotations, NetJets tour modal |
| `admin/` | admin panel and dashboard |
| `pwa/` | `app-shell.js` (offline banner, install prompt, version, upload reminder, splash), `notifications.js` (push, in-app crossing alerts) |
| `wrapped/` | Wrapped / Year in Review |

The split (2026-11-16) was a pure move: the joined files reproduced the old single script exactly. Some helpers still sit where they did in the old file (the time helpers in `modals/add-flight.js`, for example). Move a function declaration to a better file whenever it's convenient; that's always safe.
