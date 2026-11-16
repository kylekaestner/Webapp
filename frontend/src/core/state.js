        // ── App state ─────────────────────────────────────────────────────
        let segments = [];          // currently loaded pilot's segments (camelCase)
        let viewDate = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(); // month shown in grid/list/map
        let currentPilot = 'kyle'; // whose schedule is displayed
        let currentView = 'grid';  // 'grid' | 'list' | 'map' | 'overlap'
        let map, mapLayers = { past: [], future: [], active: [], airports: [], labels: [] };
        let _offDayFilter = null; // Set of pilot keys included in Common Off Days; null = all
        const _livePollers  = {};    // callsign -> intervalId; cleared on every map render
        const _liveLabels   = new Map(); // callsign -> { markers, html, direction }
        // callsign -> a zero-arg function that re-renders just that flight's own label HTML from
        // its last-known poll data, without waiting for its next 8s poll. toggleShowSector() uses
        // this so flipping the FREQ toggle takes effect immediately instead of feeling laggy --
        // confirmed live that waiting on the natural poll cadence read as the button being broken.
        const _liveLabelRefreshers = new Map();
        // Keyed by `${callsign}|${scheduledArrMs}`, NOT bare callsign -- a same-day round trip can
        // legitimately reuse one real flight number/callsign both directions (confirmed live:
        // Delta files DL2417 for both ATL-MDW and MDW-ATL on the same tail). Keying by callsign
        // alone meant leg 1 landing early marked the shared callsign early-landed, and leg 2 --
        // which hadn't even departed -- inherited "LANDED EARLY" from it, bypassing every other
        // status check across the grid/list/map/day-map since this flag short-circuits all of
        // them first. Use _isLandedEarly(cs, arrMs) to check this set, never .has() directly.
        const _landedEarly  = new Set();
        function _landedEarlyKey(cs, arrMs) { return `${cs}|${arrMs || ''}`; }
        function _isLandedEarly(cs, arrMs) { return !!cs && _landedEarly.has(_landedEarlyKey(cs, arrMs)); }
        // Callsigns a live poll has actually confirmed parked/landed -- the opposite case from
        // _landedEarly (confirmed landed AFTER scheduled arrival, inside the grace window below).
        // Overrides the grace window immediately so a flight that really did land on schedule
        // doesn't sit tagged "in the air" for the full grace period.
        const _confirmedParked = new Set();
        // Callsign+scheduled-departure -> the TFMS ETD (ISO string) that confirmed it, for a leg
        // whose scheduled departure has passed with NO live evidence (ADS-B/SWIM/STDDS) found at
        // all yet. Grid/list used to show the full green "active"/pulsing glow the instant
        // scheduled departure passed, purely optimistic -- confirmed live (Brett's SCX3091,
        // delayed ~42min with ADS-B being rate-limited the whole time) that's actively misleading:
        // the cell looked "in the air" when nothing had actually confirmed it had even left the
        // gate. Checked at render() time, same "optimistic until proven otherwise, corrected by a
        // one-time re-render once the poller learns more" pattern as _confirmedParked above --
        // startCalListLivePolling() sets this (see its own comment) and triggers exactly one
        // render() on the transition, not a repeated one every poll tick. Composite-keyed by
        // departure time, same reasoning as _landedEarlyKey -- a recurring callsign's next leg
        // must never inherit a stale delayed flag from an earlier one.
        const _confirmedDelayed = new Map();
        function _delayedKey(cs, depMs) { return `${cs}|${depMs || ''}`; }
        function _getConfirmedDelayEtd(cs, depMs) { return cs ? _confirmedDelayed.get(_delayedKey(cs, depMs)) : undefined; }
        // One answer for "what is this leg doing right now", the same rules as the grid and list:
        // 'live' only once a position fix confirmed it (_confirmedLive), else 'delayed' / 'due' from the
        // live checks, else null (scheduled time has passed but nothing is confirmed yet, so no claim).
        // `active` is isFlightStillActive() && not landed early, worked out by the caller.
        function _legLiveState(cs, depMs, active) {
            if (!active || !cs) return null;
            const key = _delayedKey(cs, depMs);
            if (_confirmedLive.has(key)) return 'live';
            if (_getConfirmedDelayEtd(cs, depMs)) return 'delayed';
            if (_confirmedDue.has(key)) return 'due';
            return null;
        }
        // The day-detail sheet's status badge for that state (the live poller refreshes it while open).
        function _legStatusBadge(state, cs, depMs, depApt) {
            if (state === 'live') return '<span class="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400"><span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" style="animation:pulse 1.5s infinite"></span>In the air</span>';
            if (state === 'delayed') return `<span class="text-[10px] font-semibold" style="color:#f97316">Delayed · ETD ${formatTimeISO(_getConfirmedDelayEtd(cs, depMs), depApt)}</span>`;
            if (state === 'due') return '<span class="text-[10px] font-semibold" style="color:#eab308">Departure due</span>';
            return '';
        }
        // Same idea, same key shape, for the map's other non-active state: scheduled departure has
        // passed, still not found at all, but TFMS doesn't show a real delay either (no estimate,
        // or one too close to scheduled to count) -- the map's own _legState falls through to this
        // 'due' state as its actual default once nothing else applies, rather than ever assuming
        // "active" just because the clock says so. Kept as a separate flag from _confirmedDelayed
        // (not folded into one Map) since a leg can only ever be in one of these two states and
        // keeping them apart avoids one flag's stale value being misread as the other's.
        const _confirmedDue = new Set();
        // Confirmed by at least one real position fix (ADS-B/SWIM/STDDS) -- the ONLY thing that
        // earns the green "active/in the air" glow now. Confirmed live: Brett's SCX3091 visibly
        // flashed green (render()'s old optimistic default the instant scheduled departure passed)
        // then corrected to orange a moment later once the first poll came back -- not just
        // "wrong for a few seconds" but actively confusing, since green-then-orange reads as "the
        // app got it wrong," where neutral-then-colored reads as "it just found out." isActiveLeg
        // alone no longer implies the glow; a brand new leg starts in the same plain/neutral look
        // as a not-yet-departed one until this (or _confirmedDelayed/_confirmedDue) says otherwise,
        // which normally resolves within one poll cycle anyway.
        const _confirmedLive = new Set();
        // How long past scheduled arrival a flight is still worth treating as "maybe still
        // active" (showing live styling, kept eligible for live polling) instead of immediately
        // assuming it landed on schedule. Requested directly: a flight delayed on the ground
        // (e.g. a long ORD taxi-out) can push wheels-up, and therefore wheels-down, well past its
        // originally scheduled arrival -- the uploaded schedule itself is deliberately never
        // touched/updated with real times (that stays the pilot's own source of truth), but the
        // UI's own "is this flight done" classification can and should check real live/TFDM
        // status before assuming so. 90 minutes is generous enough to cover a serious ground
        // delay plus enroute time without tagging a truly-completed flight "in the air" for
        // unreasonably long on the rare flight live data is never available for.
        const LATE_ARRIVAL_GRACE_MS = 90 * 60 * 1000;
        // Shared by the grid, list, day-detail, and day-map classifications so "is this flight
        // still worth showing as active" means the same thing everywhere. `csig` is optional
        // (day-map's grouped popups don't always have one resolved at this point) -- the grace
        // window and schedule check still apply without it, just without the confirmed-parked
        // override.
        // The parked set is per session and per callsign, so a recurring flight number would stay excluded
        // on later days. Reset it when the local date changes; the server re-confirms what's still parked.
        let _confirmedParkedDay = null;
        // NetJets: one callsign flies every leg of the day, so "landed/parked" is tracked per leg
        // (callsign + departure airport) -- airline legs, each with their own flight number, keep
        // the plain callsign. A caller that passes no airport simply loses the parked short-circuit
        // for a NetJets leg (the normal 90-minute grace applies) -- never marks the wrong leg done.
        const _NJ_CS_RE = /^(EJA\d+|N\d+QS)$/;
        function parkedKey(cs, depApt) {
            return cs && depApt && _NJ_CS_RE.test(cs) ? cs + '|' + normApt(depApt) : cs;
        }
        function isFlightStillActive(depMs, arrMs, nowMs, csig, depApt) {
            if (!depMs) return false;
            const _today = _localToday();
            if (_today !== _confirmedParkedDay) { _confirmedParked.clear(); _confirmedParkedDay = _today; }
            if (csig && _confirmedParked.has(parkedKey(csig, depApt))) return false;
            // No known arrival estimate yet -- confirmed live 2026-10-31 on a real NetJets
            // auto-created leg: the server deliberately clears a stale/inconsistent arrival_time
            // to null rather than show "lands before it takes off" (see server.js's
            // _pollNetjetsLegCreation() refine step), but that meant a flight genuinely airborne
            // right now -- found:true on /api/live-position, real position data flowing -- never
            // got treated as active at all, since the old `!arrMs` check rejected it outright
            // before any live evidence was even consulted. Not knowing when it lands isn't the
            // same fact as it being over; only a confirmed-parked flag (checked above) or a real
            // arrival estimate (once one exists) should ever end the active window.
            if (!arrMs) return depMs <= nowMs;
            return depMs <= nowMs && nowMs <= arrMs + LATE_ARRIVAL_GRACE_MS;
        }
        // callsign -> the specific marker/arc/hit-line layer objects currently on the map for it.
        // _livePollers is cleared on every render, so it can't reliably tell a fresh
        // startLiveTracking() call "someone's already tracking this callsign" when two renders
        // overlap (e.g. a slow pilot-data fetch on first load racing a second render trigger) --
        // an older-but-faster render can finish drawing before a newer-but-slower one even starts,
        // leaving the newer one with no way to know a duplicate already exists. This registry is
        // the actual source of truth, independent of render timing: at most one set of layers may
        // exist per callsign, enforced directly in startLiveTracking() itself.
        const _liveLayersByCallsign = {};
        // pilot key -> the pin _pinLandedPilot() dropped at a landed flight's arrival airport. Lasts until
        // the next full redraw (it sits in mapLayers.active) or that pilot's next flight is in the air.
        const _landedPins = {};
        function _clearLandedPin(pilotKey) {
            (_landedPins[pilotKey] || []).forEach(l => { try { map.removeLayer(l); } catch (_) {} });
            delete _landedPins[pilotKey];
        }
        // The two below show a landed leg the way a redraw would, without one: a redraw restarts every
        // other live flight and refits the map. lines are the tracker's scheduled arc, already off the map.
        function _showLegAsFlown(lines, hits) {
            const style = mapDayMode ? { opacity: 0.25, weight: 2.5 } : mapAllMode ? { opacity: 0.35 } : { opacity: 0.45, color: '#6b7280' };
            lines.forEach((l, i) => {
                Object.assign(l.options, style, { className: '' });
                mapLayers.past.push(l);
                if (mapDayMode || mapAllMode || showPast) l.addTo(map);
                // The click target may have been reshaped to the filed route, and has to stay above the line.
                const h = hits.length === lines.length ? hits[i] : null;
                if (h) { h.setLatLngs(l.getLatLngs()); if (map.hasLayer(h)) h.bringToFront(); }
            });
        }
        function _pinLandedPilot(pilotKey, airport, coords) {
            if (!pilotKey || !airport || !coords || mapAllMode || hiddenPilots.has(pilotKey)) return;
            if (mapDayMode && mapDayDate !== _localToday()) return;
            _clearLandedPin(pilotKey);
            const name = (PILOT_NAMES[pilotKey] || pilotKey).split(' ')[0];
            const color = PILOT_COLORS[pilotKey] || '#94a3b8';
            const dotHtml = mapDayMode
                ? `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;--pc:${hexToRgba(color, 0.7)};--pc0:${hexToRgba(color, 0)};animation:here-pulse-plane 2s ease-out infinite"></div>`
                : `<div class="here-dot"></div>`;
            const labelHtml = mapDayMode
                ? `<div style="color:${color};font-size:11px;font-weight:800;text-shadow:0 1px 6px rgba(0,0,0,1),0 1px 6px rgba(0,0,0,1);background:rgba(0,0,0,0.45);border-radius:4px;padding:0 3px;transform:translate(-50%,10px);white-space:nowrap">${name}</div>`
                : `<div style="color:#d8b4fe;font-size:10px;font-weight:800;text-shadow:0 1px 4px rgba(0,0,0,0.9);transform:translate(-50%,8px);white-space:nowrap">${airport}</div>`;
            const popup = `<div style="font-weight:900;font-size:13px;color:#f8fafc;margin-bottom:4px">${name} is here</div><div style="font-size:12px;color:#c4b5fd">${airport} · Landed</div>`;
            const layers = [];
            WORLD_OFFSETS.forEach(w => {
                const at = [coords[0], coords[1] + w * 360];
                const pin = L.marker(at, { icon: L.divIcon({ className: '', html: dotHtml, iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 2000 });
                pin.bindPopup(popup, { className: 'dark-popup' });
                pin.addTo(map);
                const label = L.marker(at, { icon: L.divIcon({ className: '', html: labelHtml, iconAnchor: [0, 0] }), interactive: false }).addTo(map);
                layers.push(pin, label);
            });
            mapLayers.active.push(...layers);
            _landedPins[pilotKey] = layers;
        }
        // Two DIFFERENT real-world legs can share one callsign on the same day (confirmed live:
        // Delta's DL2417, both ATL-MDW and MDW-ATL) -- meaning two SEPARATE startLiveTracking()
        // closures can both be alive for the same callsign key. Each call gets its own instance
        // id so its update()/finishTracking()/scheduleNextPoll() can tell "am I still the one
        // currently registered for this callsign, or did a newer leg's activation already take
        // over" before touching any of the shared _liveLayersByCallsign/_livePollers/_liveLabels
        // state -- without this, a stale poller whose in-flight update() call is still running
        // the instant a newer leg tears it down finishes that update() anyway, re-arms its own
        // next timer regardless, and that orphaned timer is no longer reachable through
        // _livePollers[callsign] (the newer leg's id is there now) -- it keeps firing forever,
        // redrawing a long-dead flight's trail/route using fresh position data that actually
        // belongs to the newer leg, with no way for anything to ever cancel it short of a reload.
        let _liveTrackingInstanceSeq = 0;
        // callsign -> [{ marker, html, direction, hidden }] -- one entry per visible route-point
        // label (VOR/fix/waypoint name tags). Kept separate from _liveLabels (the plane's own
        // callsign tooltip) since there can be many per flight rather than exactly one, but fed
        // into the same deoverlapLiveLabels() pass so a fix's name tag can't collide with another
        // fix's tag OR with the live plane label itself.
        const _waypointLabels = new Map();
        let   _deoverlapTimer = null;
        const _calListPollers = {}; // callsign -> intervalId for calendar/list live badges

        let radarLayer = null, radarOn = false;
        // Route detail (VOR/fix/waypoint symbols + name tags on a live flight's remaining route) —
        // on by default, off hides the clutter when many simultaneous live flights make a busy
        // all-crew map hard to read. Persisted per-browser; a real per-viewer convenience, not
        // state that needs to be shared or read back server-side.
        let _routeDetailOn = true;
        try { _routeDetailOn = localStorage.getItem('cs_route_detail') !== '0'; } catch (_) {}
        // The button's own class can't be hardcoded to match this default in the static HTML --
        // confirmed live as the actual bug behind FREQ (see _showSectorOn below): the class only
        // ever got updated by toggleRouteDetail()'s own click handler, so a fresh page load (or a
        // stored '0' from a previous explicit turn-off) never re-synced the pill's visual on/off
        // state to match the real persisted value, and the two could silently disagree -- the
        // pill just reflects whatever this app happened to ship with in markup, not the real state.
        document.getElementById('btn-route-detail')?.classList.toggle('map-ctrl-on', _routeDetailOn);
        function toggleRouteDetail() {
            _routeDetailOn = !_routeDetailOn;
            try { localStorage.setItem('cs_route_detail', _routeDetailOn ? '1' : '0'); } catch (_) {}
            document.getElementById('btn-route-detail')?.classList.toggle('map-ctrl-on', _routeDetailOn);
            // Instant, not waiting on each flight's own next poll (up to 8s, which read as
            // sluggish) -- applyRouteDetailZoomTier() sweeps the shared marker objects in
            // _waypointLabels directly, no per-flight poll closure access needed. Same function
            // also handles the zoom-dependent tiers (see its own header comment), since both are
            // really the same "what should be visible right now" decision.
            applyRouteDetailZoomTier();
        }

        // Shows the real ATC frequency currently controlling a live flight (e.g. "124.625"),
        // resolved server-side from SFDPS's own sector handoff events against VATSIM's public
        // vNAS facility/frequency data -- see vnas.js. Off by default: it's extra clutter most of
        // the time, and only ever has something to show for a flight SWIM is tracking whose
        // sector actually resolves to a real vNAS-modeled position (not every real FAA facility
        // is modeled there -- see vnas.js's header). Same persisted-toggle pattern as Route
        // Detail above -- now also defaulting on the same way, per explicit request.
        let _showSectorOn = true;
        try { _showSectorOn = localStorage.getItem('cs_show_sector') !== '0'; } catch (_) {}
        // Real, confirmed-live bug this fixes: the button's static HTML never had the
        // "map-ctrl-on" class at all, so on every page load it rendered OFF regardless of
        // _showSectorOn's actual value (true by default, or whatever was last persisted) --
        // the button looked off, the real toggle underneath was frequently on, and the two
        // states had no way to ever reconcile since nothing but a click ever set this class.
        // Same sync-from-real-state fix as _routeDetailOn above, not just a one-off patch here.
        document.getElementById('btn-show-sector')?.classList.toggle('map-ctrl-on', _showSectorOn);
        function toggleShowSector() {
            _showSectorOn = !_showSectorOn;
            try { localStorage.setItem('cs_show_sector', _showSectorOn ? '1' : '0'); } catch (_) {}
            document.getElementById('btn-show-sector')?.classList.toggle('map-ctrl-on', _showSectorOn);
            // Confirmed live: without this, the badge only appeared/disappeared on each tracked
            // flight's own next 8s poll, which read as the button being laggy/broken rather than
            // instant. Each registered refresher rebuilds that one flight's label from its own
            // last-known poll data (see _liveLabelRefreshers' declaration comment) -- no network
            // round trip needed, just redrawing with data already in hand.
            for (const refresh of _liveLabelRefreshers.values()) refresh();
        }
        let showPast = true, showFuture = true;
        let airportVisibilityMap = {}, airportFlightTypes = {};
        // mapDayMode: show all pilots on a single chosen day
        // mapAllMode: show all pilots for the current month
        let mapDayMode = true;
        let mapAllMode = false;
        let mapRenderGen = 0; // incremented before every async render; stale renders check this
        const _localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
        let mapDayDate = _localToday();

        // PILOT_KEYS is the authoritative ordered list of pilot keys for the session.
        // Demo mode still starts with its fake fixture pilots (there's no real DB roster to load
        // for /demo). For a real session, this starts EMPTY and is populated entirely by
        // _syncPilotRoster() from /api/pilots-directory inside initIdentity() -- including the
        // 5 original pilots, which used to be hardcoded here directly. That hardcoding is what
        // caused the admin panel's airline/role display bugs (see db.js's coreRosterMigrated
        // migration): their real config lived only in source code, not in the DB the admin panel
        // actually reads, so editing them there silently did nothing. Now every pilot, old or
        // newly joined, goes through the exact same DB-backed registration path.
        // VALID_PILOTS is the same array reference -- always treat them as identical.
        const PILOT_KEYS   = _isDemo ? ['alex','morgan','casey','jordan'] : [];
        const VALID_PILOTS = PILOT_KEYS;

        // PILOT_COLORS / PILOT_NAMES / PILOT_ROLES / PILOT_HOME are plain objects, populated by
        // _syncPilotRoster() (see above) for a real session, or the fake demo roster below.
        const PILOT_COLORS = _isDemo
            ? { alex: '#3b82f6', morgan: '#2dd4bf', casey: '#f97316', jordan: '#818cf8' }
            : {};
        // Rotating palette for any pilot without a `color` set in the DB
        const hiddenPilots = new Set(); // pilot keys toggled off in the map legend
        const PILOT_NAMES = _isDemo
            ? { alex: 'Alex Rivera', morgan: 'Morgan Tate', casey: 'Casey Walsh', jordan: 'Jordan Ellis' }
            : {};
        function shortName(full) {
            if (!full) return full;
            const parts = String(full).trim().split(/\s+/);
            return parts.length < 2 ? parts[0] : parts[0] + ' ' + parts[parts.length - 1][0] + '.';
        }
        const PILOT_ROLES = _isDemo
            ? { alex: 'Major · ORD', morgan: 'Major · ATL', casey: 'Low-Cost · DEN', jordan: 'Major · JFK' }
            : {};
        const PILOT_HOME = _isDemo
            ? { alex: 'ORD', morgan: 'ATL', casey: 'DEN', jordan: 'JFK' }
            : {};

