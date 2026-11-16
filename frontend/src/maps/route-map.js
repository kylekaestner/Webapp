        // ── Map modes ─────────────────────────────────────────────────────
        // 'mine'  (default) -- single pilot, current month, arc per unique route
        // 'month' (mapAllMode) -- all pilots overlaid for the current month
        // 'day'   (mapDayMode) -- all pilots on a specific day (offset arcs per pair)
        // setMapMode() sets the booleans, updates nav button states, calls renderMap().
        // renderMap() dispatches to renderDayMap() / renderAllPilotsMap() / inline.
        // mapRenderGen guards against stale async renders when the user switches fast.
        function setMapMode(mode) {
            mapDayMode  = (mode === 'day');
            mapAllMode  = (mode === 'month');

            // Day nav (desktop overlay + mobile bar)
            const dayNav = document.getElementById('day-nav');
            const mobileDayBar = document.getElementById('mobile-day-nav-bar');
            if (mapDayMode) {
                mapDayDate = mapDayDate || _localToday();
                if (dayNav) dayNav.classList.replace('hidden', 'flex');
                if (mobileDayBar) mobileDayBar.classList.replace('hidden', 'flex');
                updateDayNavLabel();
            } else {
                if (dayNav) dayNav.classList.replace('flex', 'hidden');
                if (mobileDayBar) mobileDayBar.classList.replace('flex', 'hidden');
            }

            // Hide filter buttons in all-crew modes — they only apply to My Routes
            const pc = document.getElementById('map-pilot-controls');
            if (pc) pc.style.display = (mapDayMode || mapAllMode) ? 'none' : '';

            // Active state on desktop sub-row and mobile bar
            ['mine', 'month', 'day'].forEach(m => {
                document.getElementById(`mapmode-${m}`)?.classList.toggle('map-mode-active', m === mode);
                document.getElementById(`mapmode-bar-${m}`)?.classList.toggle('map-mode-active', m === mode);
            });

            if (currentView === 'map') renderMap();
        }

        function _updateCrewLegend() {
            const container = document.getElementById('legend-day-pilots');
            if (!container) return;
            container.innerHTML = getCrewVisible().map(k => {
                const color = PILOT_COLORS[k] || '#94a3b8';
                const name = (PILOT_NAMES[k] || k).split(' ')[0];
                const opacity = hiddenPilots.has(k) ? '0.3' : '1';
                return `<button onclick="togglePilotLegend('${k}')" id="legend-pilot-${k}" class="flex items-center gap-1.5 w-full text-left transition-opacity hover:opacity-70" style="opacity:${opacity}"><span class="inline-block w-4 h-[2.5px] rounded-full shrink-0" style="background:${color}"></span><span class="text-zinc-500">${name}</span></button>`;
            }).join('');
        }

        function togglePilotLegend(key) {
            if (hiddenPilots.has(key)) hiddenPilots.delete(key);
            else hiddenPilots.add(key);
            const el = document.getElementById(`legend-pilot-${key}`);
            if (el) el.style.opacity = hiddenPilots.has(key) ? '0.3' : '';
            if (mapDayMode) renderDayMap(); else renderAllPilotsMap();
        }

        async function renderAllPilotsMap() {
            const gen = mapRenderGen;
            stopLivePollers();
            [...mapLayers.past, ...mapLayers.future, ...mapLayers.active, ...mapLayers.airports, ...mapLayers.labels]
                .forEach(l => map.removeLayer(l));
            mapLayers = { past: [], future: [], active: [], airports: [], labels: [] };

            // Ensure all visible pilots are loaded
            const visiblePilots = getCrewVisible();
            await Promise.all(visiblePilots.map(async key => {
                if (!pilotsCache[key]) {
                    try { await _loadPilotOnce(key); }
                    catch(_) {}
                }
            }));
            if (gen !== mapRenderGen) return;

            const now = new Date();
            const monthPrefix = `${viewDate.getFullYear()}-${String(viewDate.getMonth()+1).padStart(2,'0')}`;
            const bounds = [];
            const airportSeen = new Set();

            for (const key of visiblePilots) {
                if (hiddenPilots.has(key)) continue;
                const data = pilotsCache[key];
                if (!data?.segments) continue;
                const pilotColor = PILOT_COLORS[key];

                const allFlights = data.segments.filter(s => s.type === 'flight' && !s.auto_leg_cancelled && s.departure_time && s.arrival_time && s.departure_airport && s.arrival_airport);
                const monthFlights = allFlights.filter(f => f.departure_time.startsWith(monthPrefix));

                // Group by exact route direction
                const routeGroups = {};
                monthFlights.forEach(f => {
                    const pk = `${f.departure_airport}|${f.arrival_airport}`;
                    if (!routeGroups[pk]) routeGroups[pk] = [];
                    routeGroups[pk].push(f);
                });

                Object.entries(routeGroups).forEach(([, legs]) => {
                    const dep = legs[0].departure_airport, arr = legs[0].arrival_airport;
                    const depC = resolveAirport(dep), arrC = resolveAirport(arr);
                    if (!depC || !arrC) return;

                    const hasActive = legs.some(f => {
                        const d = flightUTCTime(f.departure_time, f.departure_airport);
                        const a = flightUTCTime(f.arrival_time, f.arrival_airport);
                        const cs = deriveCallsign(f, key);
                        if (_isLandedEarly(cs, a?.getTime())) return false;
                        return isFlightStillActive(d?.getTime(), a?.getTime(), now.getTime(), cs, f.departureAirport || f.departure_airport);
                    });
                    const hasFuture = !hasActive && legs.some(f => {
                        const a = flightUTCTime(f.arrival_time, f.arrival_airport);
                        return a && a > now;
                    });
                    const weight = 1.5 + Math.min(Math.log2(legs.length + 1), 2);
                    const opacity = hasActive ? 1 : hasFuture ? 0.8 : 0.35;

                    const arcCoords = distanceProportionalArc(depC, arrC);
                    bounds.push(arcCoords[0], arcCoords[Math.floor(arcCoords.length / 2)], arcCoords[arcCoords.length - 1]);
                    const arcU = unwrapLongitudes(arcCoords);
                    const lines = worldLines(arcU, { weight, opacity, color: pilotColor, smoothFactor: 1 });
                    lines.forEach(l => { l.addTo(map); mapLayers.future.push(l); });
                    const [line] = lines;
                    const monthHits = worldLines(arcU, { weight: 20, opacity: 0, className: 'map-hit' });
                    const monthPopup = `<div style="font-weight:900;font-size:13px;color:${pilotColor};margin-bottom:3px">${(PILOT_NAMES[key] || '').split(' ')[0]}</div><div style="font-weight:900;font-size:14px;color:#f8fafc">${aptLabel(dep, key)} → ${aptLabel(arr, key)}</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">${legs.length}× this month</div>`;
                    monthHits.forEach(h => { h.bindPopup(monthPopup, { className: 'dark-popup' }); h.addTo(map); mapLayers.future.push(h); });

                    if (hasActive) {
                        const al = legs.find(f => {
                            const d = flightUTCTime(f.departure_time, f.departure_airport);
                            const a = flightUTCTime(f.arrival_time, f.arrival_airport);
                            return isFlightStillActive(d?.getTime(), a?.getTime(), now.getTime(), deriveCallsign(f, key), f.departure_airport);
                        });
                        if (al) {
                            const alDepUTC = flightUTCTime(al.departure_time, al.departure_airport);
                            const alArrUTC = flightUTCTime(al.arrival_time, al.arrival_airport);
                            const t = Math.max(0, Math.min(1, (now - alDepUTC) / (alArrUTC - alDepUTC)));
                            const idx = Math.min(Math.floor(t * (arcCoords.length-1)), arcCoords.length-2);
                            const bearing = computeBearing(arcCoords[idx], arcCoords[idx+1] || arcCoords[idx]);
                            const dots = worldPlaneMarkers(arcCoords[idx], makePlaneIcon(bearing, pilotColor, null, true));
                            dots.forEach(d => mapLayers.active.push(d));
                            const cs = deriveCallsign(al, key);
                            if (cs) startLiveTracking(dots, cs, pilotColor, depC, arrC, lines, mapLayers.active, (PILOT_NAMES[key] || '').split(' ')[0], alArrUTC, [], weight, monthHits, alDepUTC, key, al.departure_airport, al.arrival_airport);
                        }
                    } else {
                        // Preflight — within PREFLIGHT_ROUTE_MS of departure but not airborne yet.
                        // startLiveTracking()'s own preflight branch no-ops until real FP data
                        // shows up, so calling it here is harmless if there isn't any yet.
                        const pf = legs.find(f => {
                            const d = flightUTCTime(f.departure_time, f.departure_airport);
                            const a = flightUTCTime(f.arrival_time, f.arrival_airport);
                            return isPreflightWindow(d, now, a) && !_earlierLegOpen(key, deriveCallsign(f, key), d?.getTime(), now.getTime());
                        });
                        if (pf) {
                            const pfDepUTC = flightUTCTime(pf.departure_time, pf.departure_airport);
                            const pfArrUTC = flightUTCTime(pf.arrival_time, pf.arrival_airport);
                            const dots = worldPlaneMarkers(depC, makePlaneIcon(computeBearing(depC, arrC), pilotColor, null, true));
                            dots.forEach(d => mapLayers.active.push(d));
                            const cs = deriveCallsign(pf, key);
                            if (cs) startLiveTracking(dots, cs, pilotColor, depC, arrC, lines, mapLayers.active, (PILOT_NAMES[key] || '').split(' ')[0], pfArrUTC, [], weight, monthHits, pfDepUTC, key, pf.departure_airport, pf.arrival_airport);
                        }
                    }

                    [dep, arr].forEach(code => {
                        const upper = code?.toUpperCase();
                        if (!upper || airportSeen.has(upper)) return;
                        const coords = resolveAirport(upper);
                        if (!coords) return;
                        airportSeen.add(upper);
                        worldDots(coords, { radius: 4, color: '#0f172a', fillColor: '#e2e8f0', fillOpacity: 0.9, weight: 1.5 })
                            .forEach(d => { d.addTo(map); mapLayers.airports.push(d); });
                        worldLabels(coords, `<div style="color:#e2e8f0;font-size:10px;font-weight:800;text-shadow:0 1px 4px rgba(0,0,0,0.9);transform:translate(-50%,-180%);white-space:nowrap">${upper}</div>`)
                            .forEach(l => { l.addTo(map); mapLayers.labels.push(l); });
                    });
                });
            }

            // Update legend
            document.getElementById('legend-single').classList.add('hidden');
            document.getElementById('legend-day').classList.remove('hidden');
            _updateCrewLegend();
            if (bounds.length) {
                const nb = bounds.map(p => [p[0], ((p[1] % 360) + 360) % 360]);
                map.fitBounds(L.latLngBounds(nb).pad(0.2));
            }
        }

        function distanceProportionalArc(start, end, steps = 80) {
            // Unwrap end longitude so the Bezier travels the shorter great-circle direction.
            // For transpacific routes this means lon may exceed ±180; Leaflet handles that fine.
            let endLon = end[1];
            while (endLon - start[1] >  180) endLon -= 360;
            while (start[1] - endLon >  180) endLon += 360;
            const endU = [end[0], endLon];

            const dx = endU[1] - start[1], dy = endU[0] - start[0];
            const routeDeg = Math.sqrt(dx * dx + dy * dy);
            const bowFactor = Math.min(routeDeg * 0.10, 1.8);
            if (bowFactor < 0.08) return greatCircleArcCoords(start, endU, steps);

            // Unwrap gc midpoint into the same longitude space before using it as control point
            const gcUnwrapped = unwrapLongitudes(greatCircleArcCoords(start, endU, steps));
            const bearing = computeBearing(start, endU);
            const perpRad = toRadians((bearing + 90) % 360);
            const midPt = gcUnwrapped[Math.floor(steps / 2)];
            const ctrl = [
                midPt[0] + bowFactor * Math.cos(perpRad),
                midPt[1] + bowFactor * Math.sin(perpRad)
            ];
            return Array.from({ length: steps + 1 }, (_, i) => {
                const t = i / steps;
                return [
                    (1-t)*(1-t)*start[0] + 2*(1-t)*t*ctrl[0] + t*t*endU[0],
                    (1-t)*(1-t)*start[1] + 2*(1-t)*t*ctrl[1] + t*t*endU[1]
                ];
            });
        }

        async function renderMap() {
            if (!map || !airportDbReady) return;
            stopLivePollers();
            // loadPilot() already loaded these, so the map doesn't wait on a refresh. If it finds a
            // new one, redraw. The set only grows, so this can't loop.
            _reloadLandedEarly().then(grew => { if (grew && currentView === 'map') renderMap(); });
            mapRenderGen++;
            if (mapDayMode) { renderDayMap(); return; }
            if (mapAllMode) { renderAllPilotsMap(); return; }
            // Restore single-pilot legend
            document.getElementById('legend-single')?.classList.remove('hidden');
            document.getElementById('legend-day')?.classList.add('hidden');
            [...mapLayers.past, ...mapLayers.future, ...mapLayers.active, ...mapLayers.airports, ...mapLayers.labels]
                .forEach(l => map.removeLayer(l));
            mapLayers = { past: [], future: [], active: [], airports: [], labels: [] };
            airportVisibilityMap = {};
            airportFlightTypes = {};

            const now = new Date();
            const bounds = [];
            const airportSet = new Set();
            const monthPrefix = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, '0')}`;
            const allFlights = segments.filter(s => s.type === 'flight' && !s.cancelled);
            const flights = allFlights.filter(s => s.departureTime && s.departureTime.startsWith(monthPrefix));
            // The base in effect for this month's flights, not today's: Sam's LGA months showed ORD green.
            // Both show in a month with a base change.
            const monthBases = [...new Set(flights.map(f => pilotBaseAt(currentPilot, f.departureTime)).filter(Boolean))];

            // Determine airport roles: overnight (slept there) vs turn (same-day)
            // Only consider arrivals within this month so prior-month arrivals don't
            // bleed into the current view (e.g. May EWR arrival matching a June departure).
            // nextDep searches allFlights so end-of-month overnights still resolve correctly.
            const layoverAirports = new Set();
            const turnAirports = new Set();
            allFlights.forEach(f => {
                if (!f.arrivalAirport || !f.arrivalTime) return;
                if (!f.arrivalTime.startsWith(monthPrefix)) return;
                const upper = f.arrivalAirport.toUpperCase();
                if (isHomeOrBase(upper, currentPilot)) return;
                const nextDep = allFlights.filter(s => s.departureAirport === f.arrivalAirport && s.departureTime > f.arrivalTime)
                    .sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)))[0];
                if (!nextDep) return;
                const arrMid = new Date(f.arrivalTime); arrMid.setHours(0,0,0,0);
                const depMid = new Date(nextDep.departureTime); depMid.setHours(0,0,0,0);
                if (depMid > arrMid) layoverAirports.add(upper);
                else if (!layoverAirports.has(upper)) turnAirports.add(upper);
            });

            // Shared with startLiveTracking so it can remove the here-now dot when ADSB confirms airborne
            const hereNowMarkers = [];

            // Group by exact route direction — one arc per unique DEP→ARR pair
            const routeGroups = {};
            flights.forEach(f => {
                if (!f.departureAirport || !f.arrivalAirport) return;
                const pk = `${f.departureAirport}|${f.arrivalAirport}`;
                if (!routeGroups[pk]) routeGroups[pk] = [];
                routeGroups[pk].push(f);
            });

            // Resolve coords once per group.
            const resolvedRouteGroups = Object.entries(routeGroups).map(([pk, legs]) => ({
                pk, legs,
                dep: legs[0].departureAirport, arr: legs[0].arrivalAirport,
                depCoords: resolveAirport(legs[0].departureAirport),
                arrCoords: resolveAirport(legs[0].arrivalAirport),
            })).filter(g => g.depCoords && g.arrCoords);

            resolvedRouteGroups.forEach(({ pk, legs, dep, arr, depCoords, arrCoords }) => {

                const hasActive = legs.some(f => {
                    const d = flightUTCTime(f.departureTime, f.departureAirport);
                    const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                    const cs = deriveCallsign(f, currentPilot);
                    if (_isLandedEarly(cs, a?.getTime())) return false;
                    return isFlightStillActive(d?.getTime(), a?.getTime(), now.getTime(), cs, f.departureAirport || f.departure_airport);
                });
                const hasFuture = !hasActive && legs.some(f => {
                    const d = flightUTCTime(f.departureTime, f.departureAirport);
                    const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                    return (d && d > now) || (a && a > now);
                });
                // Whether this route pair ALSO has at least one already-completed leg this month,
                // checked independently of hasFuture -- a city pair flown earlier this month and
                // scheduled again later (a recurring pairing) is both. Previously allPast (exactly
                // !hasFuture) swept a mixed group entirely into the "upcoming" bucket below, hiding
                // an already-completed leg from the Flown filter entirely. Confirmed live: Mark's
                // CLE-ATL flown today was invisible under "Flown" solely because he also has a
                // CLE-ATL leg later this month -- the one shared arc per route pair only ever
                // carried a single status before.
                const hasPast = !hasActive && legs.some(f => {
                    const d = flightUTCTime(f.departureTime, f.departureAirport);
                    const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                    return d && a && a < now;
                });

                const count   = legs.length;
                const weight  = 1.5 + Math.min(Math.log2(count + 1) * 1.0, 2.5);
                // A genuinely mixed route (hasPast AND hasFuture, no active leg) draws as two
                // separate overlapping arcs instead of one shared-color line: a gray one that only
                // belongs to the Flown bucket, a blue one that only belongs to the Upcoming bucket.
                // With "Flown" alone on you see only gray, "Upcoming" alone only blue, both on you
                // see both simultaneously -- a single shared line couldn't represent that, since a
                // past-only or future-only line is only ever one color at render time. Non-mixed
                // groups (the common case: pastLines or futureLines is null) keep exactly the
                // previous single-line behavior. The invisible hit-lines (popup click targets) are
                // split the same way, not shared -- a hit-line present in both mapLayers.past and
                // .future would have its visibility clobbered by whichever filter was toggled most
                // recently (toggleMapFilter blindly sets every member of one array, with no memory
                // of the other array's current state), leaving the still-visible colored line
                // unclickable until the other filter happened to be toggled again.
                const isMixed = hasPast && hasFuture && !hasActive;
                const arcCoords = distanceProportionalArc(depCoords, arrCoords);
                bounds.push(arcCoords[0], arcCoords[Math.floor(arcCoords.length / 2)], arcCoords[arcCoords.length - 1]);
                const arcU = unwrapLongitudes(arcCoords);
                const pastLines = hasPast ? worldLines(arcU, { weight, opacity: 0.45, color: '#6b7280', smoothFactor: 1 }) : null;
                const futureLines = (hasFuture || hasActive) ? worldLines(arcU, { weight, opacity: hasActive ? 1.0 : 0.85, color: hasActive ? '#22c55e' : '#3b82f6', smoothFactor: 1 }) : null;
                const pastHit = hasPast ? worldLines(arcU, { weight: 20, opacity: 0, className: 'map-hit' }) : null;
                const futureHit = (hasFuture || hasActive) ? worldLines(arcU, { weight: 20, opacity: 0, className: 'map-hit' }) : null;
                // Combined references for the non-mixed "one line" paths further down (e.g.
                // startLiveTracking() for an active leg, which always resolves to futureLines/
                // futureHit alone since isMixed is never true when hasActive is true).
                const routeLines = isMixed ? [...pastLines, ...futureLines] : (pastLines || futureLines);
                const hitLines = isMixed ? [...pastHit, ...futureHit] : (pastHit || futureHit);

                // Popup: list all legs chronologically
                const sorted = legs.slice().sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));
                const legRows = sorted.map(f => {
                    const dt = new Date(f.departureTime);
                    const ds = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                    const label = deriveCallsign(f, currentPilot) || '';
                    const _ld = flightUTCTime(f.departureTime, f.departureAirport);
                    const _la = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                    const isLegActive = isFlightStillActive(_ld?.getTime(), _la?.getTime(), now.getTime(), label, f.departureAirport);
                    const legColor = isLegActive ? '#22c55e' : '#94a3b8';
                    const legStatus = isLegActive ? ' ▶' : '';
                    const depTz = tzAbbr(f.departureAirport, f.departureTime);
                    const arrTz = tzAbbr(f.arrivalAirport, f.arrivalTime);
                    return `<div style="font-size:11px;color:${legColor};margin-top:3px">
                        ${ds} &nbsp;${formatTimeISO(f.departureTime, f.departureAirport)}${depTz ? ' <span style="opacity:.55">' + depTz + '</span>' : ''} → ${formatTimeISO(f.arrivalTime, f.arrivalAirport)}${arrTz ? ' <span style="opacity:.55">' + arrTz + '</span>' : ''}${label ? ' &nbsp;· ' + flightAwareLink(label, label, flightAwareEligible(_ld?.getTime())) : ''}${legStatus}
                    </div>`;
                }).join('');
                const countLabel = count === 1 ? '1 flight' : `${count} flights`;
                const routePopup = `
                    <div style="font-weight:900;font-size:14px;margin-bottom:3px;color:#f8fafc">${aptLabel(dep, currentPilot)} → ${aptLabel(arr, currentPilot)}</div>
                    <div style="font-size:10px;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">${countLabel} this month</div>
                    ${legRows}
                `;
                hitLines.forEach(h => h.bindPopup(routePopup, { className: 'dark-popup' }));

                // pastLines/pastHit belong only to mapLayers.past, shown only when showPast.
                // futureLines/futureHit belong only to mapLayers.future, shown when showFuture (or
                // unconditionally for an active leg, matching the previous "always show active"
                // behavior). A mixed route has both pairs, so both filters independently control
                // their own half instead of one shared line having to pick a single bucket.
                if (pastLines) {
                    pastLines.forEach(l => mapLayers.past.push(l));
                    pastHit.forEach(h => mapLayers.past.push(h));
                    if (showPast) { pastLines.forEach(l => l.addTo(map)); pastHit.forEach(h => h.addTo(map)); }
                }
                if (futureLines) {
                    futureLines.forEach(l => mapLayers.future.push(l));
                    futureHit.forEach(h => mapLayers.future.push(h));
                    if (showFuture || hasActive) { futureLines.forEach(l => l.addTo(map)); futureHit.forEach(h => h.addTo(map)); }
                }

                // Airplane icon for any active leg
                if (hasActive) {
                    const activeLeg = legs.find(f => {
                        const d = flightUTCTime(f.departureTime, f.departureAirport);
                        const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                        return isFlightStillActive(d?.getTime(), a?.getTime(), now.getTime(), deriveCallsign(f, currentPilot), f.departureAirport);
                    });
                    if (activeLeg) {
                        const depTime = flightUTCTime(activeLeg.departureTime, activeLeg.departureAirport);
                        const arrTime = flightUTCTime(activeLeg.arrivalTime, activeLeg.arrivalAirport);
                        const t = Math.max(0, Math.min(1, (now - depTime) / (arrTime - depTime)));
                        const dotIdx = Math.min(Math.floor(t * (arcCoords.length - 1)), arcCoords.length - 2);
                        const pos = arcCoords[dotIdx];
                        const nextPos = arcCoords[dotIdx + 1] || arcCoords[dotIdx];
                        const bearing = computeBearing(pos, nextPos);
                        const dots = worldPlaneMarkers(pos, makePlaneIcon(bearing, '#22c55e', null, true));
                        dots[2].bindTooltip('✈ In the air now', { permanent: false, className: 'dark-popup' });
                        dots.forEach(d => mapLayers.active.push(d));
                        const cs = deriveCallsign(activeLeg, currentPilot);
                        if (cs) startLiveTracking(dots, cs, '#22c55e', depCoords, arrCoords, routeLines, mapLayers.active, (PILOT_NAMES[currentPilot] || '').split(' ')[0], arrTime, hereNowMarkers, weight, hitLines, depTime, currentPilot, activeLeg.departureAirport, activeLeg.arrivalAirport);
                    }
                } else {
                    // Preflight — within PREFLIGHT_ROUTE_MS of departure but not airborne yet.
                    const pf = legs.find(f => {
                        const d = flightUTCTime(f.departureTime, f.departureAirport);
                        const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                        return isPreflightWindow(d, now, a) && !_earlierLegOpen(currentPilot, deriveCallsign(f, currentPilot), d?.getTime(), now.getTime());
                    });
                    if (pf) {
                        const pfDepTime = flightUTCTime(pf.departureTime, pf.departureAirport);
                        const pfArrTime = flightUTCTime(pf.arrivalTime, pf.arrivalAirport);
                        const dots = worldPlaneMarkers(depCoords, makePlaneIcon(computeBearing(depCoords, arrCoords), '#22c55e', null, true));
                        dots.forEach(d => mapLayers.active.push(d));
                        const cs = deriveCallsign(pf, currentPilot);
                        if (cs) startLiveTracking(dots, cs, '#22c55e', depCoords, arrCoords, routeLines, mapLayers.active, (PILOT_NAMES[currentPilot] || '').split(' ')[0], pfArrTime, hereNowMarkers, weight, hitLines, pfDepTime, currentPilot, pf.departureAirport, pf.arrivalAirport);
                    }
                }

                // Airport type tracking
                [dep, arr].forEach(code => {
                    let upper = code?.toUpperCase();
                    if (!upper) return;
                    let coords = resolveAirport(upper);
                    if (!coords && upper.length === 4 && upper[0] === 'K') { upper = upper.slice(1); coords = resolveAirport(upper); }
                    if (!coords) return;
                    if (!airportFlightTypes[upper]) airportFlightTypes[upper] = { past: false, future: false, active: false };
                    // Independent flags, not if/else-if -- a mixed route group (hasPast AND
                    // hasFuture both true) needs to mark its endpoints as both, same reasoning as
                    // the route-line bucketing fix above. Using allPast here previously meant an
                    // airport that only ever appeared in one mixed-status route group (like CLE,
                    // touched only by the CLE-ATL pair) got tagged future-only even though that
                    // group also had an already-completed leg -- its dot vanished under "Flown"
                    // even though the line itself (fixed separately) correctly showed.
                    if (hasActive) airportFlightTypes[upper].active = true;
                    if (hasPast) airportFlightTypes[upper].past = true;
                    if (hasFuture) airportFlightTypes[upper].future = true;
                });
            });

            // Build airport markers after all flights are processed
            Object.keys(airportFlightTypes).forEach(upper => {
                const coords = resolveAirport(upper);
                if (!coords || airportSet.has(upper)) return;
                airportSet.add(upper);

                const { past, future, active } = airportFlightTypes[upper];
                const visible = (past && showPast) || (future && showFuture) || active;

                const isBase = monthBases.some(b => sameApt(upper, b));
                const isLayover = layoverAirports.has(upper);
                const dotColor = isBase ? '#22c55e' : isLayover ? '#f59e0b' : '#f8fafc';
                const radius = isBase ? 7 : isLayover ? 6 : 5;

                const dotOpts = { radius, color: '#0f172a', fillColor: dotColor, fillOpacity: 1, weight: 1.5 };
                const points = worldDots(coords, dotOpts);
                const [point] = points;
                points.forEach(p => { if (visible) p.addTo(map); mapLayers.airports.push(p); });

                const labelColor = isBase ? '#4ade80' : isLayover ? '#fbbf24' : '#f8fafc';
                const labelHtml = `<div style="color:${labelColor};font-size:11px;font-weight:800;text-shadow:0 1px 4px rgba(0,0,0,0.9);transform:translate(-50%,-180%);white-space:nowrap">${upper}</div>`;
                const labels = worldLabels(coords, labelHtml);
                const [label] = labels;
                labels.forEach(l => { if (visible) l.addTo(map); mapLayers.labels.push(l); });

                airportVisibilityMap[upper] = { past, future, active, markers: points, labels };
            });

            // Current position pin
            const home = PILOT_HOME[currentPilot] || null;
            const allFlightsSorted = allFlights.slice().sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));
            const isAirborne = allFlightsSorted.some(f => {
                const d = flightUTCTime(f.departureTime, f.departureAirport);
                const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                const cs = deriveCallsign(f, currentPilot);
                if (_isLandedEarly(cs, a?.getTime())) return false;
                return isFlightStillActive(d?.getTime(), a?.getTime(), now.getTime(), cs, f.departureAirport || f.departure_airport);
            });
            {
                let locationCode, label, popupExtra, isAtHome = false;
                const pilotName = (pilotsCache[currentPilot]?.name || currentPilot).split(' ')[0];

                if (isAirborne) {
                    // Show dot at departure airport until ADSB overrides with a plane icon
                    const activeLeg = allFlightsSorted.find(f => {
                        const d = flightUTCTime(f.departureTime, f.departureAirport);
                        const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                        return isFlightStillActive(d?.getTime(), a?.getTime(), now.getTime(), deriveCallsign(f, currentPilot), f.departureAirport);
                    });
                    if (activeLeg) {
                        locationCode = activeLeg.departureAirport;
                        label = locationCode;
                        popupExtra = `<div style="font-size:11px;color:#94a3b8;margin-top:2px">Departed — tracking live</div>`;
                    }
                } else {
                    const completedFlights = allFlightsSorted.filter(f => {
                        const cs = deriveCallsign(f, currentPilot);
                        const a = flightUTCTime(f.arrivalTime, f.arrivalAirport);
                        if (_isLandedEarly(cs, a?.getTime())) return true;
                        const d = flightUTCTime(f.departureTime, f.departureAirport);
                        if (d && d > now) return false; // hasn't departed yet — can't be completed
                        return a && a <= now;
                    });
                    const lastFlight = completedFlights.length > 0 ? completedFlights[completedFlights.length - 1] : null;
                    const lastArrival = lastFlight ? lastFlight.arrivalAirport : null;

                    // Check for an active away block — takes priority over flight-based guess.
                    // Guards against turns: if a departure from the away airport already occurred
                    // after the away block started, the pilot has left and we skip it.
                    const activeAway = segments
                        .filter(s => s.type === 'away' && s.arrivalAirport && !isHomeOrBase(s.arrivalAirport, currentPilot))
                        .sort((a, b) => new Date(b.departureTime) - new Date(a.departureTime))
                        .find(s => {
                            const start = new Date(s.departureTime);
                            if (isNaN(start) || start > now) return false;
                            if (s.arrivalTime) {
                                const end = new Date(s.arrivalTime);
                                if (isNaN(end) || end <= now) return false;
                            } else {
                                const dayEnd = new Date(start);
                                dayEnd.setDate(dayEnd.getDate() + 1);
                                if (now >= dayEnd) return false;
                            }
                            // If a flight already departed from this airport after the away started, pilot has left
                            const awayAirport = s.arrivalAirport.toUpperCase();
                            return !allFlightsSorted.some(f => {
                                if (!f.departureAirport || f.departureAirport.toUpperCase() !== awayAirport) return false;
                                const depTime = flightUTCTime(f.departureTime, f.departureAirport);
                                return depTime && depTime > start && depTime <= now;
                            });
                        });

                    if (activeAway) {
                        locationCode = activeAway.arrivalAirport;
                        isAtHome = false;
                        label = locationCode;
                        popupExtra = `<div style="font-size:12px;color:#c4b5fd">${locationCode} · Overnight</div>`;
                    } else if (_netjetsOffDutyHome(currentPilot)) {
                        // NetJets off duty -- auto-commuted home after the tour's last leg
                        locationCode = _netjetsOffDutyHome(currentPilot);
                        isAtHome = true;
                        label = 'Home';
                        popupExtra = `<div style="font-size:12px;color:#c4b5fd">${locationCode} · Home</div>`;
                    } else {
                        // Only trust lastArrival if it landed within the last 36 hours; older = assume pilot went home
                        const recentEnough = lastFlight && (now - new Date(lastFlight.arrivalTime)) < 36 * 60 * 60 * 1000;
                        const atHome = isHomeAirport(lastArrival, currentPilot);
                        isAtHome = !recentEnough || !lastArrival || atHome;
                        locationCode = (recentEnough && lastArrival && !atHome) ? lastArrival : home;
                        label = isAtHome ? 'Home' : locationCode;
                        popupExtra = `<div style="font-size:12px;color:#c4b5fd">${locationCode}${isAtHome ? ' · Home' : ' · Overnight'}</div>`;

                        // Reserve at a non-home airport means the pilot is at their base, not home.
                        // The away-block logic skips base airports, so handle it here.
                        if (isAtHome) {
                            const recentReserve = segments
                                .filter(s => s.type === 'reserve' && s.departureAirport)
                                .sort((a, b) => new Date(b.departureTime) - new Date(a.departureTime))
                                .find(s => {
                                    const start = new Date(s.departureTime);
                                    return !isNaN(start) && start <= now && (now - start) < 48 * 60 * 60 * 1000;
                                });
                            if (recentReserve && !isHomeAirport(recentReserve.departureAirport, currentPilot)) {
                                locationCode = normApt(recentReserve.departureAirport);
                                isAtHome = false;
                                label = locationCode;
                                popupExtra = `<div style="font-size:12px;color:#c4b5fd">${locationCode} · At base</div>`;
                            }
                        }
                    }
                }

                const locationCoords = locationCode ? resolveAirport(locationCode) : null;
                if (locationCoords) {
                    const herePopup = `<div style="font-weight:900;font-size:13px;color:#f8fafc;margin-bottom:4px">${pilotName} is here</div>${popupExtra}`;
                    WORLD_OFFSETS.forEach(w => {
                        const wCoords = [locationCoords[0], locationCoords[1] + w * 360];
                        const dotHtml = isAtHome
                            ? `<div class="here-dot" style="width:20px;height:20px;margin:-2px"></div>`
                            : `<div class="here-dot"></div>`;
                        const pin = L.marker(wCoords, {
                            icon: L.divIcon({ className: '', html: dotHtml, iconSize: [16, 16], iconAnchor: [8, 8] }),
                            zIndexOffset: 2000
                        });
                        pin.bindPopup(herePopup, { className: 'dark-popup' });
                        pin.addTo(map);
                        const hereLabel = L.marker(wCoords, {
                            icon: L.divIcon({
                                className: '',
                                html: `<div style="color:#d8b4fe;font-size:10px;font-weight:800;text-shadow:0 1px 4px rgba(0,0,0,0.9);transform:translate(-50%,8px);white-space:nowrap">${label}</div>`,
                                iconAnchor: [0, 0]
                            }),
                            interactive: false
                        }).addTo(map);
                        mapLayers.active.push(pin, hereLabel);
                        // If airborne, register for removal when ADSB confirms real position
                        if (isAirborne) hereNowMarkers.push(pin, hereLabel);
                    });
                }
            }

            if (bounds.length > 0) {
                const nb = bounds.map(p => [p[0], ((p[1] % 360) + 360) % 360]);
                map.fitBounds(L.latLngBounds(nb).pad(0.2));
            }
        }

        function toggleMapFilter(type) {
            if (mapDayMode) return;
            if (type === 'past') {
                showPast = !showPast;
                mapLayers.past.forEach(l => showPast ? l.addTo(map) : map.removeLayer(l));
                document.getElementById('btn-past').classList.toggle('map-ctrl-on', showPast);
            } else {
                showFuture = !showFuture;
                mapLayers.future.forEach(l => showFuture ? l.addTo(map) : map.removeLayer(l));
                document.getElementById('btn-future').classList.toggle('map-ctrl-on', showFuture);
            }
            // Sync airport markers to match the visible flight set
            Object.values(airportVisibilityMap).forEach(({ past, future, active, markers, labels }) => {
                const visible = (past && showPast) || (future && showFuture) || active;
                markers.forEach(m => visible ? m.addTo(map) : map.removeLayer(m));
                labels.forEach(l => visible ? l.addTo(map) : map.removeLayer(l));
            });
        }

        function updateDayNavLabel() {
            const d = new Date(mapDayDate + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            document.getElementById('day-nav-label').textContent = label;
            const mobileLabel = document.getElementById('mobile-day-nav-label');
            if (mobileLabel) mobileLabel.textContent = label;
            const picker = document.getElementById('day-nav-picker');
            if (picker) picker.value = mapDayDate;
            const mobilePicker = document.getElementById('mobile-day-nav-picker');
            if (mobilePicker) mobilePicker.value = mapDayDate;
        }

        function openDayPicker() {
            const inp = document.getElementById('day-nav-picker');
            inp.value = mapDayDate;
            try { inp.showPicker(); } catch(e) { inp.click(); }
        }

        function pickDayNav(val) {
            if (!val) return;
            mapDayDate = val;
            updateDayNavLabel();
            renderMap();
        }

        function stepDayNav(delta) {
            const d = new Date(mapDayDate + 'T00:00:00');
            d.setDate(d.getDate() + delta);
            mapDayDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            updateDayNavLabel();
            renderMap();
        }

        function computeBearing(from, to) {
            const lat1 = toRadians(from[0]), lat2 = toRadians(to[0]);
            const dLon = toRadians(to[1] - from[1]);
            const y = Math.sin(dLon) * Math.cos(lat2);
            const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
            return toDegrees(Math.atan2(y, x));
        }

        // Bezier arc with optional perpendicular offset at midpoint — separates overlapping routes
        function offsetArc(start, end, steps, offsetIndex, groupSize) {
            // Unwrap end longitude to take the shorter path (handles antimeridian crossing)
            let endLon = end[1];
            while (endLon - start[1] >  180) endLon -= 360;
            while (start[1] - endLon >  180) endLon += 360;
            const endU = [end[0], endLon];

            const gcUnwrapped = unwrapLongitudes(greatCircleArcCoords(start, endU, steps));
            if (groupSize <= 1) return gcUnwrapped;

            // Canonical direction so all flights in a pair offset consistently
            const fwd = start[0] <= endU[0];
            const cA = fwd ? start : endU, cB = fwd ? endU : start;
            const bearing = computeBearing(cA, cB);
            const perpRad = toRadians((bearing + 90) % 360);

            // Scale offset with route length so short hops and long hauls both look clean
            const dx = endU[1] - start[1], dy = endU[0] - start[0];
            const routeDeg = Math.sqrt(dx * dx + dy * dy);
            const unitOffset = Math.max(1.2, routeDeg * 0.13);
            const offsetDeg = (offsetIndex - (groupSize - 1) / 2) * unitOffset;

            // Shift the great-circle midpoint perpendicularly
            const midPt = gcUnwrapped[Math.floor(steps / 2)];
            const newMid = [
                midPt[0] + offsetDeg * Math.cos(perpRad),
                midPt[1] + offsetDeg * Math.sin(perpRad)
            ];

            // Quadratic bezier: routes stay anchored at both airports and bow apart in the middle
            return Array.from({ length: steps + 1 }, (_, i) => {
                const t = i / steps;
                return [
                    (1 - t) * (1 - t) * start[0] + 2 * (1 - t) * t * newMid[0] + t * t * endU[0],
                    (1 - t) * (1 - t) * start[1] + 2 * (1 - t) * t * newMid[1] + t * t * endU[1]
                ];
            });
        }

