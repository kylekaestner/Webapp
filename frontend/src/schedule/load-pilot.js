        function loadAirportDB() {
            fetch('/airports.json').then(r => {
                if (!r.ok) throw new Error('Failed to load airports.json');
                return r.json();
            }).then(data => {
                Object.assign(AIRPORTS, data);
                // Renamed airports newer than airports.json (same list as server.js): KPBI -> KDJT.
                for (const [neu, old] of Object.entries({ DJT: 'PBI', KDJT: 'KPBI' })) {
                    if (!AIRPORTS[neu] && AIRPORTS[old]) { AIRPORTS[neu] = AIRPORTS[old]; data[neu] = AIRPORTS[old]; }
                }
                // Timezones are looked up per airport as needed (airportTz()), not for all 111k up front.
                // Redraw so times that had no airport data yet pick up their zone.
                if (typeof render === 'function') render();
                airportDbReady = true;
                if (currentView === 'map') renderMap();
            }).catch(err => {
                console.warn('Airport DB load failed:', err);
                airportDbReady = true;  // fail open — map renders with whatever resolved
                if (currentView === 'map') renderMap();
            });
        }

        loadAirportDB();

        // NetJets line-switch "seam" transition data -- see server.js's own header comment above
        // _seamKey()/_computeSeamWindow() for the full reasoning. Loaded once; a failed/missing
        // fetch just means no seam override is available, same fail-open posture as the airport
        // DB above -- the normal rotation formula still works fine without it.
        let _seamTables = null;
        function loadSeamTables() {
            fetch('/seam-tables.json').then(r => r.ok ? r.json() : null).then(data => { _seamTables = data; }).catch(() => {});
        }
        loadSeamTables();

        function resolveAirport(code) {
            if (!code) return null;
            const upper = code.toUpperCase();
            if (AIRPORTS[upper]) return AIRPORTS[upper];
            // For K/C-prefix ICAO codes (US/Canada), never strip the prefix and look up
            // the 3-letter remainder — PAN (Thailand) ≠ KPAN (Arizona)
            if (upper.length === 4 && upper[0] !== 'K' && upper[0] !== 'C') {
                const last3 = upper.slice(-3);
                if (AIRPORTS[last3]) return AIRPORTS[last3];
            }
            // accept 3-letter IATA by trying K-prefix ICAO
            if (upper.length === 3) {
                if (AIRPORTS['K' + upper]) return AIRPORTS['K' + upper];
            }
            // final attempt: strip any leading non-alphanum and retry
            const stripped = upper.replace(/[^A-Z0-9]/g, '');
            if (stripped !== upper) return resolveAirport(stripped);
            return null;
        }

        // Fetch pilot data from server
        async function fetchPilotData(pilot) {
            try {
                isLoading = true;
                const response = await fetch(_pilotFetchUrl(pilot));
                if (!response.ok) {
                    if (response.status === 403) {
                        const body = await response.json().catch(() => ({}));
                        if (body.error === 'not_friends') return { __notFriends: true, pilotKey: body.pilotKey, name: body.name };
                    }
                    throw new Error(`Failed to fetch pilot: ${response.status}`);
                }

                const data = await response.json();
                pilotsCache[pilot] = data;
                return data;
            } catch (error) {
                console.error('Error fetching pilot:', error);
                return null;
            } finally {
                isLoading = false;
            }
        }
//blah
        // Save pilot schedule to server (via upload)
        async function uploadPilotSchedule(pilot, file) {
            try {
                isLoading = true;
                const formData = new FormData();
                formData.append('file', file);
                if (myToken) formData.append('token', myToken);

                const response = await fetch(`${API_BASE}/pilots/${pilot}/upload`, {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    let errMsg = `Upload failed: ${response.status}`;
                    try { const j = await response.json(); errMsg = j.error || errMsg; } catch(_) {}
                    throw new Error(errMsg);
                }

                const result = await response.json();

                // Reload pilot data
                await fetchPilotData(pilot);
                return result;
            } catch (error) {
                console.error('Upload error:', error);
                showToast(`Upload error: ${error.message}`, 'error');
                return null;
            } finally {
                isLoading = false;
            }
        }

        function sortSegmentsByTime(segList) {
            return segList.slice().sort((a, b) => {
                const aTime = a.departureTime ? Date.parse(a.departureTime) : Infinity;
                const bTime = b.departureTime ? Date.parse(b.departureTime) : Infinity;
                if (aTime !== bTime) return aTime - bTime;
                const aEnd = a.arrivalTime ? Date.parse(a.arrivalTime) : Infinity;
                const bEnd = b.arrivalTime ? Date.parse(b.arrivalTime) : Infinity;
                if (aEnd !== bEnd) return aEnd - bEnd;
                return (a.type || '').localeCompare(b.type || '');
            });
        }

        // Synthesizes 'away' day markers between consecutive flights when the pilot
        // overnights away from their home base. Injected into segments[] so the
        // calendar grid can color those days correctly without storing them in the DB.
        function inferAwayLayovers(segList, base, baseHistory) {
            const sorted = sortSegmentsByTime(segList);
            const awayEvents = [];
            const flights = sorted.filter(s => s.type === 'flight' && s.departureTime && s.arrivalTime && s.trip !== 'PERSONAL' && !s.cancelled);

            // Same anchor-walk as buildGroundPeriods's baseAt() (app.html, buildGroundPeriods) --
            // a trip already in progress when a base change takes effect stays on the OLD base for
            // its whole duration, even for legs landing after the change. See that function's
            // comment for the full reasoning; kept as a local copy here since this operates on the
            // camelCase segment shape (departureTime/departureAirport) rather than the raw API one.
            const knownBases = new Set();
            if (base) knownBases.add(normApt(base));
            (baseHistory || []).forEach(h => h.base && knownBases.add(normApt(h.base)));
            const allDeps = sorted.filter(s => s.departureTime && s.departureAirport);
            const baseAt = (d) => {
                const atDate = d instanceof Date ? d : new Date(d);
                let anchor = atDate;
                for (const n of allDeps) {
                    const nT = new Date(n.departureTime);
                    if (nT > atDate) break;
                    if (knownBases.has(normApt(n.departureAirport))) anchor = nT;
                }
                return resolveBaseAt(base, baseHistory, anchor);
            };

            for (let i = 0; i < flights.length - 1; i++) {
                const current = flights[i];
                const next = flights[i + 1];

                if (!current.arrivalAirport) continue;
                if (!next.departureTime) continue;
                // Never generate away events when the pilot is at their airline base or home city.
                if (sameApt(current.arrivalAirport, baseAt(current.arrivalTime))) continue;
                if (isHomeAirport(current.arrivalAirport, currentPilot)) continue;

                try {
                    let arrDate = new Date(current.arrivalTime);
                    let depDate = new Date(next.departureTime);

                    if (isNaN(arrDate.getTime()) || isNaN(depDate.getTime())) continue;

                    arrDate.setHours(0, 0, 0, 0);
                    depDate.setHours(0, 0, 0, 0);

                    // Skip same-day turns — only generate events when the pilot crosses a
                    // midnight boundary (i.e. arrival day != departure day).
                    if (depDate <= arrDate) continue;

                    // Start on the arrival day (inclusive) and run through the departure
                    // day (inclusive). This fixes one-night layovers where the old
                    // arrDate+1 start caused zero events to be generated.
                    const day = new Date(arrDate);
                    // NetJets pilots airline home on a tour's last day -- the gap to the next tour's
                    // first leg is days off at home, not an away layover at the last tour airport.
                    const isNetjets = pilotsCache[currentPilot]?.parser_type === 'manual_netjets';
                    while (day <= depDate) {
                        const y = day.getFullYear(), m = String(day.getMonth() + 1).padStart(2, '0'), d = String(day.getDate()).padStart(2, '0');
                        if (!(isNetjets && !_isNetJetsOnDuty(currentPilot, `${y}-${m}-${d}`)))
                            awayEvents.push({ type: 'away', departureTime: `${y}-${m}-${d}T00:00:00`, arrivalAirport: current.arrivalAirport });
                        day.setDate(day.getDate() + 1);
                    }
                } catch (err) {
                    console.error('Error inferring away layover:', err, current, next);
                    continue;
                }
            }
            return sortSegmentsByTime([...sorted, ...awayEvents]);
        }

        // Shown in place of the normal grid/list content when GET /api/pilots/:key 403s with
        // "not_friends" — offers a one-tap request instead of a blank/broken view. Map views
        // simply skip a pilot that was never cached rather than showing this (acceptable: the
        // prompt belongs to the pilot's own calendar/list, not every view that touches them).
        function _renderNotFriendsState(pilotKey, name) {
            document.getElementById('pilot-header').textContent = name || pilotKey;
            const mobileHeader = document.getElementById('pilot-header-mobile');
            if (mobileHeader) mobileHeader.textContent = (name || pilotKey).split(' ')[0].toUpperCase();
            const msg = `
                <div class="flex flex-col items-center justify-center text-center py-20 px-6">
                    <div class="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style="background:rgba(59,130,246,0.1)">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                    </div>
                    <div class="text-base font-black text-white mb-1.5">Not friends with ${escapeHtml(name || pilotKey)} yet</div>
                    <p class="text-sm text-zinc-500 max-w-xs mb-5">Send a friend request to see their schedule. They'll need to accept before you can see each other.</p>
                    <button onclick="sendFriendRequest('${pilotKey}', this)" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-black text-xs uppercase tracking-widest transition-colors">+ Send Friend Request</button>
                </div>`;
            const gridEl = document.getElementById('calendar-grid-content');
            const listEl = document.getElementById('calendar-list-content');
            if (gridEl) gridEl.innerHTML = msg;
            if (listEl) listEl.innerHTML = msg;
        }

        // loadPilot is the main entry point for switching whose schedule is displayed.
        // It fetches from the server, converts snake_case -> camelCase, injects away
        // events, updates all headers/pills/active states, then calls render().
        // Also the target for pull-to-refresh.
        // Switching crew used to show the loading overlay and wait for the full schedule from the server, then
        // city names and landed-early status, one after another, on every tap, even for someone viewed a
        // moment ago (~0.4 s per switch on a phone-like connection, more with real schedules). And a slow
        // response for an earlier tap could land last and put that schedule under the newer name.
        // Now: a schedule already in pilotsCache shows at once and is refreshed in the background (redrawn
        // only if it changed); each tap gets a number and responses for an older tap are dropped; the
        // landed-early check runs alongside the fetch; and visible crew are pre-loaded once the app is idle
        // (_prefetchCrewSchedules), so most first taps are instant too.
        let _loadPilotGen = 0;
        function _pilotSegmentsFrom(data) {
            let segmentData = [];
            if (data.segments && Array.isArray(data.segments)) {
                segmentData = data.segments.map(seg => ({
                    id: seg.id,
                    type: seg.type,
                    departureTime: seg.departure_time,
                    arrivalTime: seg.arrival_time,
                    departureAirport: seg.departure_airport,
                    arrivalAirport: seg.arrival_airport,
                    tail: seg.tail || '',
                    trip: seg.trip || '',
                    flightNumber: seg.flight_number || '',
                    dh: seg.is_dh ? true : false,
                    isManual: seg.is_manual ? true : false,
                    blockMinutes: seg.block_minutes || null,
                    cancelled: seg.auto_leg_cancelled ? true : false
                }));
            }

            return segmentData;
        }
        // Everything that puts this pilot's schedule on screen (no fetching, no popups).
        function _showPilotData(pilot, data, segmentData) {
            // Sync dynamic pilot metadata from DB (role, name) — handles newly joined pilots
            if (data.name)  PILOT_NAMES[pilot] = data.name;
            if (data.role)  PILOT_ROLES[pilot] = data.role;
            if (data.home_airport) PILOT_HOME[pilot] = data.home_airport;

            // Re-evaluate upload vs sync button now that parser_type is known
            if (pilot === myPilot) updateUploadSyncButtons(pilot);

            const pilotBase = data.base || null;
            segments = inferAwayLayovers(segmentData || [], pilotBase, data.base_history);
            const displayName = data.name || pilot;
            const firstName   = displayName.split(' ')[0];
            // Personalized header: "Your Schedule" / "[Name]'s Schedule" / full name for admin
            let headerText, mobileHeaderText;
            if (myPilot && pilot === myPilot) {
                headerText = 'Your Schedule';
                mobileHeaderText = 'YOU';
            } else if (myPilot) {
                headerText = `${firstName}'s Schedule`;
                mobileHeaderText = firstName.toUpperCase();
            } else {
                headerText = displayName;
                mobileHeaderText = firstName.toUpperCase();
            }
            document.getElementById('pilot-header').textContent = headerText;
            // Sync mobile header
            const mobileHeader = document.getElementById('pilot-header-mobile');
            if (mobileHeader) mobileHeader.textContent = mobileHeaderText;
            // Update sidebar next-trip widget when viewing own schedule
            _updateNextTripWidget(pilot, segmentData);
            // Sync desktop sidebar pilot active states
            PILOT_KEYS.forEach(k => {
                const btn = document.getElementById(`pilot-${k}`);
                if (!btn) return;
                const pc = PILOT_COLORS[k] || '#3b82f6';
                if (k === pilot) {
                    btn.style.background = pc + '1a';
                    btn.style.borderColor = pc + '55';
                } else {
                    btn.style.background = '';
                    btn.style.borderColor = '';
                }
            });
            // Sync mobile pilot pill active states
            document.querySelectorAll('.mpilot-btn').forEach(b => {
                b.style.borderColor = '';
                b.style.color = '';
                b.style.background = '';
            });
            const mpill = document.getElementById(`mpilot-${pilot}`);
            if (mpill) {
                const pc = PILOT_COLORS[pilot] || '#3b82f6';
                mpill.style.borderColor = pc + '80';
                mpill.style.color = pc;
                mpill.style.background = pc + '1a';
            }
            // Re-apply identity tint to "you" pill (if different from active)
            _applyPillIdentity();
        }
        function loadPilot(pilot) {
            haptic('tap');
            currentPilot = pilot;
            localStorage.setItem('lastPilot', pilot);
            _applyEditPermissions();
            _updateMyRoutesLabel();
            const gen = ++_loadPilotGen;

            const loadingOverlay = document.getElementById('loading-overlay');
            // Already loaded this session: show it now, refresh below.
            const cached = pilotsCache[pilot];
            const showCached = !!(cached && Array.isArray(cached.segments));
            if (showCached) {
                loadingOverlay.classList.remove('loading-active');
                _showPilotData(pilot, cached, _pilotSegmentsFrom(cached));
                render();
            } else {
                loadingOverlay.classList.add('loading-active');
            }
            const cachedJson = showCached ? JSON.stringify(cached) : null;
            const landed = _reloadLandedEarly(); // independent of the schedule, so it runs alongside

            // Fetch from server
            fetchPilotData(pilot).then(async (data) => {
                if (gen !== _loadPilotGen) return; // a later tap took over; its own load is in charge
                loadingOverlay.classList.remove('loading-active');
                if (!data) {
                    console.error('Failed to load pilot data');
                    return;
                }
                if (data.__notFriends) {
                    segments = [];
                    _renderNotFriendsState(data.pilotKey, data.name);
                    return;
                }
                const segmentData = _pilotSegmentsFrom(data);

                // Cache pilot data for use in render()
                pilotsCache[pilot] = data;
                if (pilot === myPilot) { _maybeShowNetjetsTailReminder(pilot, data); _maybeShowNetjetsLastLegAlert(pilot, data); }
                const unchanged = cachedJson !== null && cachedJson === JSON.stringify(data);
                if (!unchanged) _showPilotData(pilot, data, segmentData);
                // City names and landed-early status are independent requests, so they run together
                // rather than one after the other.
                const knownApts = () => Object.keys(_serverCityCache).length + Object.keys(AIRPORTS).length;
                const aptsBefore = knownApts();
                const [, landedGrew] = await Promise.all([_prefetchCities(data.segments || []), landed]);
                const newCityNames = knownApts() > aptsBefore;
                if (gen !== _loadPilotGen) return;
                // Was only ever loaded by renderMap() -- meaning a flight confirmed landed
                // early (before its scheduled arrival) kept showing "IN THE AIR" in the
                // calendar grid, list view, and day detail sheet indefinitely whenever Map
                // hadn't been opened this session, since those views had no way to know about
                // it. Loaded here too so every view has it before its first render.
                // Shown from cache already and nothing changed: no second render (it would reset list scrolling).
                if (!unchanged || landedGrew || newCityNames) render();
                // Show empty-state prompt for newly joined pilots viewing their own blank schedule
                const emptyBanner = document.getElementById('empty-schedule-banner');
                if (emptyBanner) {
                    const isOwn = myPilot && myPilot === pilot && !isDemo;
                    // NetJets has no feed to upload at all -- a zero-segment schedule is the
                    // normal starting state until legs are auto-created or manually added, not a
                    // "newly joined, go upload something" situation this banner is meant for.
                    const isNetjets = pilotsCache[pilot]?.parser_type === 'manual_netjets';
                    emptyBanner.classList.toggle('hidden', !(isOwn && segmentData.length === 0 && !isNetjets));
                }
                checkScheduleUploadReminder(pilot);
                dismissSplash();
                _prefetchCrewSchedules();
            });
        }
        // Once, after the first schedule is up and the browser is idle: load the other visible crew's
        // schedules into pilotsCache one at a time, so switching to them is instant. Never replaces data
        // already loaded; skipped on data-saver connections.
        let _crewPrefetchStarted = false;
        function _prefetchCrewSchedules() {
            if (_crewPrefetchStarted) return;
            _crewPrefetchStarted = true;
            if (navigator.connection && navigator.connection.saveData) return;
            const keys = (typeof getCrewVisible === 'function' ? getCrewVisible() : PILOT_KEYS).filter(k => k && !pilotsCache[k]);
            const next = () => {
                const k = keys.shift();
                if (!k) return;
                if (pilotsCache[k]) return next();
                fetch(_pilotFetchUrl(k))
                    .then(r => r.ok ? r.json() : null)
                    .then(d => { if (d && Array.isArray(d.segments) && !pilotsCache[k]) { pilotsCache[k] = d; return _prefetchCities(d.segments); } })
                    .catch(() => {})
                    .finally(() => (window.requestIdleCallback || (cb => setTimeout(cb, 200)))(next, { timeout: 3000 }));
            };
            setTimeout(() => (window.requestIdleCallback || (cb => cb()))(next, { timeout: 3000 }), 1000);
        }

