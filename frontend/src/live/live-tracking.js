        function startLiveTracking(markers, callsign, color, depCoords, arrCoords, routeLines, activeLayersArr, pilotName, scheduledArrUTC, hereNowMarkers = [], lineWeight = 2.5, hitLines = null, scheduledDepUTC = null, pilotKey = null, depAirportCode = null, arrAirportCode = null) {
            const newRouteLines = Array.isArray(routeLines) ? routeLines : (routeLines ? [routeLines] : []);
            const newHitLines = hitLines || [];
            // Flown trail reads as "already behind you, less important now" vs. the heavier
            // remaining-route line ahead -- thinner on purpose, not just lower-opacity (it already
            // had that). Floored so it doesn't vanish on a pilot with an already-thin lineWeight.
            const trailWeight = Math.max(1.25, lineWeight * 0.55);

            // Confirmed landed before scheduled arrival -- don't track it, and since the caller
            // already added these brand-new markers/arc/hit-lines to the map before calling us,
            // remove them now or they'd sit there as an orphaned duplicate forever.
            if (_isLandedEarly(callsign, scheduledArrUTC?.getTime())) {
                markers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
                newRouteLines.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
                newHitLines.forEach(h => { try { map.removeLayer(h); } catch (_) {} });
                return;
            }

            // Tear down whatever was previously registered for this callsign, no matter what
            // _livePollers currently says (it's cleared on every render, so it can't be trusted
            // to detect this on its own -- see _liveLayersByCallsign's declaration comment).
            const prev = _liveLayersByCallsign[callsign];
            if (prev) {
                prev.markers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
                prev.routeLines.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
                prev.hitLines.forEach(h => { try { map.removeLayer(h); } catch (_) {} });
                clearInterval(_livePollers[callsign]);
                delete _livePollers[callsign];
                _liveLabels.delete(callsign);
                _liveLabelRefreshers.delete(callsign);
            }
            // This instance's own identity -- every closure below checks this against
            // _liveLayersByCallsign[callsign]?.instanceId before touching shared state, so a
            // still-in-flight update() from an older leg's poller (one that was just torn down
            // above, or torn down by a later call to this same function) can never clobber or
            // cancel a newer leg's own registration once it's no longer the current one. See
            // _liveTrackingInstanceSeq's own declaration comment for the failure mode this fixes.
            const _myInstanceId = ++_liveTrackingInstanceSeq;
            const _isCurrent = () => _liveLayersByCallsign[callsign]?.instanceId === _myInstanceId;
            _liveLayersByCallsign[callsign] = { markers, routeLines: newRouteLines, hitLines: newHitLines, instanceId: _myInstanceId };

            if (radarOn && !radarLayer) addRadarLayer();

            const tooltipOpts = { permanent: true, className: 'live-label', direction: 'right', offset: [14, 0] };
            // Small green checkmark-bracket glyph before the callsign when this poll's position
            // came from real FAA SWIM data (SFDPS/STDDS) rather than the ADS-B fallback -- modeled
            // on ERAM's own Visual Communications Indicator (VCI), a green symbol controllers see
            // on a Full Data Block once an aircraft has checked in on frequency. Repurposed here to
            // mean "this is confirmed SWIM data," the same "real FAA source, not a public ADS-B
            // aggregator" distinction, not a literal frequency check-in (this app has no voice
            // comms to check in on). `source` is undefined for the plain ADS-B shape
            // (parseAdsbAircraft never sets it) and 'swim'/'stdds' for the real SWIM sources.
            const VCI_GLYPH = VCI_ICON_SVG;
            const buildBaseTooltip = (source, sector) => {
                const vci = (source === 'swim' || source === 'stdds')
                    ? `<span title="Confirmed via real FAA SWIM data">${VCI_GLYPH}</span>` : '';
                // Real ATC frequency currently controlling this flight, resolved server-side from
                // SFDPS's own sector handoff (swim.js) against VATSIM's public vNAS facility data
                // (vnas.js) -- e.g. sector "ZID-21" resolves to 124.625. Only shown when it
                // actually resolved (`sector.frequency` present) -- not every real FAA facility
                // SFDPS can name is modeled in vNAS, and showing the bare sector code instead
                // isn't what was asked for. Gated behind the ✈ FREQ toggle since it's extra
                // clutter most of the time.
                // Compact: frequency inline after the callsign in monospace, no sector id, so the label stays small.
                const freqInline = (_showSectorOn && sector?.frequency)
                    ? ` <span title="ATC frequency (FAA SWIM + VATSIM vNAS)" style="font-size:9px;font-weight:700;color:#7dd3fc;font-family:ui-monospace,monospace">${(sector.frequency / 1e6).toFixed(3)}</span>` : '';
                // With the frequency shown, the pilot name is dropped to keep the label narrow.
                return `${vci}<span style="font-size:11px;font-weight:800;color:#f4f4f5">${callsign}</span>` + freqInline +
                    (pilotName && !freqInline ? ` <span style="font-size:10px;font-weight:500;color:#a1a1aa">· ${pilotName}</span>` : '');
            };
            const baseTooltip = buildBaseTooltip(null); // source unknown until the first poll resolves
            // Start hover-only — tooltip goes permanent once ADS-B confirms airborne
            markers.forEach(m => m.bindTooltip(baseTooltip, { ...tooltipOpts, permanent: false }));
            // acType: the last aircraft type a position reported (ADS-B's own, or the leg's TFMS type from the
            // server). Kept so an update with no type can't flip the plane icon back to the default.
            const labelEntry = { markers, html: baseTooltip, direction: 'right', heading: null, acType: null };
            _liveLabels.set(callsign, labelEntry);
            scheduleDeoverlap();
            const setAllTooltip = (html) => {
                labelEntry.html = html;
                markers.forEach(m => {
                    if (m.getTooltip()) m.getTooltip().setContent(html);
                    else m.bindTooltip(html, { ...tooltipOpts, permanent: false });
                });
            };
            // Last-known source/sector/suffix from this flight's own most recent poll, kept so
            // the FREQ toggle can instantly rebuild this exact label (see _liveLabelRefreshers
            // below) without needing a fresh poll response.
            let _lastTooltipSource = null, _lastTooltipSector = null, _lastTooltipSuffix = '';
            _liveLabelRefreshers.set(callsign, () => {
                setAllTooltip(buildBaseTooltip(_lastTooltipSource, _lastTooltipSector) + _lastTooltipSuffix);
            });

            // Click any world-copy marker → zoom to that flight
            markers.forEach(m => m.on('click', () => map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 9), { duration: 0.6 })));

            let flownLines = null;  // one polyline per world copy
            // Remaining route is split into two styled groups (requested directly): dashed from
            // the live position to the next fix and from the last fix to
            // the destination airport, solid for the known fix-to-fix legs in between. Two
            // separate Leaflet polyline groups because dashArray/styling applies per-polyline, not
            // per sub-path within one.
            let remainDashedLines = null;
            let remainSolidLines = null;
            let waypointMarkers = [];  // route-point symbol markers, one set per world copy
            let waypointPathKey = '';
            let arcRemoved = false;
            let missCount = 0;
            // Set ONLY by this poller's own real, found+airborne fix -- never from the server's
            // historical hint (see serverConfirmedAirborne below). This is what gates the one-time
            // removeArc()/showIcon() transition, and must only ever flip true when THIS poller has
            // personally seen the plane live, or that transition gets silently skipped forever.
            let hasBeenAirborne = false;
            // Set from the server's persistent per-aircraft history (d.hasBeenAirborne) on a miss --
            // tells us "this flight has definitely been airborne at some point", independent of
            // whether THIS poller has personally witnessed it yet. Used only to avoid misclassifying
            // a still-in-progress flight as "never got airborne" after a few misses; deliberately
            // kept separate from hasBeenAirborne so it can never skip the real-confirmation cleanup
            // above (a flat merge of the two caused exactly that: the static scheduled line stopped
            // getting removed once the plane actually appeared, because a miss response had already
            // flipped the combined flag true before any real position was ever seen).
            let serverConfirmedAirborne = false;
            // This tracker itself saw the plane moving at flying speed. Speed, not altitude: altitude is
            // above sea level, so a plane parked at Aspen reads ~7,800 ft. Taxi and server history don't
            // count either, both can be an earlier leg's.
            let _sawAirborne = false;
            let iconShown = false;

            // Hide the plane icon until ADS-B confirms the aircraft is actually moving
            markers.forEach(m => m.setOpacity(0));
            const showIcon = () => {
                if (!iconShown) {
                    iconShown = true;
                    markers.forEach(m => {
                        m.setOpacity(1);
                        // Switch tooltip to permanent now that the plane is live
                        const tip = m.getTooltip();
                        if (tip) { m.unbindTooltip(); m.bindTooltip(labelEntry.html, tooltipOpts); }
                    });
                    scheduleDeoverlap();
                }
            };

            const _arcLines = () => Array.isArray(routeLines) ? routeLines : (routeLines ? [routeLines] : []);
            // Overwrites the schedule-based status line (baked in at render time) with what
            // ADS-B actually reports — e.g. a flight the schedule marks "IN THE AIR" may really
            // still be taxiing for departure, or already on the ground at the destination.
            // Matches by class, not exact text, so it works regardless of which of the three
            // schedule-based labels (IN THE AIR / DEPARTS IN.. / COMPLETED) was originally baked in,
            // and keeps matching on repeated calls since the replacement keeps the same class.
            const updateHitPopupStatus = (html, color) => {
                if (!hitLines) return;
                hitLines.forEach(h => {
                    try {
                        const p = h.getPopup?.();
                        if (!p) return;
                        const cur = typeof p.getContent() === 'string' ? p.getContent() : '';
                        const updated = cur.replace(
                            /<div class="live-status-line"[^>]*>[\s\S]*?<\/div>/,
                            `<div class="live-status-line" style="font-size:10px;color:${color || '#22c55e'};font-weight:800;letter-spacing:.04em;margin-top:6px">${html}</div>`
                        );
                        if (updated !== cur) h.setPopupContent(updated);
                    } catch (_) {}
                });
            };

            const removeArc = () => {
                if (arcRemoved) return;
                _arcLines().forEach(rl => {
                    if (!rl || !map) return;
                    try { map.removeLayer(rl); } catch (_) {}
                    ['past', 'future', 'active'].forEach(k => {
                        const i = mapLayers[k].indexOf(rl);
                        if (i >= 0) mapLayers[k].splice(i, 1);
                    });
                });
                arcRemoved = true;
            };

            const clearRemainLines = () => {
                if (remainDashedLines) { remainDashedLines.forEach(l => { try { map.removeLayer(l); } catch (_) {} }); remainDashedLines = null; }
                if (remainSolidLines) { remainSolidLines.forEach(l => { try { map.removeLayer(l); } catch (_) {} }); remainSolidLines = null; }
            };

            const clearWaypointMarkers = () => {
                waypointMarkers.forEach(m => {
                    try { map.removeLayer(m); } catch (_) {}
                    const i = activeLayersArr.indexOf(m);
                    if (i >= 0) activeLayersArr.splice(i, 1);
                });
                waypointMarkers = [];
                _waypointLabels.delete(callsign);
                waypointPathKey = '';
            };

            // Move all world-copy markers to a new lat/lon
            const setAllLatLng = (lat, lon) =>
                markers.forEach((m, i) => m.setLatLng([lat, lon + WORLD_OFFSETS[i] * 360]));
            const setAllIcon = (icon) => markers.forEach(m => m.setIcon(icon));

            // Ends tracking for THIS flight only -- removes its own markers/arc/trail layers and
            // updates its own popup status text directly, without calling the global renderMap().
            // Every "give up" branch below used to call renderMap() to reflect its own flight's
            // new status, but that function does a full stopLivePollers() + wipe-everything +
            // redraw-everything pass -- which also tears down and restarts every OTHER flight
            // currently being live-tracked, even though nothing was wrong with them. Confirmed
            // live: two unrelated live flights would disappear and restart simultaneously the
            // moment either one's poller decided to give up, which looked like a shared ADS-B
            // outage but was actually this flight's own cleanup taking the whole map down with it.
            let _pollerStopped = false;
            // One NetJets callsign flies every leg of the day, so "airborne" and "had a trail" can be from
            // an earlier leg. No position then means parked on the ramp, not landed, and arrival times are
            // only estimates, so "early" means nothing. These legs end on real arrival evidence only.
            const _isNetjetsLeg = _NJ_CS_RE.test(callsign || '');
            const finishTracking = (savedEarly, landed = false) => {
                _pollerStopped = true;
                // A newer leg's own startLiveTracking() call already superseded this instance (see
                // _liveTrackingInstanceSeq's declaration comment) -- our own markers/lines were
                // already torn down by that call, and _confirmedParked below must never be set on
                // behalf of a stale poller, since the callsign may currently belong to a different,
                // still-genuinely-flying leg. Nothing of ours is left to clean up; stop silently.
                if (!_isCurrent()) return;
                // Confirmed-live bug: this only ever cleaned up THIS map instance's own markers/
                // arc/popup -- it never told isFlightStillActive() (app-wide, used by every other
                // render path: grid, list, day-detail, the other map views) that the flight is
                // actually done. Without this, isFlightStillActive() keeps saying "yes, still
                // active" for the full 90-minute LATE_ARRIVAL_GRACE_MS window after a late
                // scheduled arrival, so a later re-render (switching views, a periodic re-render,
                // even just reopening this same map) redraws the scheduled "active" dashed line
                // and restarts live tracking for a flight that's already landed and parked.
                if (callsign) _confirmedParked.add(parkedKey(callsign, depAirportCode));
                clearInterval(_livePollers[callsign]);
                delete _livePollers[callsign];
                _liveLabels.delete(callsign);
                _liveLabelRefreshers.delete(callsign);
                delete _liveLayersByCallsign[callsign];
                markers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
                removeArc();
                if (flownLines) { flownLines.forEach(l => { try { map.removeLayer(l); } catch (_) {} }); flownLines = null; }
                clearRemainLines();
                clearWaypointMarkers();
                if (hereNowMarkers.length) { hereNowMarkers.forEach(m => { try { map.removeLayer(m); } catch (_) {} }); hereNowMarkers.length = 0; }
                updateHitPopupStatus(savedEarly ? '✓ LANDED EARLY' : '✓ COMPLETED', '#3f3f46');
                // Last, and guarded: everything above must finish even if this fails.
                if (landed && _sawAirborne) {
                    try {
                        _showLegAsFlown(_arcLines(), newHitLines);
                        _pinLandedPilot(pilotKey, arrAirportCode, arrCoords);
                    } catch (e) { console.warn('Landed leg redraw failed:', e); }
                }
            };

            // Adaptive poll cadence -- requested directly: taxiing and landing both involve rapid
            // direction changes (taxiway turns, final descent/rollout) that the normal 8s cruise
            // cadence renders as a choppy, low-resolution trail exactly when it matters most.
            // Cruise flight is slow and nearly linear by comparison, so there's no benefit to
            // polling it any faster. Set inside update() itself (ground-state and airborne
            // branches) from the most recent poll's own data; the self-scheduling loop below reads
            // it fresh before each wait, so a phase change takes effect on the very next poll.
            const CRUISE_POLL_MS = 8000;
            const FAST_POLL_MS = 3000; // taxiing (on ground) or below 3000ft and still descending
            let _pollDelayMs = CRUISE_POLL_MS;

            const update = async () => {
                // A newer leg's own call already took over this callsign -- stop entirely rather
                // than fetch/draw on its behalf (see _liveTrackingInstanceSeq's comment).
                if (!_isCurrent()) { _pollerStopped = true; return; }
                // Precise version of the ceiling below, for a short-turnaround round trip (Mark's
                // real ~1h MDW layover) where even the 90min grace is far too slow -- see
                // _hasNewerLegStarted()'s own comment.
                if (_hasNewerLegStarted(pilotKey, callsign, scheduledDepUTC?.getTime())) {
                    finishTracking(false);
                    return;
                }
                // Hard ceiling, independent of whether the fetch below keeps "finding" a position:
                // on a reused callsign (same-day round trip, same real flight number both ways --
                // confirmed live with Delta's DL2417) this poller would otherwise never naturally
                // conclude "done," because a LATER leg sharing the callsign keeps feeding it a
                // real, genuine position -- it just isn't this leg's, so it never looks "parked"
                // and the miss-count thresholds below never fire either (every poll genuinely
                // succeeds). Confirmed live: a first attempt at this ceiling used 4h, generous
                // enough to match other long-delay grace windows elsewhere -- but that's the wrong
                // comparison; those exist to avoid giving up on a flight TOO EARLY, while this one
                // exists to reclaim a poller that's almost certainly a ghost, so it should be tight,
                // not generous. Reused LATE_ARRIVAL_GRACE_MS (90min) instead -- the same "how long
                // past scheduled arrival is a flight still plausibly this same flight" judgment
                // call already made for the grid/list views, not a new number invented for this.
                if (scheduledArrUTC && Date.now() > scheduledArrUTC.getTime() + LATE_ARRIVAL_GRACE_MS) {
                    finishTracking(false);
                    return;
                }
                try {
                    const _depQs = scheduledDepUTC ? `&depTime=${Math.floor(scheduledDepUTC.getTime()/1000)}` : '';
                    // Same origin cross-check grid/list's poller already sends -- see server.js's
                    // matchesExpectedOrigin() comment. Without this the map had no way to reject a
                    // same-day reused flight number's opposite-direction leg either: confirmed
                    // live, Sam's LGA-TUL kept showing "in the air" with a real but WRONG dashed
                    // route/position (Republic's genuine TUL-LGA return under the same RPA4605),
                    // since this fetch never told the server which direction it actually meant.
                    const _originQs = (depAirportCode ? `&origin=${encodeURIComponent(depAirportCode)}` : '') + (scheduledArrUTC ? `&arrMs=${scheduledArrUTC.getTime()}` : '') + (arrAirportCode ? `&dest=${encodeURIComponent(arrAirportCode)}` : '');
                    const d = await fetch(`${API_BASE}/live-position?callsign=${encodeURIComponent(callsign)}${_depQs}${_originQs}`).then(r => r.json());
                    // Another leg took this callsign over while we waited. Drawing now would leave this leg's
                    // trail and last position on the map with nothing to clear them until a refresh.
                    if (!_isCurrent()) { _pollerStopped = true; return; }

                    // Server confirmed the plane is parked — flight complete
                    if (d.parked) {
                        const early = !_isNetjetsLeg && scheduledArrUTC && new Date() < scheduledArrUTC;
                        if (early) _saveLandedEarly(callsign, scheduledArrUTC?.getTime());
                        finishTracking(early, true);
                        return;
                    }

                    // Preflight: show the planned/filed route before the aircraft is actually
                    // airborne, as long as real FP (flight-plan) data is available -- requested
                    // directly, scoped to a short pre-departure window by PREFLIGHT_ROUTE_MS at
                    // the call sites below (a flight hours or days out never reaches this branch
                    // at all, since startLiveTracking isn't invoked for it yet). No live position
                    // exists yet, so the plane icon stays hidden (same as any poll before the
                    // first real airborne fix) and nothing is "flown" -- the whole resolved path
                    // from the departure airport to the destination is drawn, not just whatever
                    // would be ahead of a live position that doesn't exist yet. Must come before
                    // the miss-counting branch below -- falling through to it would misread every
                    // preflight poll as a missed live fix and eventually trigger landed/early-
                    // landing cleanup for a flight that hasn't even departed.
                    if (!d.found && d.hasRoute && !hasBeenAirborne) {
                        removeArc(); // replaced by the detailed route line below, not stacked under it
                        markers.forEach(m => m.unbindTooltip()); // no callsign hover label before departure
                        const fullResolvedPath = d.routeParsed?.resolvedPath || [];
                        const midWaypoints = fullResolvedPath.filter(wp => wp.lat != null && wp.lon != null);
                        const markerWaypoints = midWaypoints.filter(wp => wp.symbol && wp.name);
                        const pathKey = markerWaypoints.map(wp => `${wp.name}:${wp.lat.toFixed(4)},${wp.lon.toFixed(4)},${wp.symbol}`).join('|');
                        if (pathKey !== waypointPathKey) {
                            clearWaypointMarkers();
                            waypointPathKey = pathKey;
                            markerWaypoints.forEach((wp, idx) => {
                                const icon = makeWaypointIcon(wp.symbol);
                                if (!icon) return;
                                const shapeColor = _WAYPOINT_SHAPES[wp.symbol].color;
                                const copies = WORLD_OFFSETS.map(w => {
                                    const m = L.marker([wp.lat, wp.lon + w * 360], { icon, interactive: false, keyboard: false });
                                    m.addTo(map);
                                    waypointMarkers.push(m);
                                    activeLayersArr.push(m);
                                    return m;
                                });
                                registerWaypointLabel(callsign, copies, wp.name, shapeColor, idx === 0);
                            });
                            scheduleDeoverlap();
                        }
                        applyRouteDetailZoomTier();

                        // One uniform dashed line for the whole planned route -- not the dashed/
                        // solid split used once airborne (that distinguishes detail levels ahead
                        // of a live position, which doesn't apply here). Dashed throughout reads
                        // as "filed, not yet flown."
                        const routePoints = [depCoords, ...midWaypoints.map(wp => [wp.lat, wp.lon]), arrCoords];
                        let fullPath = [];
                        for (let i = 0; i < routePoints.length - 1; i++) {
                            const seg = greatCircleArcCoords(routePoints[i], routePoints[i + 1]);
                            fullPath = fullPath.concat(i === 0 ? seg : seg.slice(1));
                        }
                        const fullU = unwrapLongitudes(fullPath);
                        if (remainDashedLines) {
                            remainDashedLines.forEach((l, i) => l.setLatLngs(fullU.map(([la, lo]) => [la, lo + WORLD_OFFSETS[i] * 360])));
                        } else {
                            remainDashedLines = WORLD_OFFSETS.map((w, i) => {
                                const l = L.polyline(fullU.map(([la, lo]) => [la, lo + w * 360]), { color, weight: lineWeight, opacity: 0.6, smoothFactor: 1, dashArray: '8 10', interactive: false });
                                l.addTo(map);
                                activeLayersArr.push(l);
                                return l;
                            });
                        }
                        // The wide invisible hit-line (newHitLines, with the flight-info popup
                        // already bound to it by the caller) was built against the plain
                        // straight-line arc before any of this ran, and removeArc() above only
                        // ever removed the VISIBLE plain arc, not this -- so it's still on the map,
                        // just tracing the old straight path instead of the real filed route this
                        // branch now draws. Confirmed live: that left exactly one clickable spot,
                        // wherever the old straight line happens to geometrically cross the new
                        // bowed-out real route (typically somewhere near the middle), everywhere
                        // else on the visible route was unclickable. Reshape it to match the same
                        // real path so the whole route stays clickable, same popup as always.
                        newHitLines.forEach((h, i) => h.setLatLngs(fullU.map(([la, lo]) => [la, lo + WORLD_OFFSETS[i] * 360])));
                        return;
                    }

                    if (!d.found || d.lat == null) {
                        missCount++;
                        // See serverConfirmedAirborne's declaration comment -- deliberately NOT
                        // assigned to hasBeenAirborne itself, which must only ever be set by this
                        // poller's own real found+airborne fix below.
                        if (d.hasBeenAirborne) serverConfirmedAirborne = true;
                        const confirmedAirborne = hasBeenAirborne || serverConfirmedAirborne;
                        // Lost signal after being airborne — remove the remaining arc, but only after
                        // a few consecutive misses (same threshold as the other miss-handling below).
                        // A single missed poll is routine (the server races two ADS-B sources and either
                        // can blip), and removing this instantly on miss #1 made the dashed arc flicker
                        // off and back on every time that happened mid-flight, even though the plane was
                        // never actually out of contact long enough to be a real signal loss.
                        if (confirmedAirborne && (remainDashedLines || remainSolidLines) && missCount >= 3) {
                            clearRemainLines();
                        }
                        // Server has trail data for this callsign but can't find it live → flight
                        // already flew and is no longer transmitting (early landing, taxi-in done).
                        // After a few misses, remove the scheduled arc + plane icon so we don't
                        // show a misleading "in progress" view.
                        if (!_isNetjetsLeg && !confirmedAirborne && d.hadTrail && missCount >= 3) {
                            const early = !_isNetjetsLeg && scheduledArrUTC && new Date() < scheduledArrUTC;
                            if (early) _saveLandedEarly(callsign, scheduledArrUTC?.getTime());
                            finishTracking(early);
                            return;
                        }
                        // Was airborne + server's trail gone (parked confirmed server-side) → done
                        if (!_isNetjetsLeg && confirmedAirborne && !d.hadTrail && missCount >= 3) {
                            const early = !_isNetjetsLeg && scheduledArrUTC && new Date() < scheduledArrUTC;
                            if (early) _saveLandedEarly(callsign, scheduledArrUTC?.getTime());
                            finishTracking(early, true);
                            return;
                        }
                        // Was airborne, lost signal — treat as probably landed and stop tracking.
                        // Require a much longer gap before concluding that while still well ahead
                        // of the scheduled arrival: a real multi-minute ADS-B coverage gap mid-flight
                        // is ordinary (regional jets especially, over sparser receiver coverage), and
                        // a flat ~40s threshold produced a false LANDED EARLY/COMPLETED classification
                        // for a flight confirmed still genuinely airborne, far from its destination.
                        // Close to or past the scheduled arrival, a short gap is far more plausibly real.
                        const minsToSchedArr = scheduledArrUTC ? (scheduledArrUTC.getTime() - Date.now()) / 60000 : -Infinity;
                        const probablyLandedThreshold = minsToSchedArr > 15 ? 38 /* ~5 min */ : 5 /* ~40s */;
                        if (!_isNetjetsLeg && confirmedAirborne && missCount >= probablyLandedThreshold) {
                            const early = !_isNetjetsLeg && scheduledArrUTC && new Date() < scheduledArrUTC;
                            if (early) _saveLandedEarly(callsign, scheduledArrUTC?.getTime());
                            finishTracking(early, true);
                            return;
                        }
                        if (scheduledArrUTC) {
                            const pastArr = new Date() > scheduledArrUTC;
                            if (pastArr && (missCount >= 3 || new Date() > new Date(scheduledArrUTC.getTime() + 30 * 60000))) {
                                finishTracking(false);
                            }
                        }
                        return;
                    }

                    missCount = 0;

                    // Taxiing — show the plane moving on the ground
                    if (d.onGround) {
                        _pollDelayMs = FAST_POLL_MS;
                        // If server confirms this aircraft was airborne, set local flag so the
                        // arc and delay state are cleaned up even on a fresh map load mid-taxi.
                        // Direction: TFDM's own phase is authoritative when it has one (taxi-out vs taxi-in).
                        // Otherwise fall back to whether this aircraft has been seen airborne.
                        const _tfdmTaxiIn = /TAXI_IN|ARRIVAL/.test(d.tfdmState || '') ? true : /TAXI_OUT/.test(d.tfdmState || '') ? false : null;
                        const _taxiIn = _tfdmTaxiIn ?? !!(d.hasBeenAirborne || hasBeenAirborne);
                        if (_taxiIn) hasBeenAirborne = true;
                        const _arriving = _taxiIn;
                        const kts = d.speedKts ? Math.round(d.speedKts) : null;
                        const isTaxiing = kts && kts > 5;
                        const onRunway = kts && kts >= 50; // too fast to be taxiing

                        // Remove the departure dot once we have a real position
                        if (hereNowMarkers.length) {
                            hereNowMarkers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
                            hereNowMarkers.length = 0;
                        }
                        // Remove the arc on taxi-in (post-landing), not on taxi-out —
                        // the route line stays visible until the plane actually lifts off.
                        if (!arcRemoved && hasBeenAirborne) removeArc();
                        // Remove the remaining-path lines on first ground contact after landing
                        if (hasBeenAirborne) clearRemainLines();
                        // Dim the flown trail to show the flight is complete
                        if (hasBeenAirborne && flownLines) {
                            flownLines.forEach(l => { try { l.setStyle({ opacity: 0.25 }); } catch (_) {} });
                        }
                        setAllLatLng(d.lat, d.lon);
                        if (d.heading != null) { setAllIcon(makePlaneIcon(d.heading, color, (labelEntry.acType = d.type || labelEntry.acType), true)); labelEntry.heading = d.heading; }
                        showIcon();
                        let groundLabel, groundLabelColor;
                        if (_arriving) {
                            groundLabel = onRunway ? `Landing · ${kts} kts` : isTaxiing ? `Taxiing in · ${kts} kts` : 'Arrived';
                            groundLabelColor = '#22c55e';
                        } else {
                            groundLabel = onRunway ? 'Taking off' : isTaxiing ? `Taxiing for departure` : 'On ground';
                            groundLabelColor = '#71717a';
                            // Real TFDM departure-delay insight (uploaded schedule stays the
                            // source of truth, never overwritten) -- only shown pre-departure,
                            // same reasoning as the calendar/list live text: once airborne the
                            // "left late" fact is stale next to the flight's actual progress.
                            if (d.departureDelayMin >= 10) groundLabel += ` · Delayed ${d.departureDelayMin}m`;
                        }
                        _lastTooltipSource = d.source; _lastTooltipSector = d.sector;
                        _lastTooltipSuffix = `<br><span style="font-size:9px;color:${groundLabelColor};font-weight:700">${groundLabel}</span>`;
                        setAllTooltip(buildBaseTooltip(_lastTooltipSource, _lastTooltipSector) + _lastTooltipSuffix);
                        // The static arc popup was built from schedule alone and may still say
                        // "IN THE AIR" even though ADS-B shows this aircraft hasn't lifted off
                        // (or has already landed) — overwrite it with the real ground state.
                        const popupGroundLabel = _arriving
                            ? (onRunway ? `LANDING · ${kts} KTS` : isTaxiing ? `TAXIING IN · ${kts} KTS` : '✓ ARRIVED')
                            : (onRunway ? 'TAKING OFF' : isTaxiing ? 'TAXIING FOR DEPARTURE' : 'ON GROUND');
                        updateHitPopupStatus(popupGroundLabel, groundLabelColor);
                        // Draw the taxi breadcrumb trail whenever the aircraft is on the ground with history,
                        // not only while it's moving -- taxiing stops and starts, and the trail shouldn't drop out at a stop.
                        // Only this leg's history: the server keeps trail across legs of a flight number, and older
                        // points would otherwise fan out across the map.
                        const _legTrail = (d.trail || []).filter(pt => !pt[2] || !scheduledDepUTC || pt[2] >= scheduledDepUTC.getTime() - 15 * 60000);
                        if (_legTrail.length >= 2) {
                            const taxiPath = smoothTrail(_legTrail);
                            if (taxiPath) {
                                if (flownLines) {
                                    flownLines.forEach((l, i) => l.setLatLngs(taxiPath.map(([la, lo]) => [la, lo + WORLD_OFFSETS[i] * 360])));
                                } else {
                                    flownLines = WORLD_OFFSETS.map((w, i) => {
                                        const l = L.polyline(taxiPath.map(([la, lo]) => [la, lo + w * 360]), { color, weight: trailWeight, opacity: 0.4, smoothFactor: 1, interactive: false });
                                        l.addTo(map);
                                        activeLayersArr.push(l);
                                        return l;
                                    });
                                }
                            }
                        }
                        scheduleDeoverlap();
                        return;
                    }

                    if ((d.speedKts ?? 0) > 100) {
                        _sawAirborne = true;
                        _clearLandedPin(pilotKey);
                    }
                    // Airborne — first airborne fix removes the static arc, departure dot, and delay state
                    if (!hasBeenAirborne) {
                        hasBeenAirborne = true;
                        hereNowMarkers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
                        hereNowMarkers.length = 0;
                        removeArc();
                        updateHitPopupStatus('▶ IN THE AIR', '#22c55e');
                    }
                    showIcon();

                    if (depCoords && arrCoords && !isPositionOnRoute(d.lat, d.lon, depCoords, arrCoords)) return;

                    setAllLatLng(d.lat, d.lon);
                    if (d.heading != null) { setAllIcon(makePlaneIcon(d.heading, color, (labelEntry.acType = d.type || labelEntry.acType), true)); labelEntry.heading = d.heading; }

                    const livePoint = [d.lat, d.lon];

                    // Flown: smooth GPS trail (interpolate great-circle between each pair of fixes)
                    const rawTrail = (d.trail && d.trail.length >= 2) ? d.trail : null;
                    // Trim trail to current leg using departure timestamp when available (pt[2]).
                    // Falls back to geographic proximity for older cached trails without timestamps.
                    let legTrail = rawTrail;
                    if (rawTrail) {
                        const depMs = scheduledDepUTC ? scheduledDepUTC.getTime() - 15 * 60 * 1000 : null;
                        if (depMs && rawTrail[0][2]) {
                            // Timestamp-based trim — most accurate
                            const filtered = rawTrail.filter(pt => pt[2] >= depMs);
                            if (filtered.length >= 2) legTrail = filtered;
                        } else if (depCoords) {
                            // Geographic fallback for trails without timestamps
                            let closestIdx = 0, closestDist2 = Infinity;
                            for (let ti = 0; ti < rawTrail.length; ti++) {
                                const dlat = rawTrail[ti][0] - depCoords[0], dlon = rawTrail[ti][1] - depCoords[1];
                                const dist2 = dlat * dlat + dlon * dlon;
                                if (dist2 < closestDist2) { closestDist2 = dist2; closestIdx = ti; }
                            }
                            if (closestIdx > 0 && rawTrail.length - closestIdx >= 2) legTrail = rawTrail.slice(closestIdx);
                        }
                    }
                    const flownPath = (legTrail && legTrail.length >= 2) ? smoothTrail(legTrail) : null;
                    if (flownPath) {
                        if (flownLines) {
                            flownLines.forEach((l, i) => l.setLatLngs(flownPath.map(([la, lo]) => [la, lo + WORLD_OFFSETS[i] * 360])));
                        } else {
                            flownLines = WORLD_OFFSETS.map((w, i) => {
                                const l = L.polyline(flownPath.map(([la, lo]) => [la, lo + w * 360]), { color, weight: trailWeight, opacity: 0.5, smoothFactor: 1, interactive: false });
                                l.addTo(map);
                                activeLayersArr.push(l);
                                return l;
                            });
                        }
                    }

                    // Remaining: great-circle path from live position to destination, routed
                    // through resolvedPath — the fully expanded, NASR-resolved fix sequence
                    // (named fixes/navaids/SID/STAR/airways/radial-distance points all included,
                    // not just airports) built server-side by navdata.js. Filtered down to only
                    // what's actually still ahead of the aircraft (computeRouteProgress) —
                    // fixes already passed drop off the map as the flight continues, same as the
                    // origin airport itself (always behind by definition, same disappearing
                    // treatment as any other passed fix).
                    const fullResolvedPath = d.routeParsed?.resolvedPath || [];
                    const { cumDist: _routeCum, aircraftProgress: _acProgress } =
                        fullResolvedPath.length >= 2 ? computeRouteProgress(fullResolvedPath, livePoint) : { cumDist: [], aircraftProgress: 0 };
                    const midWaypoints = fullResolvedPath
                        .filter((wp, idx) => wp.lat != null && wp.lon != null && _routeCum[idx] > _acProgress);

                    // Symbol markers for each named point (VOR/fix/waypoint — see makeWaypointIcon).
                    // The route itself rarely changes between polls, so skip the rebuild (and the
                    // marker flicker that'd come with constantly removing/re-adding) unless the
                    // actual point set has changed. Forced empty when the Route Detail toggle is
                    // off -- pathKey then naturally becomes '', which the existing diff below
                    // already treats as "point set changed," clearing any markers from before the
                    // toggle was flipped without needing a separate code path. The full set is
                    // always created regardless of the Route Detail toggle or current zoom tier --
                    // applyRouteDetailZoomTier() controls what's actually visible (instant, see its
                    // own header comment), so this only needs to track "has the real point set
                    // changed," not "is detail currently on."
                    const markerWaypoints = midWaypoints.filter(wp => wp.symbol && wp.name);
                    const pathKey = markerWaypoints.map(wp => `${wp.name}:${wp.lat.toFixed(4)},${wp.lon.toFixed(4)},${wp.symbol}`).join('|');
                    if (pathKey !== waypointPathKey) {
                        clearWaypointMarkers();
                        waypointPathKey = pathKey;
                        markerWaypoints.forEach((wp, idx) => {
                            const icon = makeWaypointIcon(wp.symbol);
                            if (!icon) return;
                            const shapeColor = _WAYPOINT_SHAPES[wp.symbol].color;
                            const copies = WORLD_OFFSETS.map(w => {
                                const m = L.marker([wp.lat, wp.lon + w * 360], { icon, interactive: false, keyboard: false });
                                m.addTo(map);
                                waypointMarkers.push(m);
                                activeLayersArr.push(m);
                                return m;
                            });
                            registerWaypointLabel(callsign, copies, wp.name, shapeColor, idx === 0);
                        });
                        scheduleDeoverlap();
                    }
                    // Unconditional every poll (not just right after a rebuild) -- belt-and-
                    // suspenders against the 'zoomend' listener missing a transition (e.g. a zoom
                    // that happens to land exactly while this same flight's markers are mid-rebuild)
                    // or deoverlapLiveLabels() (which runs on the same 'zoomend' event, registered
                    // first) re-opening a tooltip this function had just closed for a lower tier.
                    // Confirmed live: symbols for non-active fixes were staying visible at the
                    // active-only zoom tier even though their labels correctly hid, which pointed
                    // at exactly this kind of missed-reapplication gap rather than a logic error in
                    // the tier rules themselves.
                    applyRouteDetailZoomTier();

                    const routePoints = [livePoint, ...midWaypoints.map(wp => [wp.lat, wp.lon]), arrCoords];
                    const legBounds = []; // [startIdx, endIdx] into remainPath, per leg
                    let remainPath = [];
                    for (let i = 0; i < routePoints.length - 1; i++) {
                        // Full arc every leg, including both endpoints -- no longer dropping the
                        // duplicate shared junction point. The dedup saved one redundant vertex per
                        // leg (harmless either way for a polyline) but meant legBounds[i][0] didn't
                        // exactly equal the previous leg's last point, which left a hairline-to-
                        // sometimes-visible gap right at the fix wherever two differently-styled
                        // runs (dashed/solid) met -- confirmed live at the active fix where the
                        // lead dashed run ends and the solid run begins. Always including both
                        // endpoints means every leg's own slice starts and ends exactly on its
                        // fixes, so any boundary between runs lines up precisely with no gap.
                        const seg = greatCircleArcCoords(routePoints[i], routePoints[i + 1]);
                        const startIdx = remainPath.length;
                        remainPath = remainPath.concat(seg);
                        legBounds.push([startIdx, remainPath.length - 1]);
                    }
                    const remainSegs = unwrapLongitudes(remainPath);
                    // Lets deoverlapLiveLabels() keep the tag off this flight's own line.
                    labelEntry.routeAhead = remainSegs;
                    labelEntry.routeBehind = flownPath;

                    // Requested directly: dashed from the live position to the next fix, solid
                    // between subsequent known fixes, dashed again from the last fix to the
                    // destination airport -- i.e. only the first and last legs are
                    // dashed; everything between two real filed waypoints is solid. This also
                    // correctly covers the two degenerate cases: zero waypoints left (a single
                    // plane->airport leg, index 0 is simultaneously the last index too, so it's
                    // dashed throughout) and exactly one waypoint left (two legs, both of them
                    // first-or-last, so both dashed -- no solid middle, which is correct since
                    // there's no fix-to-fix segment to show).
                    //
                    // No gap trimmed around each symbol -- Leaflet's default pane order already
                    // draws markerPane above overlayPane (where polylines live), so the line simply
                    // passes underneath each 10px symbol and looks visually broken there for free.
                    // An explicit gap was tried first and reverted: it required picking a gap size,
                    // which either looked wrong across zoom levels (a geographic-distance gap) or
                    // could swallow an entire short STAR leg between closely-spaced fixes (a
                    // screen-pixel gap, even capped per-leg) -- real, confirmed bugs from that
                    // approach. Relying on z-order has neither failure mode.
                    //
                    // Each run (lead dashed / solid middle / trail dashed) must be ONE continuous
                    // points array, not one array per leg. Confirmed live this was a real bug, not
                    // just a style choice: `piece = i === 0 ? seg : seg.slice(1)` (above) drops each
                    // non-first leg's shared junction point so it isn't duplicated in the single
                    // concatenated remainPath -- fine for a continuous array, but passing one
                    // sub-array PER LEG to L.polyline makes it a multi-part polyline, and every
                    // middle leg beyond the first then starts one point short of the fix it's
                    // supposed to connect to, rendering as visibly disconnected pieces instead of
                    // one solid line through every fix. Slicing the underlying continuous
                    // remainSegs array across each leg's full index range (rather than per-leg)
                    // keeps every run gap-free by construction.
                    const numLegs = legBounds.length;
                    const dashedParts = [];
                    let solidParts = [];
                    if (numLegs === 1) {
                        dashedParts.push(remainSegs.slice(legBounds[0][0], legBounds[0][1] + 1));
                    } else if (numLegs === 2) {
                        // No middle fix at all -- the two dashed legs are adjacent, so merge them
                        // into one continuous run too rather than leaving a micro-gap between them.
                        dashedParts.push(remainSegs.slice(legBounds[0][0], legBounds[1][1] + 1));
                    } else {
                        dashedParts.push(remainSegs.slice(legBounds[0][0], legBounds[0][1] + 1));
                        dashedParts.push(remainSegs.slice(legBounds[numLegs - 1][0], legBounds[numLegs - 1][1] + 1));
                        solidParts = [remainSegs.slice(legBounds[1][0], legBounds[numLegs - 2][1] + 1)];
                    }

                    const renderRemainGroup = (existingLines, parts, dashArray) => {
                        if (existingLines) {
                            existingLines.forEach((l, i) => l.setLatLngs(parts.map(part => part.map(([la, lo]) => [la, lo + WORLD_OFFSETS[i] * 360]))));
                            return existingLines;
                        }
                        return WORLD_OFFSETS.map((w, i) => {
                            const l = L.polyline(parts.map(part => part.map(([la, lo]) => [la, lo + w * 360])), { color, weight: lineWeight, opacity: 0.7, smoothFactor: 1, dashArray, interactive: false });
                            l.addTo(map);
                            activeLayersArr.push(l);
                            return l;
                        });
                    };
                    remainDashedLines = renderRemainGroup(remainDashedLines, dashedParts, '8 10');
                    remainSolidLines = renderRemainGroup(remainSolidLines, solidParts, null);

                    // Keep hit polylines aligned with the live flown+remaining path so popups still fire
                    if (hitLines && hitLines.length) {
                        const fullPath = [...(flownPath || [livePoint]), ...remainPath.slice(1)];
                        const fullU = unwrapLongitudes(fullPath);
                        hitLines.forEach((h, i) => h.setLatLngs(fullU.map(([la, lo]) => [la, lo + WORLD_OFFSETS[i] * 360])));
                    }

                    // Below 3000ft covers both ends of a flight that benefit from tighter polling
                    // -- final approach/landing and initial climb-out -- without needing to know
                    // which one it actually is; cruise altitude is the only case that doesn't.
                    _pollDelayMs = (d.altFt != null && d.altFt < 3000) ? FAST_POLL_MS : CRUISE_POLL_MS;
                    const altFt = d.altFt ? Math.round(d.altFt) : null;
                    const kts   = d.speedKts ? Math.round(d.speedKts) : null;
                    const detail = [altFt ? `${altFt.toLocaleString()} ft` : null, kts ? `${kts} kts` : null].filter(Boolean).join(' · ');
                    _lastTooltipSource = d.source; _lastTooltipSector = d.sector;
                    _lastTooltipSuffix = detail ? `<br><span style="font-size:9px;color:#71717a">${detail}</span>` : '';
                    setAllTooltip(buildBaseTooltip(_lastTooltipSource, _lastTooltipSector) + _lastTooltipSuffix);
                    scheduleDeoverlap();
                } catch (_) {}
            };

            // Self-scheduling instead of a fixed setInterval so the adaptive cadence above can
            // actually take effect poll-to-poll -- _livePollers[callsign] still holds a single
            // cancelable timer id either way (clearInterval/clearTimeout are interchangeable, same
            // underlying id space), so every existing teardown site (finishTracking(),
            // stopLivePollers(), the tear-down-previous-registration block) needs no change.
            const scheduleNextPoll = () => {
                // update() calling finishTracking() mid-run (e.g. server confirms parked) sets
                // this before we get here -- without checking it, this self-rescheduling loop
                // would just set a brand new timer right after, silently reviving a poller that
                // was just supposed to stop (the one real risk a plain setInterval didn't have).
                // _isCurrent() catches the narrower race the instance-id system exists for: a
                // newer leg's call superseded this one WHILE this tick's update() was already
                // in-flight (mid-fetch) -- its own top-of-update() check already passed before
                // that happened, so it still finishes this one tick using possibly-stale data,
                // but must not be allowed to arm a next timer afterward.
                if (_pollerStopped || !_isCurrent()) return;
                _livePollers[callsign] = setTimeout(async () => { await update(); scheduleNextPoll(); }, _pollDelayMs);
            };
            update().then(scheduleNextPoll); // immediate first update, then start the adaptive loop
        }

        // Aircraft SVG shapes from ADS-B Exchange / tar1090 (BSD-2 licensed)
        const _AC_SHAPES = {
            narrowbody: {
                // Boeing 737-800 (b738) — underwing CFM56s, swept wings
                vb: '-2 -2 74.5 87.3', w: 24, h: 32, sw: 2,
                d: 'M34.894 80.404c-1.458.366-14.151 2.859-14.151 2.859l-.069-2.434 12.769-7.019c-1.535-6.779-1.876-8.758-2.061-14.716l-.022-15.412-4.679.026c.018.731-.129 1.457-.429 2.125-.418-.667-.401-1.322-.397-2.101-.794 0-1.561.198-2.352.329.024.836-.095 1.488-.437 2.156-.347-.635-.352-1.136-.402-1.971l-5.735 1.323c-.008.857.04 1.345-.392 2.119-.373-.631-.41-1.257-.41-1.962L1.793 48.877c-1.957.397-1.572.561-1.74 1.544.013-.86-.036-2.334-.026-3.249 0-.52.116-.751.595-.976 7.89-4.004 16.208-7.251 23.891-11.472-.101-.701-.568-.221-.737-.493-.311-2.068-.344-4.905-.118-6.453.04-.224.102-.456.299-.455 1.586.008 1.912-.042 3.26-.013.198.004.294.208.331.427a28.34 28.34 0 0 1 .083 4.839l3.735-3.088.069-13.676C31.706 9.73 33.288.467 35.292.024c2.004.443 3.586 9.706 3.858 15.785.103 1.762.095 11.43.082 13.678l3.735 3.086a28.18 28.18 0 0 1 .075-4.847c.037-.218.124-.415.321-.419 1.349-.029 1.673.021 3.26.013.198 0 .259.233.299.456.225 1.548.194 4.384-.118 6.452-.169.274-.635-.208-.736.495 7.681 4.22 16.001 7.468 23.892 11.471.476.225.594.456.593.978.011.914-.04 2.388-.026 3.248-.168-.983.217-1.148-1.738-1.543l-14.335-3.153c.001.705-.037 1.332-.41 1.963-.431-.775-.384-1.263-.392-2.119l-5.735-1.323c-.049.833-.054 1.336-.401 1.971-.341-.669-.46-1.322-.437-2.156-.791-.132-1.561-.331-2.353-.331.004.781.021 1.434-.397 2.101-.3-.667-.446-1.392-.429-2.123l-4.679-.026-.011 15.412c-.185 5.958-.527 7.938-2.061 14.715l12.769 7.018-.069 2.437-14.151-2.86c-.098.415-.09 1.303-.402 1.292-.312.012-.304-.876-.402-1.291z'
            },
            regional: {
                // Embraer E-jet style (e737) — underwing engines, shorter fuselage
                vb: '-2 -2 74.5 74.5', w: 22, h: 28, sw: 2,
                d: 'M34.89 67.926c-1.458.367-14.152 2.859-14.152 2.859l-.069-2.436 12.769-7.019c-1.535-6.778-1.875-8.756-2.061-14.716l-.016-9.017-4.68.026c.014.786-.128 1.422-.429 2.124-.418-.666-.401-1.321-.397-2.1-.793-.001-1.561.197-2.352.329.023.836-.096 1.488-.437 2.157-.347-.636-.352-1.137-.402-1.972l-5.735 1.324c-.008.857.04 1.345-.392 2.119-.372-.631-.411-1.258-.41-1.963L1.794 42.794c-1.953.524-1.762.769-1.765-1.705 0-.521.117-.752.594-.977 7.89-4.004 16.21-7.251 23.891-11.472-.1-.702-.567-.221-.736-.494-.312-2.068-.343-4.905-.118-6.453.04-.223.102-.457.299-.456 1.586.008 1.912-.042 3.259-.013.197.004.294.209.331.428.162 1.382.191 3.489.074 4.848l3.736-3.087c-.013-2.248-.028-5.838.075-7.6.271-6.08 1.853-15.343 3.858-15.786 2.004.443 3.586 9.706 3.858 15.785.103 1.762.088 5.352.075 7.6l3.736 3.087c-.116-1.358-.087-3.465.074-4.848.037-.219.133-.424.331-.428 1.348-.029 1.674.021 3.259.013.197-.001.259.232.299.456.226 1.548.194 4.385-.118 6.453-.169.273-.636-.207-.736.494C53.75 32.86 62.07 36.108 69.96 40.111c.478.225.595.456.594.977.044 2.197.194 2.108-1.765 1.705l-14.335-3.152c.001.705-.037 1.332-.41 1.963-.431-.774-.384-1.263-.392-2.119l-5.735-1.324c-.049.836-.055 1.336-.402 1.972-.341-.669-.46-1.322-.437-2.157-.791-.132-1.559-.33-2.352-.329.004.779.021 1.434-.397 2.1-.301-.702-.443-1.338-.429-2.124l-4.68-.026-.016 9.017c-.186 5.959-.526 7.938-2.061 14.716l12.769 7.019-.069 2.436-14.152-2.859c-.097.415-.089 1.303-.402 1.291-.312.012-.304-.876-.402-1.291z'
            },
            bizjet: {
                // Swept-wing jet (jet_swept) — H25B, Gulfstream, CRJ style
                vb: '-1 -1 20 26', w: 20, h: 26, sw: 0.5,
                d: 'M9.44,23c-.1.6-.35.6-.44.6s-.34,0-.44-.6l-3,.67V22.6A.54.54,0,0,1,6,22.05l2.38-1.12L8,19.33H6.69l0-.2a8.23,8.23,0,0,1-.14-3.85l.06-.18H7.73V13.19h-2L.26,14.29v-.93c0-.28.07-.46.22-.53l7.25-3.6V3.85A4.47,4.47,0,0,1,8.83.49L9,.34l.17.15a4.47,4.47,0,0,1,1.1,3.36V9.23l7.25,3.6c.14.07.22.25.22.53v.93l-5.51-1.1h-2V15.1h1.17l.06.18a8.24,8.24,0,0,1-.15,3.84l0,.2H10l-.36,1.6,2.43,1.14a.52.52,0,0,1,.35.53v1.08Z'
            },
            lightjet: {
                // Straight unswept wings (jet_nonswept from tar1090): Citation CJ-style light jets, and props
                vb: '-2 -2.4 22 22', w: 22, h: 22, sw: 0.5,
                d: 'M9,17.09l-3.51.61v-.3c0-.65.11-1,.33-1.09L8.5,15a5.61,5.61,0,0,1-.28-1.32l-.53-.41-.1-.69H7.12l0-.21a7.19,7.19,0,0,1-.15-2.19L.24,9.05V8.84c0-1.1.51-1.15.61-1.15L7.8,7.18V2.88C7.8.64,8.89.3,8.93.28L9,.26l.07,0s1.13.36,1.13,2.6v4.3l7,.51c.09,0,.59.06.59,1.15v.21l-6.69,1.16a7.17,7.17,0,0,1-.15,2.19l0,.21h-.47l-.1.69-.53.41A5.61,5.61,0,0,1,9.5,15l2.74,1.28c.2.07.31.43.31,1.08v.3Z'
            }
        };

