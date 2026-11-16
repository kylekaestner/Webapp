        function getAircraftCategory(typeCode) {
            if (!typeCode) return 'bizjet';
            const t = typeCode.toUpperCase();
            if (/^(PC12|PC6T?|TBM[679]|BE[12][09]|B190|SF34|C208|DHC[36]|P180|PAY[23]|C40[12]|C421|C441)/.test(t)) return 'turboprop';
            if (/^(B73[2-9M]|B73MAX|B752|B753|B727|A31[0-9]|A32[0-9]|A22[0-9]|MD[89][0-9]|DC9|B72[0-9]|B74[0-9]|B76[0-9]|B77[0-9]|B78[0-9]|A30[0-9]|A33[0-9]|A34[0-9]|A35[0-9]|A38[0-9])/.test(t)) return 'narrowbody';
            if (/^(E[17][0-9]{2}|E75[LS]|ERJ[0-9]|ER[0-9]|BCS[0-9]|RJ[0-9]{2}|SF3|D328|DH8)/.test(t)) return 'regional';
            return 'bizjet';
        }

        function hexToRgba(hex, a) {
            const n = parseInt(hex.replace('#', ''), 16);
            return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
        }

        function makePlaneIcon(bearing, color, typeCode, live = false) {
            const rot = Math.round(bearing);
            const cat = getAircraftCategory(typeCode);
            const shape = _AC_SHAPES[cat] || _AC_SHAPES.bizjet;
            const { vb, w, h, sw, d } = shape;
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}" style="overflow:visible;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.95));transform:rotate(${rot}deg);transform-origin:${w/2}px ${h/2}px">
                <path d="${d}" fill="${color}" stroke="rgba(0,0,0,0.7)" stroke-width="${sw}" stroke-linejoin="round"/>
            </svg>`;
            let html = svg;
            if (live) {
                const pc  = hexToRgba(color, 0.7);
                const pc0 = hexToRgba(color, 0);
                const ring = `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:12px;height:12px;border-radius:50%;--pc:${pc};--pc0:${pc0};animation:here-pulse-plane 2s ease-out infinite;pointer-events:none"></div>`;
                html = `<div style="position:relative;width:${w}px;height:${h}px">${ring}${svg}</div>`;
            }
            return L.divIcon({ className: '', html, iconSize: [w, h], iconAnchor: [w/2, h/2] });
        }

        // Route waypoint markers — one shape per navdata.js symbol classification, matching
        // familiar aeronautical-chart conventions: hexagon for a VOR-family navaid, small
        // bracketed circle for an NDB, open triangle for a classic airway fix/intersection,
        // diamond for an RNAV waypoint. 'airport'/'latlon'/null (TFMS's dense unnamed trajectory
        // samples — see resolveRouteWaypoints() in server.js) get no marker at all; the line
        // itself is enough for those; drawing a shape at every single TFMS trajectory sample
        // would be visual noise, not signal.
        // Shapes match real FAA sectional/enroute chart symbology (confirmed against the AIM/
        // Chart User's Guide conventions, not just eyeballed): a plain hexagon for a VOR, a
        // triangle for an intersection/fix, and an open four-point star for an RNAV/GPS
        // waypoint. Using the hollow "non-compulsory" rendering throughout (outline only, no
        // solid fill/center dot) rather than the filled "compulsory reporting point" variant --
        // requested directly, and also just reads better as a small map marker.
        const _WAYPOINT_SHAPES = {
            vor:      { color: '#60a5fa', svg: '<polygon points="5,0.5 9,2.8 9,7.2 5,9.5 1,7.2 1,2.8" fill="none" stroke="#60a5fa" stroke-width="1.3"/>' },
            ndb:      { color: '#a78bfa', svg: '<circle cx="5" cy="5" r="4" fill="none" stroke="#a78bfa" stroke-width="1.3" stroke-dasharray="2,1.6"/>' },
            fix:      { color: '#fbbf24', svg: '<polygon points="5,0.3 9.5,8.7 0.5,8.7" fill="none" stroke="#fbbf24" stroke-width="1.3"/>' },
            waypoint: { color: '#34d399', svg: '<path d="M5,0.4 C5.9,3.6 6.4,4.1 9.6,5 C6.4,5.9 5.9,6.4 5,9.6 C4.1,6.4 3.6,5.9 0.4,5 C3.6,4.1 4.1,3.6 5,0.4 Z" fill="none" stroke="#34d399" stroke-width="1.1" stroke-linejoin="round"/>' },
        };
        function makeWaypointIcon(symbol) {
            const shape = _WAYPOINT_SHAPES[symbol];
            if (!shape) return null;
            // Symbol only -- the name tag is a separate, managed Leaflet tooltip (see
            // registerWaypointLabel), not baked into this icon's HTML. That's what lets
            // deoverlapLiveLabels() reposition or hide a fix's tag independently of its symbol
            // when two fixes end up close together on screen.
            const html = `<svg width="10" height="10" viewBox="0 0 10 10" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85))">${shape.svg}</svg>`;
            return L.divIcon({ className: '', html, iconSize: [10, 10], iconAnchor: [5, 5] });
        }

        // Binds a permanent name-tag tooltip to every world-copy marker for one waypoint, and
        // registers it with deoverlapLiveLabels() so it collides correctly with other fix tags and
        // the plane label, instead of always sitting in one fixed spot. `isActiveFix` marks the
        // single next upcoming fix (the one the aircraft is currently headed toward) -- used by
        // applyRouteDetailZoomTier() to decide what's visible at the current zoom level.
        function registerWaypointLabel(callsign, markers, name, color, isActiveFix) {
            // Small, plain, chart-style text (requested directly) -- no
            // background pill (see .wp-label), just the symbol's own accent color plus a dark
            // text-shadow for contrast against whatever's on the map underneath.
            const html = `<span style="font-size:8px;font-weight:600;color:${color};letter-spacing:.02em;text-shadow:0 0 2px #000,0 0 2px #000,0 1px 1px #000">${name}</span>`;
            const opts = { permanent: true, className: 'wp-label', direction: 'right', offset: [8, 0] };
            // Bind to EVERY world-copy marker, not just the primary (offset-0) one -- confirmed
            // live this was a real bug, not just a simplification: if the map happens to be panned
            // to a different world copy than offset-0 (entirely normal while panning/zooming a
            // live map), the one marker carrying the tooltip sits tens of thousands of pixels
            // off-screen (a full world-width away) while the world copy actually on screen has no
            // tooltip bound to it at all -- every CSS check (display/visibility/opacity) looks
            // perfectly fine because the element genuinely exists, just not where anyone can see
            // it. The plane's own label already avoided this by binding to all 5 copies; this
            // didn't, because it copied the "pick one primary copy" pattern from the POSITION-calc
            // logic (where that's fine) rather than the label-binding logic (where it isn't).
            markers.forEach(m => {
                m.bindTooltip(html, opts);
                // bindTooltip's "permanent" auto-open doesn't reliably fire on a marker created
                // with interactive:false (it's wired through the same path as hover-open, which an
                // uninteractive layer never receives) -- forcing it open sidesteps that regardless
                // of Leaflet's interactive-layer quirks.
                m.openTooltip();
            });
            if (!_waypointLabels.has(callsign)) _waypointLabels.set(callsign, []);
            _waypointLabels.get(callsign).push({ markers, html, direction: 'right', hidden: false, isActiveFix: !!isActiveFix });
        }

        // Zoom-dependent progressive disclosure (requested directly):
        // zoomed out far, every fix shows as a bare symbol with no name tag (avoids a wall of
        // overlapping text at a scale where none of it would be legible anyway); at a middle zoom,
        // only the single next fix the aircraft is actually headed toward is shown at all (symbol
        // + label), decluttering a long multi-fix STAR/airway chain down to just what matters
        // right now; zoomed in close, everything shows in full (every fix, every label). Applied
        // directly to the shared marker objects in _waypointLabels (same ones used for both the
        // symbol icon and its tooltip) so this is instant on a zoom change or the Route Detail
        // toggle, not dependent on any one flight's own ~8s poll cycle.
        // Lowered from 6/9 -- confirmed live those required zooming in much closer than a
        // flight's typical live-tracking view (country/regional scale) before any fix label
        // showed at all.
        const ZOOM_SHOW_ACTIVE_ONLY = 4; // below this: all symbols, no labels at all
        const ZOOM_SHOW_ALL_FIXES   = 7; // at/above this: every fix + label; between: active fix only
        function applyRouteDetailZoomTier() {
            if (!map) return;
            const zoom = map.getZoom();
            for (const entries of _waypointLabels.values()) {
                for (const entry of entries) {
                    // Symbols always show whenever Route Detail is on, at every zoom tier -- only
                    // the LABEL (name tag) visibility varies by zoom. Confirmed live this was
                    // wrong: the middle tier used to also drop showSymbol to isActiveFix, hiding
                    // every non-active fix's symbol entirely instead of just its name tag.
                    let showLabel = true;
                    const showSymbol = _routeDetailOn;
                    if (!_routeDetailOn) {
                        showLabel = false;
                    } else if (zoom < ZOOM_SHOW_ACTIVE_ONLY) {
                        showLabel = false;
                    } else if (zoom < ZOOM_SHOW_ALL_FIXES) {
                        showLabel = entry.isActiveFix;
                    } // else: zoomed in close -- every fix's label shows too, full detail
                    entry.markers.forEach(m => {
                        try {
                            m.setOpacity(showSymbol ? 1 : 0);
                            if (showLabel) m.openTooltip(); else m.closeTooltip();
                        } catch (_) {}
                    });
                }
            }
        }

        async function renderDayMap() {
            const gen = mapRenderGen;
            if (!map) return;
            stopLivePollers();
            [...mapLayers.past, ...mapLayers.future, ...mapLayers.active, ...mapLayers.airports, ...mapLayers.labels].forEach(l => map.removeLayer(l));
            mapLayers = { past: [], future: [], active: [], airports: [], labels: [] };

            mapDayDate = mapDayDate || _localToday();

            // Day view uses the pilot-name legend
            document.getElementById('legend-single')?.classList.add('hidden');
            document.getElementById('legend-day')?.classList.remove('hidden');
            _updateCrewLegend();

            // Load all visible pilots (cache where possible)
            const visiblePilots = getCrewVisible();
            const allPilotSegments = {};
            await Promise.all(visiblePilots.map(async (key) => {
                if (!pilotsCache[key]) {
                    try { await _loadPilotOnce(key); } catch (e) { return; }
                }
                const data = pilotsCache[key];
                if (!data || !data.segments) return;
                allPilotSegments[key] = data.segments
                    .filter(seg => !seg.auto_leg_cancelled)
                    .map(seg => ({
                        id: seg.id, type: seg.type,
                        departureTime: seg.departure_time, arrivalTime: seg.arrival_time,
                        departureAirport: seg.departure_airport, arrivalAirport: seg.arrival_airport,
                        tail: seg.tail || '', flightNumber: seg.flight_number || '',
                        dh: seg.is_dh ? true : false, blockMinutes: seg.block_minutes || null,
                        trip: seg.trip || null
                    }));
            }));
            if (gen !== mapRenderGen) return;

            const now = new Date();
            const bounds = [];

            // Client-side _confirmedParked starts empty on every page load, so a flight that landed
            // inside its 90-min grace window would otherwise look airborne and drop its pilot's pin.
            const _activeCs = new Set();
            // callsign -> departure airport, for the server-side origin cross-check below (see
            // server.js's matchesExpectedOrigin() / this same fix applied to /api/flight-status).
            // First-seen wins if two of OUR OWN segments genuinely share one callsign the same day
            // (a same-day round trip) -- that specific case is already handled by the time-based
            // _hasNewerLegStarted()/depHasPassed logic elsewhere, not by this map, so one entry here
            // is enough; this map exists for the OTHER case, where the real-world reuse isn't even
            // in our own data at all (confirmed live: Sam's RPA4605 LGA-TUL vs. Republic's own
            // genuine TUL-LGA return under the same number, a flight that isn't anyone's segment
            // in this app -- without telling the server which origin we actually mean, its real,
            // currently-airborne evidence got attributed to Sam's already-landed leg instead).
            const _csOrigin = new Map();
            // Same first-seen-wins pairing as _csOrigin, but the scheduled ARRIVAL -- lets the
            // server's own staleness check (notStale() in /api/flight-status, see its comment)
            // tell a flat-TTL evidence proxy that's coasting well past this specific leg's own
            // arrival apart from a later, unrelated flight reusing the same callsign. Confirmed
            // live on Brett's AAL2987 DH (PHL-CVG): his leg had genuinely landed, but the server's
            // airborne/times evidence stayed "true" off a stale fallback that happened to
            // origin-match his own leg (the real fix was adding TFDM as a second origin source --
            // see server.js -- this arrival param is the defense-in-depth backstop for whenever
            // neither TFMS nor TFDM has anything cached for the current message at all).
            const _csArrival = new Map();
            const _csOriginDep = new Map();
            // NetJets legs asked about one by one (callsign~origin~arrival) -- see parkedKey().
            const _njLegs = [];
            Object.entries(allPilotSegments).forEach(([key, segs]) => segs.forEach(f => {
                const cs = deriveCallsign(f, key);
                if (!cs) return;
                const d = flightUTCTime(f.departureTime, f.departureAirport);
                const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                // Long enough after arrival for the server to confirm the flight flew, so it can be marked completed.
                const inWindow = (d && a) && now.getTime() >= d.getTime() - PREFLIGHT_ROUTE_MS && now.getTime() <= a.getTime() + 4 * 60 * 60 * 1000;
                if (inWindow) {
                    _activeCs.add(cs);
                    // The latest leg that has started, else the next one. A round trip on one flight number
                    // asked with the first leg's origin got nothing for the second (Logan's 3716 SAN-LAX).
                    const started = d.getTime() <= now.getTime();
                    if (f.departureAirport && (!_csOrigin.has(cs) || (started && d.getTime() > (_csOriginDep.get(cs) || 0)))) {
                        _csOrigin.set(cs, f.departureAirport);
                        _csArrival.set(cs, a.toISOString());
                        if (started) _csOriginDep.set(cs, d.getTime());
                    }
                    if (_NJ_CS_RE.test(cs) && f.departureAirport && a) _njLegs.push(cs + '~' + f.departureAirport + '~' + a.toISOString());
                }
            }));
            // Airborne on the day map needs real evidence: a live position seen in the last few minutes,
            // or the server having seen the aircraft airborne and no live contact since it should have
            // landed. A scheduled departure time alone isn't evidence (the aircraft may still be at the gate).
            const liveSeen = new Set();
            const airborneSeen = new Set();
            const onGroundSeen = new Set();
            const estTimes = {};
            let legEv = {};
            if (_activeCs.size) {
                try {
                    const _csList = [..._activeCs];
                    const _originsQs = _csList.map(cs => _csOrigin.get(cs) || '').join(',');
                    const _arrivalsQs = _csList.map(cs => _csArrival.get(cs) || '').join(',');
                    const st = await fetch(`${API_BASE}/flight-status?callsigns=${encodeURIComponent(_csList.join(','))}&origins=${encodeURIComponent(_originsQs)}&arrivals=${encodeURIComponent(_arrivalsQs)}${_njLegs.length ? '&njlegs=' + encodeURIComponent(_njLegs.join(',')) : ''}`).then(r => r.json());
                    const parkedNow = new Set(st.parked || []);
                    [..._activeCs].filter(cs => !_NJ_CS_RE.test(cs)).forEach(cs => { if (parkedNow.has(cs)) _confirmedParked.add(cs); else _confirmedParked.delete(cs); });
                    legEv = st.perLeg || {};
                    Object.entries(legEv).forEach(([k, e]) => { const [lcs, lorig] = k.split('~'); const pk = parkedKey(lcs, lorig); if (e.parked) _confirmedParked.add(pk); else _confirmedParked.delete(pk); });
                    (st.live || []).forEach(cs => liveSeen.add(cs));
                    (st.airborne || []).forEach(cs => airborneSeen.add(cs));
                    Object.keys(st.onGround || {}).forEach(cs => onGroundSeen.add(cs));
                    Object.assign(estTimes, st.times || {});
                } catch (e) {}
                if (gen !== mapRenderGen) return;
            }
            // One place that decides a leg's state on the day map and in here-now.
            //  active     - seen flying: a live position, or airborne evidence and not yet past the estimated arrival
            //  completed  - landed early or parked; or seen flying and past the estimated arrival; or no flying
            //               evidence at all but three hours past the estimated arrival
            //  scheduled  - before scheduled departure
            //  delayed    - departure time passed, not seen flying, estimated departure at least 5 minutes later
            //  due        - departure time passed, not seen flying, no delay estimate
            const _legState = (cs, dMs, aMs, landedEarlyFlag, pilotKey, origin) => {
                const nowMs = now.getTime();
                // NetJets: this leg's own evidence (see parkedKey) instead of the callsign's
                const ev = origin ? legEv[cs + '~' + origin] : null;
                // Only legs near now get their own evidence. A later NetJets leg can't use the callsign's:
                // it's the leg being flown, or a ramp with the APU on, and every later leg read as active
                // and took over the tracker, so the last leg of the day held the plane. An airline leg
                // can leave a little early, but tomorrow's same flight number isn't today's (Logan's SKW3502).
                // Same for a NetJets leg long finished: James's CLT-BHM read as live during MSL-MRF.
                const isNj = _NJ_CS_RE.test(cs || '');
                const notYet = !!dMs && nowMs < dMs && (isNj || dMs - nowMs > PREFLIGHT_ROUTE_MS);
                const longDone = isNj && !!aMs && nowMs > aMs + 3 * 3600000;
                const noCsEvidence = !ev && (notYet || longDone);
                const T = ev ? (ev.times || {}) : noCsEvidence ? {} : (estTimes[cs] || {});
                const isLive = ev ? !!ev.live : !noCsEvidence && liveSeen.has(cs);
                const isAirborne = ev ? !!ev.airborne : !noCsEvidence && airborneSeen.has(cs);
                const isParked = ev ? !!ev.parked : !noCsEvidence && _confirmedParked.has(cs);
                const etaMs = T.eta ? new Date(T.eta).getTime() : 0;
                const effA = Math.max(aMs || 0, etaMs);
                const etdMs = T.etd ? new Date(T.etd).getTime() : null;
                const flown = !!cs && (isAirborne || isLive || isParked);
                // A same-day round trip can legitimately share one real flight number/callsign
                // both directions (confirmed live: Delta's own feed files DL2417 for both
                // ATL-MDW and MDW-ATL on the same tail) -- evidence tied only to the callsign,
                // not to this specific leg, can't be trusted until THIS leg's own scheduled
                // departure has actually passed. Without this guard, leg 1 landing and sitting
                // parked at the gate marked the shared callsign "parked," and leg 2 -- which
                // hadn't even left the gate yet -- inherited "completed" from it. liveSeen is
                // exempt from THIS guard: a real live position confirmed just now is authoritative
                // regardless of scheduled time (e.g. an early departure), not stale cross-leg
                // evidence -- but that exemption cuts the other way too: confirmed live, it let a
                // COMPLETED leg (ATL-MDW) show "in the air" using leg 2's (MDW-ATL) genuinely-real
                // position the instant leg 2 departed, since nothing checked whether a newer leg
                // had actually started before trusting liveSeen. _hasNewerLegStarted() closes that
                // specific gap without weakening the early-departure case it was added for.
                const depHasPassed = !!dMs && nowMs >= dMs;
                const newerLegStarted = _hasNewerLegStarted(pilotKey, cs, dMs);
                // The airline's own real OOOI report (actual touchdown / actual gate arrival),
                // not an estimate -- confirmed live as a real gap: our own position-polling
                // pipeline (parked/live/airborne below) can simply miss a landing entirely if it
                // never had an active position fix right at touchdown, leaving a genuinely-landed
                // flight stuck showing DELAYED with a stale ETD. TFMS already knows regardless,
                // independent of whether we ourselves caught the moment it happened.
                // Checked AFTER liveSeen below, deliberately -- if we're still actively tracking a
                // real position (e.g. visibly taxiing in), that's still worth showing as active,
                // not short-circuited to completed the instant touchdown occurs. This is purely a
                // fallback for when there's NO current live data to show at all -- the exact gap
                // this exists for.
                const realOnMs = T.airlineOnTime ? new Date(T.airlineOnTime).getTime() : null;
                if (landedEarlyFlag) return { state: 'completed' };
                if (newerLegStarted) return { state: 'completed' };
                if (cs && depHasPassed && isParked && !isLive) return { state: 'completed' };
                // A later leg on the same callsign (SKW3716 SAN-LAX) can't take the live position while the
                // earlier one (LAX-SAN) is still open: that position is the earlier leg's.
                const earlierOpen = !depHasPassed && _earlierLegOpen(pilotKey, cs, dMs, nowMs);
                if (cs && isLive && !earlierOpen) return { state: 'active' };
                if (cs && depHasPassed && isAirborne && nowMs < effA) return { state: 'active' };
                if (realOnMs && nowMs >= realOnMs) return { state: 'completed' };
                if (flown && nowMs >= effA) return { state: 'completed' };
                if (!flown && effA && nowMs >= effA + 3 * 3600000) return { state: 'completed' };
                if (!dMs || nowMs < dMs) return { state: 'scheduled' };
                if (etdMs && etdMs - dMs >= 5 * 60000) return { state: 'delayed', etdMs };
                return { state: 'due', etdMs };
            };

            // Flatten all day flights with pilot key attached
            const allDayFlights = [];
            visiblePilots.forEach(pilotKey => {
                if (hiddenPilots.has(pilotKey)) return;
                const segs = allPilotSegments[pilotKey];
                if (!segs) return;
                segs.filter(s => s.type === 'flight' && s.departureTime && flightLocalDate(s.departureTime, s.departureAirport) === mapDayDate)
                    .forEach(f => allDayFlights.push({ ...f, pilotKey }));
            });

            // Prefetch city names for all airports appearing today
            const _dayAptCodes = [...new Set(allDayFlights.flatMap(f => [f.departureAirport, f.arrivalAirport]).filter(Boolean))];
            await _prefetchCities(_dayAptCodes);
            if (gen !== mapRenderGen) return;

            // Group by city pair (sorted) to detect overlapping routes
            const pairGroups = {};
            allDayFlights.forEach(f => {
                if (!f.departureAirport || !f.arrivalAirport) return;
                const key = [f.departureAirport, f.arrivalAirport].sort().join('|');
                if (!pairGroups[key]) pairGroups[key] = [];
                pairGroups[key].push(f);
            });

            // Airport presence map: apt → { pilots, flights }
            const aptData = {};
            const addApt = (apt, f) => {
                if (!aptData[apt]) aptData[apt] = { pilots: new Set(), flights: [] };
                aptData[apt].pilots.add(f.pilotKey);
                aptData[apt].flights.push(f);
            };

            // Draw routes
            allDayFlights.forEach(f => {
                const depCoords = resolveAirport(f.departureAirport);
                const arrCoords = resolveAirport(f.arrivalAirport);
                if (!depCoords || !arrCoords) return;

                addApt(f.departureAirport, f);
                addApt(f.arrivalAirport, f);

                const depTime = flightUTCTime(f.departureTime, f.departureAirport) || new Date(f.departureTime);
                const arrTime = flightUTCTime(f.arrivalTime || f.departureTime, f.arrivalAirport) || new Date(f.arrivalTime || f.departureTime);
                const _cs = deriveCallsign(f, f.pilotKey);
                const landedEarly = _isLandedEarly(_cs, arrTime?.getTime());
                const _st = _legState(_cs, depTime?.getTime(), arrTime?.getTime(), landedEarly, f.pilotKey, f.departureAirport);
                const isActive = _st.state === 'active';
                const isPast = _st.state === 'completed';
                const _delayed = _st.state === 'delayed';
                const _etdMs = _st.etdMs;
                if (_st.state === 'due') _reportStuckDue(_cs, f.departureAirport, f.arrivalAirport, depTime?.getTime(), arrTime?.getTime(), 'map',
                    { live: liveSeen.has(_cs), airborne: airborneSeen.has(_cs), parked: _confirmedParked.has(_cs), ev: legEv[_cs + '~' + f.departureAirport] || null, times: estTimes[_cs] || null });
                const color = PILOT_COLORS[f.pilotKey];

                // Offset index within pair group
                const pairKey = [f.departureAirport, f.arrivalAirport].sort().join('|');
                const group = pairGroups[pairKey];
                const offsetIdx = group.indexOf(f);
                const arcCoords = offsetArc(depCoords, arrCoords, 60, offsetIdx, group.length);
                bounds.push(arcCoords[0], arcCoords[Math.floor(arcCoords.length / 2)], arcCoords[arcCoords.length - 1]);

                const weight  = isActive ? 4.5 : 2.5;
                const opacity = isActive ? 1.0 : isPast ? 0.25 : 0.7;
                const dayLineOpts = { weight, opacity, color, smoothFactor: 1 };
                if (isActive) dayLineOpts.className = 'active-route';
                const arcU = unwrapLongitudes(arcCoords);
                const dayLines = worldLines(arcU, dayLineOpts);
                dayLines.forEach(l => l.addTo(map));
                const [line] = dayLines;
                const dayHits = worldLines(arcU, { weight: 20, opacity: 0, className: 'map-hit' });

                const blockMins = calcBlockMins(f);
                const _pilotFirst = (PILOT_NAMES[f.pilotKey] || '').split(' ')[0];
                const _statusLine = isActive
                    ? `<div class="live-status-line" style="font-size:10px;color:#22c55e;font-weight:800;letter-spacing:.04em;margin-top:6px">▶ ${onGroundSeen.has(_cs) ? 'TAXIING IN' : 'IN THE AIR'}</div>`
                    : isPast
                    ? `<div class="live-status-line" style="font-size:10px;color:#3f3f46;font-weight:800;letter-spacing:.04em;margin-top:6px">✓ ${landedEarly ? 'LANDED EARLY' : 'COMPLETED'}</div>`
                    : (depTime && depTime <= now && _delayed)
                    ? `<div class="live-status-line" style="font-size:10px;color:#f97316;font-weight:800;letter-spacing:.04em;margin-top:6px">DELAYED · ETD ${formatTimeISO(new Date(_etdMs).toISOString(), f.departureAirport)}</div>`
                    : (depTime && depTime <= now)
                    ? `<div class="live-status-line" style="font-size:10px;color:#eab308;font-weight:800;letter-spacing:.04em;margin-top:6px">DEPARTURE DUE</div>`
                    : `<div class="live-status-line" style="font-size:10px;color:#3b82f6;font-weight:800;letter-spacing:.04em;margin-top:6px">DEPARTS IN ${formatDurationMinutes(Math.round((depTime - now) / 60000))}</div>`;

                // TFMS estimates (display-only, the uploaded schedule above is never changed). Shown only
                // when they differ from the scheduled time by at least 5 minutes.
                const _est = _cs ? (legEv[_cs + '~' + f.departureAirport]?.times || (_NJ_CS_RE.test(_cs) || depTime - now > PREFLIGHT_ROUTE_MS ? null : estTimes[_cs])) : null;
                const _estDep = _est?.etd && depTime && Math.abs(new Date(_est.etd) - depTime) >= 5 * 60000 ? _est.etd : null;
                const _estArr = _est?.eta && arrTime && Math.abs(new Date(_est.eta) - arrTime) >= 5 * 60000 ? _est.eta : null;
                const _arrDiffMin = _est?.eta && arrTime ? Math.round((new Date(_est.eta) - arrTime) / 60000) : null;
                const _arrNote = _arrDiffMin == null ? '' : _arrDiffMin <= -5 ? ` <span style="color:#4ade80">· ${-_arrDiffMin}m early</span>` : _arrDiffMin >= 15 ? ` <span style="color:#f87171">· ${_arrDiffMin}m late</span>` : '';
                // One compact line: estimated times and how they compare to the uploaded schedule.
                // Labelled the way ops people read them: ETD/ETA, with the arrival's difference from the schedule.
                const _depDiffMin = _estDep && depTime ? Math.round((new Date(_estDep) - depTime) / 60000) : null;
                const _depNote = _depDiffMin == null ? '' : _depDiffMin >= 5 ? ` <span style="color:#f87171">(+${_depDiffMin}m)</span>` : _depDiffMin <= -5 ? ` <span style="color:#4ade80">(${_depDiffMin}m)</span>` : '';
                const _estLine = (_estDep || _estArr)
                    ? `<div style="font-size:10px;color:#93c5fd;font-weight:700;margin-bottom:3px;white-space:nowrap">${_estDep ? `ETD ${formatTimeISO(_estDep, f.departureAirport)}${_depNote}` : ''}${_estDep && _estArr ? ' · ' : ''}${_estArr ? `ETA ${formatTimeISO(_estArr, f.arrivalAirport)}${_arrNote}` : ''}</div>`
                    : '';
                const dayPopup = `
                    <div style="font-weight:900;font-size:13px;color:#f8fafc;line-height:1.2;white-space:nowrap">${aptLabel(f.departureAirport, f.pilotKey)} → ${aptLabel(f.arrivalAirport, f.pilotKey)}<span style="font-size:10px;font-weight:700;margin-left:6px"><span style="color:${color}">${_pilotFirst}</span>${_cs ? `<span style="color:#475569"> · ${flightAwareLink(_cs, _cs, flightAwareEligible(depTime?.getTime()))}</span>` : ''}</span></div>
                    <div style="font-size:10px;color:#94a3b8;margin-top:2px">${formatTimeISO(f.departureTime, f.departureAirport)} <span style="opacity:.5">${tzAbbr(f.departureAirport, f.departureTime)}</span> – ${formatTimeISO(f.arrivalTime, f.arrivalAirport)} <span style="opacity:.5">${tzAbbr(f.arrivalAirport, f.arrivalTime)}</span>${blockMins ? `<span style="color:#52525b"> · ${formatDurationMinutes(blockMins)}</span>` : ''}${f.tail ? `<span style="color:#3f3f46"> · ${displayTail(f.tail, f.pilotKey)}</span>` : ''}</div>
                    ${_statusLine}
                `;
                dayHits.forEach(h => { h.bindPopup(dayPopup, { className: 'dark-popup day-popup', maxWidth: 230 }); h.addTo(map); });
                dayLines.forEach(l => mapLayers.future.push(l));
                dayHits.forEach(h => mapLayers.future.push(h));

                // Live airplane icon — placed at interpolated position, then updated via ADS-B
                if (isActive) {
                    const progress = Math.min(1, Math.max(0, (now - depTime) / (arrTime - depTime)));
                    const dotIdx = Math.min(Math.floor(progress * (arcCoords.length - 1)), arcCoords.length - 2);
                    const dotPos = arcCoords[dotIdx];
                    const nextPos = arcCoords[dotIdx + 1] || arcCoords[dotIdx];
                    const bearing = computeBearing(dotPos, nextPos);
                    const dots = worldPlaneMarkers(dotPos, makePlaneIcon(bearing, color, null, true));
                    dots[2].bindTooltip(`✈ ${(PILOT_NAMES[f.pilotKey] || '').split(' ')[0]} — in the air`, { permanent: false, className: 'dark-popup' });
                    dots.forEach(d => mapLayers.active.push(d));
                    const cs = deriveCallsign(f, f.pilotKey);
                    if (cs) startLiveTracking(dots, cs, color, depCoords, arrCoords, dayLines, mapLayers.active, (PILOT_NAMES[f.pilotKey] || '').split(' ')[0], arrTime, [], weight, dayHits, depTime, f.pilotKey, f.departureAirport, f.arrivalAirport);
                } else if (!landedEarly && isPreflightWindow(depTime?.getTime(), now.getTime(), arrTime?.getTime())
                    && !_earlierLegOpen(f.pilotKey, deriveCallsign(f, f.pilotKey), depTime?.getTime(), now.getTime())) {
                    // Preflight — within PREFLIGHT_ROUTE_MS of departure but not airborne yet.
                    const dots = worldPlaneMarkers(depCoords, makePlaneIcon(computeBearing(depCoords, arrCoords), color, null, true));
                    dots.forEach(d => mapLayers.active.push(d));
                    const cs = deriveCallsign(f, f.pilotKey);
                    if (cs) startLiveTracking(dots, cs, color, depCoords, arrCoords, dayLines, mapLayers.active, (PILOT_NAMES[f.pilotKey] || '').split(' ')[0], arrTime, [], weight, dayHits, depTime, f.pilotKey, f.departureAirport, f.arrivalAirport);
                }
            });

            // Airport markers
            Object.entries(aptData).forEach(([apt, data]) => {
                const coords = resolveAirport(apt);
                if (!coords) return;

                const pilotList = [...data.pilots];
                // Single pilot = their color; multiple pilots = white
                const fillColor = pilotList.length === 1 ? PILOT_COLORS[pilotList[0]] : '#ffffff';
                const strokeColor = pilotList.length === 1 ? '#000' : '#64748b';

                const aptDotOpts = { radius: 5, fillColor, fillOpacity: 0.95, color: strokeColor, weight: 1.5 };
                const circles = worldDots(coords, aptDotOpts);
                const [circle] = circles;
                circles.forEach(c => { c.addTo(map); mapLayers.airports.push(c); });

                // Popup: which pilots, which flights (primary circle only)
                const flightLines = data.flights.map(f =>
                    `<div style="font-size:11px;color:${PILOT_COLORS[f.pilotKey]};margin-top:3px">` +
                    `${(PILOT_NAMES[f.pilotKey] || '').split(' ')[0]}: ${aptLabel(f.departureAirport, f.pilotKey)}→${aptLabel(f.arrivalAirport, f.pilotKey)} ${formatTimeISO(f.departureTime, f.departureAirport)}</div>`
                ).join('');
                circle.bindPopup(`<div style="font-weight:900;font-size:14px;color:#f8fafc;margin-bottom:4px">${aptLabel(apt)}</div>${flightLines}`, { className: 'dark-popup' });

                const aptLabelHtml = `<div style="color:#e2e8f0;font-size:9px;font-weight:900;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000;margin-left:8px;margin-top:-4px">${aptLabel(apt)}</div>`;
                worldLabels(coords, aptLabelHtml)
                    .forEach(l => { l.addTo(map); mapLayers.labels.push(l); });
            });

            if (bounds.length > 0) {
                const nb = bounds.map(p => [p[0], ((p[1] % 360) + 360) % 360]);
                map.fitBounds(L.latLngBounds(nb).pad(0.25));
            }

            // Here-now pins for all crew — only meaningful when viewing today
            if (mapDayDate === _localToday()) {
                const now2 = new Date();
                const hereNowEntries = [];
                // Raw date strings, two days each side: wide enough for UTC/local skew and the longest
                // flight, and it skips running the leg-state check on a pilot's whole history.
                const _airborneFrom = new Date(now2.getTime() - 2 * 86400000).toISOString().slice(0, 10);
                const _airborneTo = new Date(now2.getTime() + 2 * 86400000).toISOString().slice(0, 10);

                visiblePilots.forEach(pilotKey => {
                    if (hiddenPilots.has(pilotKey)) return;
                    const segs = allPilotSegments[pilotKey];
                    if (!segs) return;

                    const pilotName = (PILOT_NAMES[pilotKey] || pilotKey).split(' ')[0];
                    const pilotColor = PILOT_COLORS[pilotKey] || '#94a3b8';
                    const homeCode   = PILOT_HOME[pilotKey] || null;

                    const pilotFlights = segs
                        .filter(s => s.type === 'flight' && s.departureTime && s.arrivalTime)
                        .sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));

                    // Helper — resolve airport and push a pin entry
                    const pushPin = (code, label) => {
                        const coords = resolveAirport(code);
                        if (!coords) return;
                        hereNowEntries.push({
                            pilotName, pilotColor, locationCoords: coords,
                            popupExtra: `<div style="font-size:12px;color:#c4b5fd">${code} · ${label}</div>`
                        });
                    };

                    // ── 1. Airborne — live tracking handles position, no static dot ──
                    const isAirborne = pilotFlights.some(f => {
                        const depDay = f.departureTime.slice(0, 10);
                        if (depDay < _airborneFrom || depDay > _airborneTo) return false;
                        const d = flightUTCTime(f.departureTime, f.departureAirport);
                        const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                        const cs = deriveCallsign(f, pilotKey);
                        const _earlyHere = _isLandedEarly(cs, a?.getTime());
                        if (_earlyHere) return false;
                        return _legState(cs, d?.getTime(), a?.getTime(), _earlyHere, pilotKey, f.departureAirport).state === 'active';
                    });
                    if (isAirborne) return;

                    // ── 2. Active reserve period ──
                    const activeReserve = segs.find(s => {
                        if (s.type !== 'reserve' || !s.departureAirport) return false;
                        const start = flightUTCTime(s.departureTime, s.departureAirport);
                        const end   = s.arrivalTime ? flightUTCTime(s.arrivalTime, s.arrivalAirport || s.departureAirport) : null;
                        return start && start <= now2 && (!end || now2 <= end);
                    });
                    if (activeReserve) {
                        // Suppress only if the pilot completed a flight to a non-reserve airport
                        // AFTER the reserve began — meaning they went home during the reserve window.
                        const reserveBase = activeReserve.departureAirport?.toUpperCase();
                        const reserveStart = flightUTCTime(activeReserve.departureTime, activeReserve.departureAirport);
                        const wentHomeDuringReserve = reserveStart && pilotFlights.some(f => {
                            if (f.trip === 'PERSONAL') return false;
                            const arr = f.arrivalTime ? flightUTCTime(f.arrivalTime, f.arrivalAirport) : null;
                            if (!arr || arr > now2 || arr < reserveStart) return false;
                            const arrApt = f.arrivalAirport?.toUpperCase();
                            return arrApt && arrApt !== reserveBase;
                        });
                        if (!wentHomeDuringReserve) { pushPin(activeReserve.departureAirport, 'Reserve'); return; }
                    }

                    // ── 3. Reserve ended recently — overnight if more work at same airport ──
                    // Use a 36h window instead of date comparison to avoid UTC-vs-local timezone skew.
                    const todayEndedReserve = segs.find(s => {
                        if (s.type !== 'reserve' || !s.departureAirport) return false;
                        const end = s.arrivalTime ? flightUTCTime(s.arrivalTime, s.arrivalAirport || s.departureAirport) : null;
                        if (!end || end > now2) return false;
                        return (now2 - end) < 36 * 60 * 60 * 1000;
                    });
                    if (todayEndedReserve) {
                        const apt = todayEndedReserve.departureAirport.toUpperCase();
                        // Only anchor to the reserve airport if the next departure (flight or reserve) from
                        // there is within 30h — otherwise the pilot has had time to commute home.
                        const nextWorkSeg = segs.find(s => {
                            if (s.type !== 'flight' && s.type !== 'reserve') return false;
                            if (s.departureAirport?.toUpperCase() !== apt) return false;
                            const dep = flightUTCTime(s.departureTime, s.departureAirport);
                            return dep && dep > now2 && (dep - now2) < 30 * 60 * 60 * 1000;
                        });
                        if (nextWorkSeg) {
                            const label = nextWorkSeg.type === 'reserve' ? 'Reserve' : 'Overnight';
                            pushPin(todayEndedReserve.departureAirport, label); return;
                        }
                    }

                    // ── 4. Active AWAY segment (manually entered — trusted as authoritative) ──
                    // Used by corporate pilots for multi-day trips; also airline pilots who enter them.
                    const activeAway = segs
                        .filter(s => s.type === 'away' && s.arrivalAirport && !isHomeOrBase(s.arrivalAirport, pilotKey))
                        .sort((a, b) => new Date(b.departureTime) - new Date(a.departureTime))
                        .find(s => {
                            const start = new Date(s.departureTime);
                            if (isNaN(start) || start > now2) return false;
                            if (s.arrivalTime) {
                                const end = new Date(s.arrivalTime);
                                if (isNaN(end) || end <= now2) return false;
                            } else {
                                const dayEnd = new Date(start);
                                dayEnd.setDate(dayEnd.getDate() + 1);
                                if (now2 >= dayEnd) return false;
                            }
                            // Skip if a scheduled flight already departed from this airport during the away period
                            const awayApt = s.arrivalAirport.toUpperCase();
                            return !pilotFlights.some(f => {
                                if (f.departureAirport?.toUpperCase() !== awayApt) return false;
                                const dep = flightUTCTime(f.departureTime, f.departureAirport);
                                return dep && dep > start && dep <= now2;
                            });
                        });
                    if (activeAway) { pushPin(activeAway.arrivalAirport, 'Overnight'); return; }

                    // ── 4b. NetJets off duty — auto-commuted home after the tour's last leg ──
                    const njHome = _netjetsOffDutyHome(pilotKey);
                    if (njHome) { pushPin(njHome, 'Home'); return; }

                    // ── 5. Infer location from flight history ──
                    const completedFlights = pilotFlights.filter(f => {
                        const cs = deriveCallsign(f, pilotKey);
                        const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                        if (_isLandedEarly(cs, a?.getTime())) return true;
                        const d = flightUTCTime(f.departureTime, f.departureAirport);
                        if (d && d > now2) return false; // hasn't departed yet — can't be completed
                        return a && a <= now2;
                    });
                    let lastFlight     = completedFlights[completedFlights.length - 1] || null;
                    let lastArrival    = lastFlight?.arrivalAirport?.toUpperCase() || null;
                    let lastArrUTC     = lastFlight ? flightUTCTime(lastFlight.arrivalTime, lastFlight.arrivalAirport) : null;
                    // Mirrors lastFlight's arrivalTime/arrivalAirport for the sameLocalDay check below — kept
                    // separate from lastFlight itself since a reserve-sourced anchor (just below) isn't a
                    // flight object and nextDepFromHere's "sameLocalDay" comparison just needs these two fields.
                    let lastArrivalTimeStr = lastFlight?.arrivalTime || null;
                    let lastArrivalAptStr  = lastFlight?.arrivalAirport || null;

                    // A reserve shift is always sat at base (departure_airport === base, no travel implied),
                    // so an already-ended reserve block is just as good an anchor for "last known location"
                    // as a completed flight's arrival — and if it's MORE recent than the last flight arrival,
                    // it must win. Without this, a pilot who hasn't flown in a while but has worked reserve
                    // shifts since (e.g. Logan: last real flight arrival was 11 days ago at a city that isn't
                    // even his base anymore, but he's since sat two reserve shifts at his current base) stays
                    // pinned at that stale, long-past flight arrival forever. Step 3 above already handles a
                    // reserve that ended within the last 36h; this covers one that ended longer ago than that
                    // but still more recently than any logged flight.
                    const lastEndedReserve = segs
                        .filter(s => s.type === 'reserve' && s.departureAirport)
                        .map(s => ({ s, end: s.arrivalTime ? flightUTCTime(s.arrivalTime, s.arrivalAirport || s.departureAirport) : null }))
                        .filter(x => x.end && x.end <= now2)
                        .sort((a, b) => b.end - a.end)[0] || null;
                    if (lastEndedReserve && (!lastArrUTC || lastEndedReserve.end > lastArrUTC)) {
                        lastFlight = null; // no corresponding "flight" object — nextDepFromHere/midTrip below handle this
                        lastArrival = lastEndedReserve.s.departureAirport.toUpperCase();
                        lastArrUTC = lastEndedReserve.end;
                        lastArrivalTimeStr = lastEndedReserve.s.arrivalTime;
                        lastArrivalAptStr = lastEndedReserve.s.arrivalAirport || lastEndedReserve.s.departureAirport;
                    }

                    const atHome = isHomeAirport(lastArrival, pilotKey);
                    const atBase = !!lastArrival && (isBaseAirport(lastArrival, pilotKey) || sameApt(lastArrival, pilotBaseAt(pilotKey, lastArrivalTimeStr)));

                    // The pilot's next flight, if it leaves the last arrival airport. One leaving anywhere
                    // else means they aren't waiting here, however soon they next depart from here.
                    const nextFlight = lastArrival ? pilotFlights.find(f => {
                        const dep = flightUTCTime(f.departureTime, f.departureAirport);
                        return dep && dep > now2;
                    }) : null;
                    const nextDepFromHere = nextFlight?.departureAirport?.toUpperCase() === lastArrival ? nextFlight : null;
                    const nextDepUTC = nextDepFromHere ? flightUTCTime(nextDepFromHere.departureTime, nextDepFromHere.departureAirport) : null;

                    // Mid-trip overnight: pilot is at a non-home airport with a future departure from there.
                    // Includes turns at base — if the TOTAL ground time between arrival and that departure is
                    // under 18h, the pilot hasn't had time to go home and back (commuters need at least 3–4h
                    // each way). Measured from the arrival itself, not from "now" — otherwise a pilot who
                    // arrived days ago and simply has their next departure creep inside 18h out gets relabeled
                    // "Overnight" (as if they never left) right as the window closes, even though the actual
                    // gap was long enough to go home and the existing commuter "Home" logic below already
                    // covers that correctly (confirmed live: Adam landing at LGA, going home to TUL for ~2.5
                    // days, then flying again — incorrectly flipped to "Overnight at LGA" ~14h before that
                    // next departure).
                    const midTrip = lastArrival && !atHome && nextDepFromHere && lastArrUTC && (
                        !atBase || (nextDepUTC - lastArrUTC) < 18 * 60 * 60 * 1000
                    );
                    if (midTrip) {
                        const sameLocalDay = flightLocalDate(lastArrivalTimeStr, lastArrivalAptStr) === flightLocalDate(nextDepFromHere.departureTime, nextDepFromHere.departureAirport);
                        pushPin(lastArrival, sameLocalDay ? 'Layover' : 'Overnight');
                        return;
                    }

                    // ── 5b. Trip not yet started — first work flight departs soon from known airport ──
                    if (!lastArrival) {
                        const nextWorkFlight = pilotFlights.find(f => {
                            if (f.trip === 'PERSONAL') return false;
                            const dep = flightUTCTime(f.departureTime, f.departureAirport);
                            return dep && dep > now2 && (dep - now2) < 24 * 60 * 60 * 1000;
                        });
                        if (nextWorkFlight) { pushPin(nextWorkFlight.departureAirport, 'Overnight'); return; }
                    }

                    // ── 6. Commute prediction ──
                    // Commuting only applies to pilots whose home ≠ base (e.g. Adam: base=LGA, home=TUL).
                    // For home=base pilots (Drew, Kyle) landing at their base IS landing at home — no commute window.
                    const isCommuter = atBase && !atHome;
                    const lastArrDate = lastArrUTC
                        ? `${lastArrUTC.getFullYear()}-${String(lastArrUTC.getMonth()+1).padStart(2,'0')}-${String(lastArrUTC.getDate()).padStart(2,'0')}`
                        : null;
                    const commuteWindowPassed = lastArrUTC && (
                        lastArrDate < _localToday() ||
                        (now2 - lastArrUTC) >= 3 * 60 * 60 * 1000
                    );

                    if (isCommuter && !commuteWindowPassed) {
                        // Commuter pilot just landed at their airline base — heading home but not there yet
                        pushPin(lastArrival, 'Heading home');
                    } else if (!isCommuter && lastArrival && !atHome && lastArrUTC) {
                        // Landed away from home with no later flight logged: they're still there until the next flight.
                        pushPin(lastArrival, 'Overnight');
                    } else {
                        if (homeCode) pushPin(homeCode, 'Home');
                    }
                });

                // Group by exact coordinates so co-located pilots render as a cluster
                const byLocation = {};
                hereNowEntries.forEach(e => {
                    const key = `${e.locationCoords[0]},${e.locationCoords[1]}`;
                    if (!byLocation[key]) byLocation[key] = [];
                    byLocation[key].push(e);
                });

                Object.values(byLocation).forEach(group => {
                    const { locationCoords } = group[0];
                    WORLD_OFFSETS.forEach(w => {
                        const wCoords = [locationCoords[0], locationCoords[1] + w * 360];

                        if (group.length === 1) {
                            const { pilotName, pilotColor, popupExtra } = group[0];
                            const pc  = hexToRgba(pilotColor, 0.7);
                            const pc0 = hexToRgba(pilotColor, 0);
                            const herePopup = `<div style="font-weight:900;font-size:13px;color:#f8fafc;margin-bottom:4px">${pilotName} is here</div>${popupExtra}`;
                            const dotHtml = `<div style="width:16px;height:16px;border-radius:50%;background:${pilotColor};border:2px solid #fff;--pc:${pc};--pc0:${pc0};animation:here-pulse-plane 2s ease-out infinite"></div>`;
                            const pin = L.marker(wCoords, {
                                icon: L.divIcon({ className: '', html: dotHtml, iconSize: [16, 16], iconAnchor: [8, 8] }),
                                zIndexOffset: 2000
                            });
                            pin.bindPopup(herePopup, { className: 'dark-popup' });
                            pin.addTo(map);
                            const nameLabel = L.marker(wCoords, {
                                icon: L.divIcon({
                                    className: '',
                                    html: `<div style="color:${pilotColor};font-size:11px;font-weight:800;text-shadow:0 1px 6px rgba(0,0,0,1),0 1px 6px rgba(0,0,0,1);background:rgba(0,0,0,0.45);border-radius:4px;padding:0 3px;transform:translate(-50%,10px);white-space:nowrap">${pilotName}</div>`,
                                    iconAnchor: [0, 0]
                                }),
                                interactive: false
                            }).addTo(map);
                            mapLayers.active.push(pin, nameLabel);
                        } else {
                            // Multiple pilots at the same airport — render side-by-side dots
                            const dotSize = 16, gap = 5;
                            const totalW = group.length * dotSize + (group.length - 1) * gap;
                            const dotsHtml = group.map(({ pilotColor: c }) => {
                                const pc  = hexToRgba(c, 0.7);
                                const pc0 = hexToRgba(c, 0);
                                return `<div style="width:${dotSize}px;height:${dotSize}px;border-radius:50%;background:${c};border:2px solid #fff;--pc:${pc};--pc0:${pc0};animation:here-pulse-plane 2s ease-out infinite;flex-shrink:0"></div>`;
                            }).join('');
                            const clusterHtml = `<div style="display:flex;gap:${gap}px">${dotsHtml}</div>`;

                            const allNames = group.map(e => e.pilotName);
                            const headlineNames = allNames.length === 2
                                ? `${allNames[0]} & ${allNames[1]}`
                                : `${allNames.slice(0, -1).join(', ')} & ${allNames[allNames.length - 1]}`;
                            const herePopup = `<div style="font-weight:900;font-size:13px;color:#f8fafc;margin-bottom:6px">${headlineNames} are here</div>` +
                                group.map(e => `<div style="margin-top:3px"><span style="font-size:12px;font-weight:700;color:${e.pilotColor}">${e.pilotName}</span>${e.popupExtra}</div>`).join('');

                            const pin = L.marker(wCoords, {
                                icon: L.divIcon({ className: '', html: clusterHtml, iconSize: [totalW, dotSize], iconAnchor: [Math.round(totalW / 2), dotSize + 4] }),
                                zIndexOffset: 2000
                            });
                            pin.bindPopup(herePopup, { className: 'dark-popup' });
                            pin.addTo(map);

                            const nameParts = group.map(e =>
                                `<span style="color:${e.pilotColor};font-size:11px;font-weight:800">${e.pilotName}</span>`
                            ).join('<span style="color:#94a3b8;font-size:11px"> & </span>');
                            const nameLabel = L.marker(wCoords, {
                                icon: L.divIcon({
                                    className: '',
                                    html: `<div style="display:flex;gap:3px;background:rgba(0,0,0,0.45);border-radius:4px;padding:0 4px;transform:translate(-50%,8px);white-space:nowrap;text-shadow:0 1px 6px rgba(0,0,0,1)">${nameParts}</div>`,
                                    iconAnchor: [0, 0]
                                }),
                                interactive: false
                            }).addTo(map);
                            mapLayers.active.push(pin, nameLabel);
                        }
                    });
                });
            }
        }

        // Tooltip element for flight details
        const tooltip = document.createElement('div');
        tooltip.id = 'flight-tooltip';
        Object.assign(tooltip.style, { position: 'fixed', pointerEvents: 'none', background: '#0b1220', color: '#fff', padding: '8px 10px', borderRadius: '8px', boxShadow: '0 4px 18px rgba(2,6,23,0.8)', fontSize: '12px', zIndex: 2000, display: 'none', maxWidth: '260px' });
        document.body.appendChild(tooltip);

