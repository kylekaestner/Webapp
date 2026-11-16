        // ── Live flight tracking (OpenSky Network) ────────────────────────
        // deriveCallsign: converts a stored flight number to the ICAO callsign
        // used by OpenSky (e.g. 'RPA1234' -> 'RPA1234', 'SKW567' -> 'SKW567').
        // Returns null if no flight number -- single-aircraft ops have no callsign.
        function deriveCallsign(seg, pilotKey) {
            const fn = (seg.flightNumber || seg.flight_number || '').replace(/\s/g, '').toUpperCase();
            const carrier = pilotsCache[pilotKey]?.airline_code || '';
            if (fn) return normalizeFlightNum(fn, carrier) || null;
            if (carrier === 'SJJ') {
                // The real flight number SpiritJets actually uses is SJJ + the FIRST THREE
                // digits of the tail (confirmed: N176US -> SJJ176), not every digit in the tail
                // -- matters for any tail with more than three digits, which this used to get
                // wrong. Matches server.js's sjjFlightNumber(), which is also now the real source
                // of this value going forward (parseSchedaeroData() populates flight_number
                // directly) -- this client-side fallback only still matters for segments synced
                // before that fix.
                const digits = (seg.tail || '').replace(/\D/g, '').slice(0, 3);
                return digits ? `SJJ${digits}` : null;
            }
            if (carrier === 'EJA') {
                // NetJets' real ATC callsign is EJA + the FULL numeric run of the tail, no
                // truncation (confirmed: N14QS -> EJA14, N163QS -> EJA163, N22QS -> EJA22) --
                // matches server.js's ejaFlightNumber(). Manual entry only, no feed exists.
                const digits = (seg.tail || '').replace(/\D/g, '');
                return digits ? `EJA${digits}` : null;
            }
            return null;
        }

        // A NetJets pilot enters just the tail digits ("742") for convenience when saving a
        // tour's tail (same reasoning as the bare EJA callsign derivation above) -- but every
        // real NetJets tail is N + those digits + QS (confirmed: N14QS, N163QS, N22QS, N458QS),
        // so the full, correct tail is always deterministically reconstructible from the digits
        // alone. Display-only: never changes what's stored (segments.tail/pilot_tour_tail.tail
        // stay bare digits, which is also what deriveCallsign()'s EJA branch above needs), just
        // formats it everywhere a tail number is actually shown to a reader.
        function displayTail(tail, pilotKey) {
            if (!tail) return '';
            const carrier = pilotsCache[pilotKey]?.airline_code || '';
            if (carrier === 'EJA') {
                const digits = String(tail).replace(/\D/g, '');
                return digits ? `N${digits}QS` : tail;
            }
            return tail;
        }

        // A same-day round trip can reuse one real callsign both directions (confirmed live:
        // Delta's DL2417, ATL-MDW then MDW-ATL, same tail). If this pilot has another flight
        // segment today sharing this exact callsign with a LATER scheduled departure that has
        // already passed, a newer leg has definitively started -- CrewSync's own schedule can
        // tell these two legs apart even though the live feed itself can't (it's the same
        // real-world callsign either way). Shared by the live map poller's own lifecycle
        // (startLiveTracking()) and _legState()'s "active" determination (renderDayMap()) -- both
        // independently trusted live-seen evidence unconditionally before this existed, which is
        // exactly how leg 1 kept showing live/active using leg 2's genuinely-real position data.
        function _hasNewerLegStarted(pilotKey, callsign, ownDepMs) {
            if (!pilotKey || !callsign || !ownDepMs) return false;
            // This only reads the schedule clock. NetJets legs have their own evidence, and a cancelled or
            // late-running next leg isn't proof the last one ended (Mack's dropped AFW->MDW at 16:06Z
            // marked AFW->VNY completed mid-flight).
            if (_NJ_CS_RE.test(callsign)) return false;
            const segs = pilotsCache[pilotKey]?.segments;
            if (!segs || !segs.length) return false;
            // Cheap pre-filter before the real per-segment work below (flightUTCTime does a real
            // timezone lookup, deriveCallsign does string parsing) -- a pilot's cached segments
            // span their ENTIRE synced history (GET /api/pilots/:key returns it unbounded, a known
            // standing limitation), and this runs on every render AND every live poll tick (every
            // 3-8s) for every actively-tracked flight. Confirmed live this made the map noticeably
            // slow to load and the legend filter's re-render visibly blank for longer -- scanning
            // months of history on a tight timer adds up fast. A same-day round trip is only ever
            // a few hours apart, so a generous +/-48h window on the raw ISO date string (not a
            // parsed Date -- cheaper, and the window's already wide enough to absorb the
            // UTC-vs-local slop from comparing a UTC cutoff against a local-time date string)
            // discards the other 99%+ of a long history before any real work happens on what's left.
            const windowStart = new Date(ownDepMs - 48 * 3600000).toISOString().slice(0, 10);
            const windowEnd = new Date(ownDepMs + 48 * 3600000).toISOString().slice(0, 10);
            return segs.some(s => {
                if (s.type !== 'flight') return false;
                const sDep = s.departure_time || s.departureTime;
                if (!sDep) return false;
                const sDepDate = sDep.slice(0, 10);
                if (sDepDate < windowStart || sDepDate > windowEnd) return false;
                const sDepMs = flightUTCTime(sDep, s.departure_airport || s.departureAirport)?.getTime();
                if (!sDepMs || sDepMs <= ownDepMs || Date.now() < sDepMs) return false;
                return deriveCallsign(s, pilotKey) === callsign;
            });
        }

        // Is an earlier leg on this same callsign still open? One callsign can only be tracked one leg at
        // a time (startLiveTracking() tears down whatever that callsign had), so the next leg's route
        // preview waits until the aircraft is done with the leg before it.
        function _earlierLegOpen(pilotKey, callsign, ownDepMs, nowMs) {
            if (!pilotKey || !callsign || !ownDepMs) return false;
            const windowStart = new Date(ownDepMs - 48 * 3600000).toISOString().slice(0, 10);
            const ownDay = new Date(ownDepMs + 24 * 3600000).toISOString().slice(0, 10);
            return (pilotsCache[pilotKey]?.segments || []).some(s => {
                if (s.type !== 'flight' || s.auto_leg_cancelled || !s.departure_time) return false;
                const day = s.departure_time.slice(0, 10);
                if (day < windowStart || day > ownDay) return false;
                const dMs = flightUTCTime(s.departure_time, s.departure_airport)?.getTime();
                if (!dMs || dMs >= ownDepMs || deriveCallsign(s, pilotKey) !== callsign) return false;
                const aMs = flightUTCTime(s.arrival_time, s.arrival_airport)?.getTime();
                return isFlightStillActive(dMs, aMs, nowMs, callsign, s.departure_airport);
            });
        }

        function normalizeFlightNum(fn, carrier) {
            if (!fn) return '';
            for (const [iata, icao] of IATA_TO_CALLSIGN_ENTRIES) {
                if (fn.startsWith(iata) && /^\d+$/.test(fn.slice(iata.length))) return icao + fn.slice(iata.length);
            }
            if (carrier && /^\d+$/.test(fn)) return carrier + fn;
            return fn;
        }

        // FlightAware's dateless /live/flight/{ident} link resolves to whichever instance of that
        // ident is nearest to now — reliable for already-flown legs and anything departing soon, but
        // for a flight more than ~48h out it either shows the wrong day (recurring airline numbers)
        // or nothing at all (Kyle's corporate legs aren't filed with FlightAware until close to departure).
        // So the link is only offered inside that window; farther out we just show plain text.
        const FLIGHTAWARE_WINDOW_MS = 48 * 3600000;
        function flightAwareEligible(depMs) {
            return !depMs || depMs <= Date.now() + FLIGHTAWARE_WINDOW_MS;
        }
        // Wraps a flight ident (callsign) in a link to its FlightAware tracking page, opened in a new tab.
        // `eligible` (default true) gates whether the link is actually applied — see flightAwareEligible().
        function flightAwareLink(ident, displayHtml, eligible = true) {
            if (!ident || !eligible) return displayHtml || '';
            const url = `https://www.flightaware.com/live/flight/${encodeURIComponent(ident)}`;
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px" title="Track ${ident} on FlightAware">${displayHtml}</a>`;
        }

        function isPositionOnRoute(lat, lon, depCoords, arrCoords) {
            const routeDist  = haversineMi(depCoords[0], depCoords[1], arrCoords[0], arrCoords[1]);
            const distToDep  = haversineMi(lat, lon, depCoords[0], depCoords[1]);
            const distToArr  = haversineMi(lat, lon, arrCoords[0], arrCoords[1]);
            // A point on the great circle satisfies distToDep + distToArr ≈ routeDist.
            // Allow slack for ATC/weather deviations; anything more means a different aircraft.
            // A pure percentage is too tight for short regional hops: a real weather deviation
            // tends to add a roughly fixed number of extra miles (going around a storm cell),
            // which is a much bigger fraction of a short route than a long one. Confirmed live:
            // Drew's real ICT-IAH flight (~540mi) went around weather and was correctly identified
            // by ADS-B callsign, but exceeded the flat 25% slack (~135mi), which silently froze
            // the whole live display (icon position, flown trail, remaining arc all stopped
            // updating) instead of just skipping a route-conformance check that doesn't apply when
            // the deviation is real, not a misidentification. This app has its own weather radar
            // overlay specifically so a deviation like this can be seen and explained -- hiding the
            // live track the moment a real deviation happens defeats that. Biased generous: a
            // 300mi floor comfortably covers virtually any realistic ATC/weather reroute, and a
            // genuinely different aircraft would still be caught since that's typically off by far
            // more than this regardless of the route's own length.
            const slackMi = Math.max(routeDist * 0.25, 300);
            return (distToDep + distToArr) <= routeDist + slackMi;
        }

        // Base map detail, switchable (2026-11-03): CARTO restyled dark_all (fewer labels zoomed out,
        // lighter blue-grey water) and no longer serves the old look at any URL. Standard vs CARTO+
        // (next zoom level at half size). OpenFreeMap is the main map now, CARTO+ the automatic backup.
        // To go back to CARTO+ for everyone, set _basemapChoice to 'detail'.
        var BASEMAPS = { // var: addBasemap() can run before this line during startup
            carto: { label: 'CARTO', layers: [
                { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_2lne_1_90c175139aa497b3ce5034e5',
                  nolabels: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?key=cb1_2lne_1_90c175139aa497b3ce5034e5',
                  opts: { className: 'cs-basemap', subdomains: 'abcd', maxZoom: 19 } } ] },
            // Same CARTO style, one zoom level more detailed: next-zoom tiles drawn at half size (128px),
            // so more cities/roads/rivers show zoomed out, with smaller labels. Kept CARTO per Kyle 11/3.
            detail: { label: 'CARTO+', layers: [
                { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_2lne_1_90c175139aa497b3ce5034e5',
                  nolabels: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?key=cb1_2lne_1_90c175139aa497b3ce5034e5',
                  opts: { className: 'cs-basemap', subdomains: 'abcd', tileSize: 128, zoomOffset: 1, maxNativeZoom: 18, maxZoom: 19 } } ] },
            // Main map, drawn by MapLibre. A fixed credit: the plugin's own is read from the live map,
            // so it can't be removed on a switch.
            ofm: { label: 'OpenFreeMap', style: () => 'https://tiles.openfreemap.org/styles/dark',
                   credit: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
        };
        var _basemapChoice = 'ofm';
        var _basemapMaps = []; // [{ map, noLabels, layers }]
        function _canDrawVectorMap() {
            if (!L.maplibreGL) return false; // script didn't load
            try { return !!document.createElement('canvas').getContext('webgl'); } catch (_) { return false; }
        }
        function _basemapLayersFor(noLabels) {
            const pick = BASEMAPS[_basemapChoice];
            // Wrapped's no-labels map stays on CARTO.
            if (pick.style && !noLabels && _canDrawVectorMap()) return [L.maplibreGL({ style: pick.style(), attributionControl: { customAttribution: pick.credit } })];
            return (pick.style ? BASEMAPS.detail : pick).layers
                .filter(l => !(noLabels && l.labels))
                .map(l => L.tileLayer(noLabels && l.nolabels ? l.nolabels : l.url, l.opts));
        }
        // Falls back to CARTO+ for this session if the vector map fails to load, or keeps failing once loaded.
        function _watchBasemap(layer) {
            const gl = layer.getMaplibreMap?.();
            if (!gl) return;
            let loaded = false, errors = 0;
            const backup = () => { if (_basemapChoice === 'ofm') _setBasemap('detail'); };
            gl.once('load', () => { loaded = true; });
            gl.on('error', () => { if (!loaded || ++errors >= 5) backup(); });
            setTimeout(() => { if (!loaded && gl === layer.getMaplibreMap?.()) backup(); }, 15000);
        }
        function addBasemap(m, { noLabels = false } = {}) {
            if (!m) return;
            const entry = { map: m, noLabels, layers: _basemapLayersFor(noLabels) };
            entry.layers.forEach(l => { l.addTo(m); _watchBasemap(l); });
            _basemapMaps.push(entry);
        }
        function _setBasemap(choice) {
            _basemapChoice = choice;
            for (const e of _basemapMaps) {
                e.layers.forEach(l => { try { e.map.removeLayer(l); } catch (_) {} });
                e.layers = _basemapLayersFor(e.noLabels);
                e.layers.forEach(l => { l.addTo(e.map); l.bringToBack?.(); _watchBasemap(l); });
            }
        }

        function addRadarLayer() {
            if (!map) return;
            radarLayer = L.tileLayer(
                'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
                { opacity: 0.25, zIndex: 500, attribution: '© Iowa Env. Mesonet / NOAA NEXRAD' }
            );
            radarLayer.addTo(map);
        }

        function removeRadarLayer() {
            if (radarLayer && map) { map.removeLayer(radarLayer); radarLayer = null; }
        }

        function toggleRadar() {
            radarOn = !radarOn;
            document.getElementById('btn-radar')?.classList.toggle('map-ctrl-radar', radarOn);
            if (radarOn) addRadarLayer(); else removeRadarLayer();
        }

        function _saveLandedEarly(callsign, arrMs) {
            _landedEarly.add(_landedEarlyKey(callsign, arrMs));
            const today = _localToday();
            fetch(`${API_BASE}/early-landing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callsign, date: today, arrMs: arrMs || null, token: myToken })
            }).catch(() => {});
        }
        async function _reloadLandedEarly() {
            try {
                const today = _localToday();
                const data = await fetch(`${API_BASE}/early-landings?date=${today}`).then(r => r.json());
                // Server returns the same composite "callsign|arrMs" keys it was given --
                // add them as-is, don't re-derive a bare-callsign key here.
                const before = _landedEarly.size;
                (data.callsigns || []).filter(k => !_NJ_CS_RE.test(k.split('|')[0])).forEach(k => _landedEarly.add(k));
                return _landedEarly.size > before;
            } catch (_) { return false; }
        }

        // One report per leg shown as "departure due" 20+ min after its departure, with what the server
        // told the app. The server records its own state with it (/api/debug/stuck-due), so a stuck leg
        // can be looked at later. Never throws, never retries, nothing in demo or without a login.
        const _stuckDueSent = new Set();
        function _reportStuckDue(cs, depApt, arrApt, depMs, arrMs, view, seen) {
            try {
                if (!cs || !depMs || isDemo || !myToken || Date.now() - depMs < 20 * 60000) return;
                const key = `${cs}|${depMs}`;
                if (_stuckDueSent.has(key)) return;
                _stuckDueSent.add(key);
                fetch(`${API_BASE}/debug/stuck-due`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, callsign: cs, origin: depApt || null, dest: arrApt || null, depMs, arrMs: arrMs || null, view, seen: seen || null }),
                }).catch(() => {});
            } catch (_) {}
        }

        function stopLivePollers() {
            Object.values(_livePollers).forEach(id => clearInterval(id));
            for (const k in _livePollers) delete _livePollers[k];
            _liveLabels.clear();
            _liveLabelRefreshers.clear();
            stopCalListPollers();
            removeRadarLayer();
        }
        function stopCalListPollers() {
            Object.values(_calListPollers).forEach(id => clearInterval(id));
            for (const k in _calListPollers) delete _calListPollers[k];
        }
        // A NetJets row takes its real times from the server once the leg flies or lands. Picks them up
        // without a manual refresh, after the server's next leg pass has had time to write them.
        function _refetchNetjetsTimes(cs) {
            if (!_NJ_CS_RE.test(cs || '')) return;
            setTimeout(() => { if (currentPilot) loadPilot(currentPilot); }, 20000);
        }
