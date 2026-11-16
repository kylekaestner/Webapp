        // Returns the away airport code if the pilot is sitting away on a personal trip on dateKey,
        // or null if they're home. (personal flight arrived at non-home, no flight returned home since)
        function isPersonallyAway(dateKey) {
            const dayStart = new Date(dateKey + 'T00:00:00');
            const sorted = (segments || [])
                .filter(s => s.type === 'flight' && s.arrivalTime && s.arrivalAirport)
                .sort((a, b) => new Date(a.arrivalTime) - new Date(b.arrivalTime));
            let awayApt = null;
            for (const f of sorted) {
                if (new Date(f.arrivalTime) >= dayStart) break;
                const arrApt = normApt(f.arrivalAirport);
                if (f.trip === 'PERSONAL' && !isHomeOrBase(arrApt, currentPilot)) {
                    awayApt = f.arrivalAirport; // keep original code for display
                } else if (isHomeOrBase(arrApt, currentPilot)) {
                    awayApt = null;
                }
            }
            return awayApt;
        }

        // render() rebuilds the active view from the current segments[] array.
        // It does NOT fetch -- call loadPilot() to refresh data from the server.
        // Routes: 'grid' -> month calendar cells | 'list' -> day rows |
        //         'map'  -> calls renderMap()     | 'overlap' -> handled separately
        // After every render, attachTooltips() and startCalListLivePolling() run
        // to wire up hover details and ADS-B live badges on active flights.
        function render() {
            const gridContainer = document.getElementById('calendar-grid-content');
            const listContainer = document.getElementById('calendar-list-content');
            gridContainer.innerHTML = '';
            listContainer.innerHTML = '';

            const year = viewDate.getFullYear();
            const month = viewDate.getMonth();
            const monthLabel = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            document.getElementById('current-month-display').textContent = monthLabel;
            const mobileMonth = document.getElementById('current-month-display-mobile');
            if (mobileMonth) mobileMonth.textContent = monthLabel;

            if (currentView === 'grid') {
                // Background-fetch uncached pilots so "all crew off" detection works on first
                // load -- only pilots we can actually see, not everyone.
                visiblePilotKeys().forEach(k => {
                    if (!pilotsCache[k]) {
                        _loadPilotOnce(k).catch(() => {});
                    }
                });
                // Monthly totals shown next to the legend below, tallied from the exact same
                // per-day `tag` precedence the cell itself ends up colored with (so a day never
                // reads one status on its cell and a different one in the total) -- FLYING/TRAINING
                // count as flown (duty time), ON CALL (reserve, or Kyle's assumed-on-call default
                // when nothing else is logged) counts separately, and everything else (HARD OFF,
                // VAC, AWAY, plain OFF) counts as off.
                let monthFlown = 0, monthOff = 0, monthOnCall = 0;
                const firstDay = new Date(year, month, 1).getDay();
                const dayOffset = firstDay; // 0=Sun, 1=Mon, … — getDay() is already Sunday-first
                const daysInMonth = new Date(year, month + 1, 0).getDate();
                // Accumulate into a local string and assign once at the end — repeated
                // `innerHTML +=` re-serializes and re-parses the whole grid on every
                // iteration (O(n²)), which is what made month-swipe feel laggy on mobile.
                let gridHtml = '';
                const blockByDay = _showBlockTotals() ? _blockByDay() : null;
                const tourEnds = {};
                for (let i = 0; i < dayOffset; i++) gridHtml += `<div style="height:170px" class="opacity-0"></div>`;
                for (let d = 1; d <= daysInMonth; d++) {
                    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const dayDate = new Date(year, month, d);
                    const today = new Date();
                    today.setHours(0,0,0,0);
                    const isPastDay = dayDate < today;
                    const isToday = dayDate.getTime() === today.getTime();
                    const dayClasses = [];
                    if (isPastDay) dayClasses.push('day-past');
                    if (isToday) dayClasses.push('day-today');
                    const dayEvents = segments.filter(s => {
                        if (!s.departureTime) return false;
                        // A NetJets leg NetJets itself says isn't happening (auto_leg_cancelled) --
                        // Day Detail shows it struck-through with context when tapped into, but the
                        // compact grid/list view has no room for that nuance, so it's excluded
                        // outright rather than looking like a real extra flight that day.
                        if (s.cancelled) return false;
                        const depLocal = flightLocalDate(s.departureTime, s.departureAirport);
                        if (depLocal === dateKey) return true;
                        if (!s.arrivalTime) return false;
                        const arrLocal = flightLocalDate(s.arrivalTime, s.arrivalAirport);
                        if (s.type === 'reserve') {
                            // A multi-day reserve ("Long Call") block must show on EVERY day it
                            // spans, not just its start/end -- confirmed live against a real
                            // Delta MiCrew feed: a genuine 4-calendar-day LC block (Nov 2 00:00 ->
                            // Nov 5 05:59) only ever appeared on the 2nd and 5th, leaving the days
                            // in between looking like ordinary off days despite being on call the
                            // whole stretch. depLocal/arrLocal/dateKey are all plain 'YYYY-MM-DD'
                            // strings, which compare correctly as plain strings (zero-padded ISO).
                            return dateKey >= depLocal && dateKey <= arrLocal;
                        }
                        // Flights that span midnight also appear on the END day's cell, not just
                        // the start day's -- see the matching redEye marker on the flight-item
                        // block below for why that needs flagging. Scoped to exactly one extra day
                        // (unlike reserve above) since a real flight leg never spans more than that.
                        return s.type === 'flight' && arrLocal === dateKey && arrLocal !== depLocal;
                    });
                    const isHard = dayEvents.some(e => e.type === 'hard');
                    const isSoft = dayEvents.some(e => e.type === 'soft');
                    const isVacation = dayEvents.some(e => e.type === 'vacation');
                    const isTraining = dayEvents.some(e => e.type === 'training');
                    const isPersonalFlight = dayEvents.some(e => e.type === 'flight' && e.trip === 'PERSONAL');
                    const personallyAwayApt = isPersonalFlight ? null : isPersonallyAway(dateKey);
                    const _rawPersonalApt = isPersonalFlight
                        ? (dayEvents.filter(e => e.type === 'flight' && e.trip === 'PERSONAL').slice(-1)[0] || {}).arrivalAirport || null
                        : null;
                    const personalFlightApt = (_rawPersonalApt && !isHomeOrBase(normApt(_rawPersonalApt), currentPilot)) ? _rawPersonalApt : null;
                    const awayApt = personalFlightApt || personallyAwayApt;
                    const isFlying = dayEvents.some(e => (e.type === 'flight' || e.type === 'ground') && e.trip !== 'PERSONAL');
                    const isReserve = dayEvents.some(e => e.type === 'reserve');
                    let away = dayEvents.find(e => e.type === 'away');
                    if (away && isHomeOrBase(away.arrivalAirport, currentPilot)) away = null;

                    const allPilotsCached = PILOT_KEYS.every(k => pilotsCache[k] && typeof pilotsCache[k] === 'object');
                    const isAllCrewOff = false; /* reserved — highlight lives in overlap view common days off
                    allPilotsCached && !isHard && !isFlying && !away && PILOT_KEYS.every(k => {
                        if (k === currentPilot) return true;
                        return !(pilotsCache[k].segments || []).some(s => {
                            if (s.type !== 'flight') return false;
                            const dep = s.departure_time, depApt = s.departure_airport;
                            if (!dep) return false;
                            if (flightLocalDate(dep, depApt) === dateKey) return true;
                            const arr = s.arrival_time, arrApt = s.arrival_airport;
                            if (!arr) return false;
                            const arrLocal = flightLocalDate(arr, arrApt);
                            return arrLocal === dateKey && arrLocal !== flightLocalDate(dep, depApt);
                        });
                    }); */

                    const _onDuty = _pilotOnDutyDefault(currentPilot, dateKey);
                    const _onDutyLabel = _onDuty ? _onDutyDefaultLabel(currentPilot) : null;
                    // NetJets' "ON TOUR" default gets its own indigo tint (distinct from Reserve's
                    // amber -- it's an inferred status from the rotation, not a real logged
                    // segment) -- Kyle's bare "ON CALL" default stays the plain, unstyled gray it
                    // always was.
                    let style = (_onDutyLabel === 'ON TOUR') ? "border-indigo-400/30 bg-indigo-400/5" : "border-zinc-800 bg-zinc-900/20";
                    let tag = _onDutyLabel || "OFF";
                    if (isVacation) { style = "border-teal-500/50 bg-teal-900/30 text-teal-100"; tag = awayApt ? `VAC · AWAY - ${aptLabel(awayApt, currentPilot)}` : "VAC"; }
                    else if (isHard) { style = "border-red-600 bg-red-700/80 text-white"; tag = awayApt ? `HARD OFF · AWAY - ${aptLabel(awayApt, currentPilot)}` : "HARD OFF"; }
                    else if (isTraining && !isFlying) { style = "border-orange-500/40 bg-orange-900/25"; tag = "TRAINING"; }
                    else if (isFlying) { style = "border-blue-500/30 bg-blue-500/10"; tag = "FLYING"; }
                    else if (isSoft) { style = "border-rose-400/40 bg-rose-900/20"; tag = awayApt ? `SOFT DAY · AWAY - ${aptLabel(awayApt, currentPilot)}` : "SOFT DAY"; }
                    else if (isReserve) { style = "border-amber-400/30 bg-amber-400/5"; tag = "ON CALL"; }
                    else if (isPersonalFlight) { /* personal travel day — flight pill shows below; don't mark as AWAY */ }
                    else if (awayApt) { style = "border-yellow-500/40 bg-yellow-900/20"; tag = `AWAY - ${aptLabel(awayApt, currentPilot)}`; }
                    else if (away) { style = "border-yellow-500 bg-yellow-500/80 text-black"; tag = `AWAY - ${aptLabel(away.arrivalAirport, currentPilot)}`; }
                    else if (isAllCrewOff) { style = "border-amber-400/60 bg-amber-950/30"; tag = "✦ ALL OFF"; }
                    if (tag === 'FLYING' || tag === 'TRAINING') monthFlown++;
                    else if (tag === 'ON CALL' || tag === 'ON TOUR') monthOnCall++;
                    else monthOff++;
                    const glowStyle = isAllCrewOff ? 'box-shadow:0 0 0 1px rgba(251,191,36,0.45),0 0 18px rgba(251,191,36,0.18);' : '';
                    // Cell: fixed height with scrollable inner flight list
                    let html = `<div class="border rounded-xl flex flex-col ${style} ${dayClasses.join(' ')}" style="height:170px;${glowStyle}" onclick="showDayDetail('${dateKey}')">`;
                    // Header row: day number, block totals (when on), status tag
                    const dayNumColor = isAllCrewOff ? 'color:#fbbf24;' : '';
                    let blockTop = '';
                    if (blockByDay) {
                        const bt = _blockTotalsFor(blockByDay, dateKey, tourEnds);
                        const lines = [];
                        if (bt.day > 0) lines.push(formatDurationMinutes(bt.day));
                        if (bt.tourEnd === dateKey && bt.tour > 0) lines.push(`T ${formatDurationMinutes(bt.tour)}`);
                        if (lines.length) blockTop = `<span class="block-total hidden md:block flex-1 text-center text-[9px] font-black text-sky-400 leading-tight whitespace-nowrap">${lines.map(l => `<div>${l}</div>`).join('')}</span>`;
                    }
                    html += `<div class="flex items-start justify-between px-2.5 pt-2 pb-1 shrink-0"><span class="text-base font-black font-mono leading-none day-number" style="${dayNumColor}">${d}</span>${blockTop}<span class="text-[7px] font-black px-1.5 py-[2px] rounded-full border border-current leading-none opacity-90">${tag}</span></div>`;
                    // Scrollable flight list
                    html += `<div class="overflow-y-auto flex-1 px-1.5 pb-1.5 space-y-1">`;
                    const cellFlights = dayEvents.filter(e => e.type === 'flight' || e.type === 'ground')
                        .sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));
                    cellFlights.forEach(f => {
                        if (f.type === 'ground') {
                            const gDepFmt = f.departureTime ? formatTimeISO(f.departureTime, f.departureAirport) : '';
                            const gCode   = f.flightNumber || '';
                            const gNext = (f.arrivalAirport && f.arrivalTime) ? getNextLegFrom(f.arrivalAirport, f.arrivalTime) : null;
                            let gOvr = '';
                            if (gNext) {
                                const gm = (new Date(gNext.departureTime) - new Date(f.arrivalTime)) / 60000;
                                const atHome = isHomeOrBaseAt(f.arrivalAirport, currentPilot, f.arrivalTime);
                                const sameDay = flightLocalDate(f.arrivalTime, f.arrivalAirport) === flightLocalDate(gNext.departureTime, f.arrivalAirport);
                                gOvr = layoverLabel(gm, atHome, sameDay);
                            }
                            html += `<div class="rounded-lg px-2 py-[4px] ground-item" data-dep-apt="${f.departureAirport||''}" data-arr-apt="${f.arrivalAirport||''}" data-dep-time="${f.departureTime||''}" data-arr-time="${f.arrivalTime||''}" data-flight="${gCode}" style="font-size:9px;font-weight:700;color:#52525b;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06)">
                                <div>GND ${aptLabel(f.departureAirport, currentPilot)}→${aptLabel(f.arrivalAirport, currentPilot)}</div>
                                <div style="font-weight:500;font-size:8.5px;margin-top:1px">${gDepFmt}${gCode ? ` · ${gCode}` : ''}</div>
                                ${gOvr ? `<div style="color:#fcd34d;font-size:8.5px;font-weight:700;margin-top:2px">${gOvr}</div>` : ''}
                            </div>`;
                            return;
                        }
                        const depAttr = f.departureTime || '';
                        const arrAttr = f.arrivalTime || '';
                        const tailAttr = displayTail(f.tail, currentPilot) || '';
                        const tripAttr = f.trip || '';
                        const flightNumAttr = f.flightNumber || '';
                        const depApt = f.departureAirport || '';
                        const arrApt = f.arrivalAirport || '';
                        const isPersonal = tripAttr === 'PERSONAL';
                        const isCommute = tripAttr === 'COMMUTE';
                        const dhDot = f.dh ? `<span style="color:#f9a8d4;font-size:8px;font-weight:900;margin-left:3px">DH</span>` : '';
                        const personalDot = isPersonal ? `<span style="color:#c084fc;font-size:8px;font-weight:900;margin-left:3px">P</span>` : '';
                        const commuteDot = isCommute ? `<span style="color:#fbbf24;font-size:8px;font-weight:900;margin-left:3px">C</span>` : '';
                        // Flights crossing midnight (red-eyes, or any leg landing just past 12am) already
                        // appear on both the departure day's cell and the arrival day's cell -- see
                        // dayEvents' filter above, which matches on local arrival date too, not just
                        // departure. Without a marker though the two entries look unrelated instead of
                        // one continuous flight split across two cells, so flag each side of it.
                        const _depLocalDate = depAttr ? flightLocalDate(depAttr, depApt) : '';
                        const _arrLocalDate = arrAttr ? flightLocalDate(arrAttr, arrApt) : '';
                        const crossesMidnight = _depLocalDate && _arrLocalDate && _depLocalDate !== _arrLocalDate;
                        const _isArrivalSide = crossesMidnight && dateKey === _arrLocalDate;
                        // No native title= here -- .flight-item already has its own custom hover
                        // tooltip (attachTooltips()'s onEnter below), and a native tooltip stacked
                        // on top of that one just collided with it. data-redeye instead lets that
                        // existing tooltip fold the explanation into its own content.
                        const redEyeDot = crossesMidnight
                            ? `<span style="font-size:9px;font-weight:900;margin-left:3px">🌙</span>`
                            : '';
                        const redEyeAttr = crossesMidnight ? ` data-redeye="${_isArrivalSide ? 'arr' : 'dep'}"` : '';
                        const depTimeFmt = depAttr ? formatTimeISO(depAttr, depApt) : '';
                        const arrTimeFmt = arrAttr ? formatTimeISO(arrAttr, arrApt) : '';
                        const depTzLbl = depApt ? tzAbbr(depApt, depAttr) : '';
                        const arrTzLbl = arrApt ? tzAbbr(arrApt, arrAttr) : '';
                        const tzSpan = (lbl) => lbl ? `<span style="font-size:7.5px;color:#52525b;font-weight:700;margin-left:1px">${lbl}</span>` : '';
                        let groundLine = '';
                        if (!isPersonal && arrApt && arrAttr) {
                            const nextLeg = getNextLegFrom(arrApt, arrAttr);
                            if (nextLeg) {
                                const groundMins = (new Date(nextLeg.departureTime) - new Date(arrAttr)) / 60000;
                                const atHome = isHomeOrBaseAt(arrApt, currentPilot, arrAttr);
                                const sameDay = flightLocalDate(arrAttr, arrApt) === flightLocalDate(nextLeg.departureTime, arrApt);
                                const lbl = layoverLabel(groundMins, atHome, sameDay);
                                if (lbl) groundLine = `<div style="color:#fcd34d;font-size:10px;font-weight:700;margin-top:2px">${lbl}</div>`;
                            }
                        }
                        const nowMs = Date.now();
                        const depMs = depAttr ? flightUTCTime(depAttr, depApt)?.getTime() : null;
                        const arrMs = arrAttr ? flightUTCTime(arrAttr, arrApt)?.getTime() : null;
                        const csig = deriveCallsign({ flightNumber: flightNumAttr, tail: tailAttr }, currentPilot) || '';
                        const isActiveLeg = isFlightStillActive(depMs, arrMs, nowMs, csig, depApt) && !_isLandedEarly(csig, arrMs);
                        // A leg that's done -- either landed early, or its scheduled arrival has
                        // passed and it's no longer flagged active (past the full grace window, or
                        // server-confirmed parked). Deliberately excludes a leg that just hasn't
                        // departed yet (nowMs < arrMs and not landed early) -- only an actually
                        // finished leg gets the checkmark below. Scoped to TODAY's legs only --
                        // every past day already reads as "done" by definition (it's in the past),
                        // so marking every single one would just be noise; the checkmark is useful
                        // specifically for telling today's completed legs apart from today's
                        // upcoming ones.
                        const isCompletedLeg = !isActiveLeg && !!arrMs && (nowMs >= arrMs || _isLandedEarly(csig, arrMs)) && dateKey === _localToday();
                        // Confirmed by the poller (see startCalListLivePolling()'s own comment):
                        // scheduled departure has passed, nothing has been found airborne/on the
                        // ground at all yet. Don't show the green "active/in the air" glow for a
                        // flight nothing has actually confirmed left the gate -- two sub-cases, same
                        // split and wording/colors as the day map's own _legState: a real TFMS ETD
                        // showing it running late ('delayed', #f97316), or just "nothing confirms
                        // it's left, no particular delay known either" ('due', #eab308 -- the map's
                        // own actual default once nothing else applies). isActiveLeg itself stays
                        // true regardless of either (keeps the live-status div + polling attached so
                        // it can flip back to a real green glow the moment it's actually found).
                        // The glow itself now requires _confirmedLive, not just isActiveLeg --
                        // see that Set's own header comment for why (the green-then-orange flash
                        // this used to produce the instant scheduled departure passed, confirmed
                        // live on Brett's SCX3091). A brand new leg starts neutral, same look as a
                        // not-yet-departed one, until one of the three poller-confirmed states below
                        // resolves it -- normally within one poll cycle.
                        const confirmedLive = isActiveLeg && _confirmedLive.has(_delayedKey(csig, depMs));
                        const confirmedDelayEtd = isActiveLeg && !confirmedLive ? _getConfirmedDelayEtd(csig, depMs) : null;
                        const confirmedDue = isActiveLeg && !confirmedLive && !confirmedDelayEtd && _confirmedDue.has(_delayedKey(csig, depMs));
                        const showActiveGlow = confirmedLive;
                        const _notConfirmedColor = confirmedDelayEtd ? '249,115,22' : '234,179,8'; // orange (delayed) vs amber (due)
                        const cellBg = showActiveGlow
                            ? (isPersonal ? `background:rgba(109,40,217,0.15);border:2px solid rgba(34,197,94,0.85)` : isCommute ? `background:rgba(120,53,15,0.2);border:2px solid rgba(34,197,94,0.85)` : `background:rgba(0,0,0,0.4);border:2px solid rgba(34,197,94,0.85)`)
                            : (confirmedDelayEtd || confirmedDue)
                            ? (isPersonal ? `background:rgba(109,40,217,0.15);border:2px solid rgba(${_notConfirmedColor},0.85)` : isCommute ? `background:rgba(120,53,15,0.2);border:2px solid rgba(${_notConfirmedColor},0.85)` : `background:rgba(0,0,0,0.4);border:2px solid rgba(${_notConfirmedColor},0.85)`)
                            : (isPersonal ? 'background:rgba(109,40,217,0.15);border:1px solid rgba(139,92,246,0.25)' : isCommute ? 'background:rgba(120,53,15,0.2);border:1px solid rgba(245,158,11,0.25)' : 'background:rgba(0,0,0,0.4)');
                        html += `<div class="rounded-lg px-2 py-[5px] flight-item${showActiveGlow ? ' active-leg' : ''}" style="font-size:10px;${cellBg}" data-dep-time="${depAttr}" data-arr-time="${arrAttr}" data-tail="${tailAttr}" data-trip="${tripAttr}" data-flight="${flightNumAttr}" data-dep-apt="${depApt}" data-arr-apt="${arrApt}" data-dh="${f.dh ? 'true' : 'false'}" data-block="${calcBlockMins(f) ?? ''}"${redEyeAttr}${isActiveLeg && csig ? ` data-live-callsign="${csig}"` : ''}>`;
                        const cellFlightLabel = deriveCallsign({ flightNumber: flightNumAttr, tail: tailAttr }, currentPilot) || '';
                        const flLabelSpan = cellFlightLabel ? flightAwareLink(cellFlightLabel, `<span style="font-size:9px;font-weight:700;color:#7dd3fc;margin-left:3px">${cellFlightLabel}</span>`, flightAwareEligible(depMs)) : '';
                        const completedCheck = isCompletedLeg ? `<span style="font-size:10px;font-weight:900;color:#4ade80;margin-left:2px" title="Completed">✓</span>` : '';
                        html += `<div style="font-weight:800;font-size:11px;display:flex;align-items:center;gap:3px">${aptLabel(depApt, currentPilot)} → ${aptLabel(arrApt, currentPilot)}${dhDot}${personalDot}${commuteDot}${redEyeDot}${flLabelSpan}${completedCheck}</div>`;
                        html += `<div style="color:#94a3b8;font-size:10px;margin-top:1px">${depTimeFmt}${tzSpan(depTzLbl)} → ${arrTimeFmt}${tzSpan(arrTzLbl)}</div>`;
                        html += groundLine;
                        // Placed right after groundLine (the overnight/layover line) so it reads as
                        // "where it's headed next, then its current status" -- baked in directly
                        // when already known at render time, same wording/color as the map's
                        // 'delayed'/'due' states; startCalListLivePolling()'s poll() keeps it fresh
                        // afterward (an ETD can itself shift, or this can resolve to found/parked).
                        // "leg-delay-line" (not groundLine's class, which has none) is the mobile
                        // grid CSS override's one exception to hiding every .flight-item child but
                        // the first -- confirmed live this needs to be its OWN class, not shared
                        // with groundLine's: an earlier version reused one shared class for both,
                        // which meant exempting this line from the mobile hide rule also exempted
                        // the overnight/turn-time line, cluttering the mobile grid and making legs
                        // harder to scroll through/read -- the exact thing that CSS rule exists to
                        // prevent for every other non-first child.
                        if (isActiveLeg && csig) {
                            const _noteText = confirmedDelayEtd ? `DELAYED · ETD ${formatTimeISO(confirmedDelayEtd, depApt)}` : (confirmedDue ? 'DEPARTURE DUE' : '');
                            html += `<div class="leg-delay-line" id="delay-${csig}" style="font-size:9px;font-weight:800;color:#${confirmedDelayEtd ? 'f97316' : 'eab308'};margin-top:2px">${_noteText}</div>`;
                        }
                        if (isActiveLeg && csig) html += `<div id="live-${csig}" style="font-size:9px;color:#4ade80;font-weight:700;margin-top:2px;display:none"></div>`;
                        html += `</div>`;
                    });
                    // Reserve slots — hide if pilot has work flights (reserve was converted to a trip)
                    dayEvents.filter(e => e.type === 'reserve' && !isFlying).forEach(r => {
                        const subType = r.flightNumber || 'RES';
                        const depFmt = r.departureTime ? formatTimeISO(r.departureTime, r.departureAirport) : '';
                        const arrFmt = r.arrivalTime  ? formatTimeISO(r.arrivalTime,  r.arrivalAirport)  : '';
                        const depTz  = r.departureAirport ? tzAbbr(r.departureAirport, r.departureTime) : '';
                        const arrTz  = r.arrivalAirport   ? tzAbbr(r.arrivalAirport,  r.arrivalTime)   : '';
                        const tzS = (lbl) => lbl ? `<span style="font-size:7.5px;color:#78716c;font-weight:700;margin-left:1px">${lbl}</span>` : '';
                        // Same cross-midnight marker as .flight-item above -- a reserve shift
                        // starting late and ending after midnight already appears on both the
                        // start day's cell and the end day's cell (see dayEvents' filter), so flag
                        // each side the same way a red-eye flight does.
                        const _resDepLocal = r.departureTime ? flightLocalDate(r.departureTime, r.departureAirport) : '';
                        const _resArrLocal = r.arrivalTime ? flightLocalDate(r.arrivalTime, r.arrivalAirport) : '';
                        const resCrossesMidnight = _resDepLocal && _resArrLocal && _resDepLocal !== _resArrLocal;
                        const resRedEyeDot = resCrossesMidnight
                            ? `<span style="font-size:9px;font-weight:900;margin-left:3px">🌙</span>`
                            : '';
                        // A multi-day block (now shown on every day it spans, not just start/end
                        // -- see dayEvents' own comment above) needs a third case for a day that's
                        // neither: the binary arr/dep choice used to default a middle day to 'dep'
                        // ("continues into the next day"), which is true but misses that it also
                        // already started -- 'mid' says both.
                        const resRedEyeAttr = resCrossesMidnight ? ` data-redeye="${dateKey === _resArrLocal ? 'arr' : dateKey === _resDepLocal ? 'dep' : 'mid'}"` : '';
                        // Requested directly after a real multi-day "Long Call" block (Nov 2 00:00
                        // -> Nov 5 05:59, one continuous ~78hr period, confirmed against the raw
                        // feed) was mistaken for a recurring 12am-6am window each night -- every day
                        // showed the SAME start/end clock times with no indication it was one span,
                        // not several separate overnight reserves. A persistent date-range badge
                        // next to the label makes the span itself unmistakable on every day it
                        // covers, and the time line below says the right thing for THIS specific
                        // day (starting/ongoing/ending) instead of always repeating the overall
                        // start and end times, which is actively misleading on a middle day.
                        const _fmtShortDate = (ymd) => { const [y, mo, dd] = ymd.split('-').map(Number); return new Date(y, mo - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
                        const resSpanBadge = resCrossesMidnight ? `<span style="font-size:8px;font-weight:700;color:#92400e;margin-left:4px">${_fmtShortDate(_resDepLocal)}–${_fmtShortDate(_resArrLocal)}</span>` : '';
                        let resTimeLine = '';
                        if (!resCrossesMidnight) {
                            if (depFmt) resTimeLine = `${depFmt}${tzS(depTz)} – ${arrFmt}${tzS(arrTz)}`;
                        } else if (dateKey === _resDepLocal) {
                            resTimeLine = `Starts ${depFmt}${tzS(depTz)} — ongoing`;
                        } else if (dateKey === _resArrLocal) {
                            resTimeLine = `Ends ${arrFmt}${tzS(arrTz)}`;
                        } else {
                            resTimeLine = `On call all day`;
                        }
                        html += `<div class="rounded-lg px-2 py-[5px] reserve-item" style="font-size:10px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2)" data-dep-time="${r.departureTime||''}" data-arr-time="${r.arrivalTime||''}" data-dep-apt="${r.departureAirport||''}" data-arr-apt="${r.arrivalAirport||''}" data-res-type="${subType}"${resRedEyeAttr}>`;
                        html += `<div style="font-weight:800;font-size:11px;color:#fbbf24">ON CALL <span style="font-size:9px;font-weight:600;color:#d97706">${subType}</span>${resRedEyeDot}${resSpanBadge}</div>`;
                        if (resTimeLine) html += `<div style="color:#b45309;font-size:10px;margin-top:1px">${resTimeLine}</div>`;
                        html += `</div>`;
                    });
                    html += `</div></div>`;
                    gridHtml += html;
                }
                gridContainer.innerHTML = gridHtml;
                const flownEl = document.getElementById('grid-total-flown');
                if (flownEl) {
                    flownEl.textContent = monthFlown;
                    document.getElementById('grid-total-off').textContent = monthOff;
                    document.getElementById('grid-total-oncall').textContent = monthOnCall;
                }
            } else if (currentView === 'list') {
                const daysInMonth = new Date(year, month + 1, 0).getDate();
                let listHtml = '';
                for (let d = 1; d <= daysInMonth; d++) {
                    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const dayEvents = segments.filter(s => {
                        if (!s.departureTime) return false;
                        // A NetJets leg NetJets itself says isn't happening (auto_leg_cancelled) --
                        // Day Detail shows it struck-through with context when tapped into, but the
                        // compact grid/list view has no room for that nuance, so it's excluded
                        // outright rather than looking like a real extra flight that day.
                        if (s.cancelled) return false;
                        const depLocal = flightLocalDate(s.departureTime, s.departureAirport);
                        if (depLocal === dateKey) return true;
                        if (!s.arrivalTime) return false;
                        const arrLocal = flightLocalDate(s.arrivalTime, s.arrivalAirport);
                        // Same multi-day reserve span fix as the grid's own dayEvents filter --
                        // see its comment. Every day a "Long Call" block covers needs its own
                        // listing here too, not just the start day.
                        if (s.type === 'reserve') return dateKey >= depLocal && dateKey <= arrLocal;
                        return s.type === 'flight' && arrLocal === dateKey && arrLocal !== depLocal;
                    });
                    const dateObj = new Date(year, month, d);
                    const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                    const today = new Date();
                    today.setHours(0,0,0,0);
                    const isPastDay = dateObj < today;
                    const isToday = dateObj.getTime() === today.getTime();
                    const isHard = dayEvents.some(e => e.type === 'hard');
                    const isSoft = dayEvents.some(e => e.type === 'soft');
                    const isVacation = dayEvents.some(e => e.type === 'vacation');
                    const isTraining = dayEvents.some(e => e.type === 'training');
                    let away = dayEvents.find(e => e.type === 'away');
                    if (away && isHomeOrBase(away.arrivalAirport, currentPilot)) away = null;
                    const flights = dayEvents.filter(e => e.type === 'flight');
                    const workFlights = flights.filter(f => f.trip !== 'PERSONAL');
                    const isPersonalFlight = flights.some(f => f.trip === 'PERSONAL');
                    const _listPersonallyAwayApt = isPersonalFlight ? null : isPersonallyAway(dateKey);
                    const _listRawPersonalApt = isPersonalFlight
                        ? (flights.filter(f => f.trip === 'PERSONAL').slice(-1)[0] || {}).arrivalAirport || null
                        : null;
                    const _listPersonalFlightApt = (_listRawPersonalApt && !isHomeOrBase(normApt(_listRawPersonalApt), currentPilot)) ? _listRawPersonalApt : null;
                    const awayApt = _listPersonalFlightApt || _listPersonallyAwayApt;
                    const reserves = dayEvents.filter(e => e.type === 'reserve');
                    const groundLegs = dayEvents.filter(e => e.type === 'ground').sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));
                    const _listNow = Date.now();
                    const _listAnyLive = flights.some(f => {
                        const cs = deriveCallsign(f, currentPilot) || '';
                        const dMs = f.departureTime ? flightUTCTime(f.departureTime, f.departureAirport)?.getTime() : null;
                        const rawAMs = f.arrivalTime ? flightUTCTime(f.arrivalTime, f.arrivalAirport)?.getTime() : null;
                        return dMs && rawAMs && dMs <= _listNow && _listNow <= rawAMs && !_isLandedEarly(cs, rawAMs);
                    });
                    const _listOnDutyLabel = _pilotOnDutyDefault(currentPilot, dateKey) ? _onDutyDefaultLabel(currentPilot) : null;
                    let bgColor, labelColor, sidebarColor, sidebarBorder, label = _listOnDutyLabel || "OFF";
                    if (isVacation) {
                        bgColor = "bg-teal-950/40 border-teal-500/40"; labelColor = "text-teal-300"; sidebarColor = "text-teal-300"; sidebarBorder = "border-teal-700/50"; label = awayApt ? `VAC · AWAY - ${aptLabel(awayApt, currentPilot)}` : "VAC";
                    } else if (isHard) {
                        bgColor = "bg-red-900/60 border-red-600/70"; labelColor = "text-red-300"; sidebarColor = "text-red-300"; sidebarBorder = "border-red-700/60"; label = awayApt ? `HARD OFF · AWAY - ${aptLabel(awayApt, currentPilot)}` : "HARD OFF";
                    } else if (isSoft && workFlights.length === 0) {
                        bgColor = "bg-rose-950/30 border-rose-500/40"; labelColor = "text-rose-300"; sidebarColor = "text-rose-300"; sidebarBorder = "border-rose-700/50"; label = awayApt ? `SOFT DAY · AWAY - ${aptLabel(awayApt, currentPilot)}` : "SOFT DAY";
                    } else if (isTraining && workFlights.length === 0) {
                        bgColor = "bg-orange-950/35 border-orange-600/50"; labelColor = "text-orange-300"; sidebarColor = "text-orange-300"; sidebarBorder = "border-orange-700/50"; label = "TRAINING";
                    } else if (reserves.length > 0 && workFlights.length === 0 && !awayApt) {
                        bgColor = "bg-amber-950/30 border-amber-500/30"; labelColor = "text-amber-400"; sidebarColor = "text-amber-400"; sidebarBorder = "border-amber-700/40"; label = "ON CALL";
                    } else if (_listAnyLive) {
                        bgColor = "bg-emerald-950/40 border-emerald-600/60"; labelColor = "text-emerald-300"; sidebarColor = "text-emerald-300"; sidebarBorder = "border-emerald-700/60"; label = "▶ IN THE AIR";
                    } else if (workFlights.length > 0) {
                        bgColor = "bg-blue-900/40 border-blue-500/60"; labelColor = "text-blue-300"; sidebarColor = "text-blue-200"; sidebarBorder = "border-blue-700/60"; label = "FLYING";
                    } else if (isPersonalFlight) {
                        bgColor = "bg-zinc-900/20 border-zinc-700/50"; labelColor = "text-zinc-500"; sidebarColor = "text-zinc-400"; sidebarBorder = "border-zinc-700/50"; label = "PERSONAL";
                    } else if (away) {
                        bgColor = "bg-amber-900/50 border-amber-500/60"; labelColor = "text-amber-300"; sidebarColor = "text-amber-300"; sidebarBorder = "border-amber-700/60"; label = `AWAY — ${aptLabel(away.arrivalAirport, currentPilot)}`;
                    } else if (awayApt) {
                        bgColor = "bg-yellow-900/20 border-yellow-600/40"; labelColor = "text-yellow-400"; sidebarColor = "text-yellow-400"; sidebarBorder = "border-yellow-700/40"; label = `AWAY - ${aptLabel(awayApt, currentPilot)}`;
                    } else if (_listOnDutyLabel === 'ON TOUR') {
                        bgColor = "bg-indigo-950/30 border-indigo-500/30"; labelColor = "text-indigo-300"; sidebarColor = "text-indigo-300"; sidebarBorder = "border-indigo-700/40";
                    } else {
                        bgColor = "bg-zinc-900/20 border-zinc-700/50"; labelColor = "text-zinc-500"; sidebarColor = "text-zinc-400"; sidebarBorder = "border-zinc-700/50";
                    }
                    let contentHtml = `<div class="text-xs font-black uppercase tracking-widest ${labelColor}">${label}</div>`;
                    if (reserves.length > 0 && flights.length === 0) {
                        contentHtml = reserves.map(r => {
                            const subType = r.flightNumber || 'RES';
                            const depFmt = r.departureTime ? formatTimeISO(r.departureTime, r.departureAirport) : '';
                            const arrFmt = r.arrivalTime  ? formatTimeISO(r.arrivalTime,  r.arrivalAirport)  : '';
                            const depTz = r.departureAirport ? tzAbbr(r.departureAirport, r.departureTime) : '';
                            const arrTz = r.arrivalAirport  ? tzAbbr(r.arrivalAirport,  r.arrivalTime)  : '';
                            const tzSup2 = (lbl) => lbl ? `<span style="font-size:9px;color:#52525b;font-weight:700;margin-left:2px">${lbl}</span>` : '';
                            // Same multi-day clarity fix as the grid's reserve-item -- see its own
                            // comment. Without this every day of a real multi-day "Long Call" block
                            // showed the identical overall start/end clock times, reading like a
                            // recurring nightly window instead of one continuous span.
                            const _resDepLocal2 = r.departureTime ? flightLocalDate(r.departureTime, r.departureAirport) : '';
                            const _resArrLocal2 = r.arrivalTime ? flightLocalDate(r.arrivalTime, r.arrivalAirport) : '';
                            const resSpans2 = _resDepLocal2 && _resArrLocal2 && _resDepLocal2 !== _resArrLocal2;
                            const _fmtShortDate2 = (ymd) => { const [y, mo, dd] = ymd.split('-').map(Number); return new Date(y, mo - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
                            const spanBadge2 = resSpans2 ? `<span class="text-amber-600 text-[10px] font-semibold ml-1.5">${_fmtShortDate2(_resDepLocal2)}–${_fmtShortDate2(_resArrLocal2)}</span>` : '';
                            let resTimeText2;
                            if (!resSpans2) resTimeText2 = `${depFmt}${tzSup2(depTz)} – ${arrFmt}${tzSup2(arrTz)}`;
                            else if (dateKey === _resDepLocal2) resTimeText2 = `Starts ${depFmt}${tzSup2(depTz)} — ongoing`;
                            else if (dateKey === _resArrLocal2) resTimeText2 = `Ends ${arrFmt}${tzSup2(arrTz)}`;
                            else resTimeText2 = `On call all day`;
                            return `<div class="border border-amber-500/25 rounded-2xl px-4 py-3 bg-amber-950/20 text-sm text-amber-200"><div class="flex items-center justify-between"><div class="font-black text-amber-300 uppercase tracking-wide">On Call <span class="text-amber-600 text-xs font-semibold ml-1">${subType}</span>${spanBadge2}</div><div class="text-right text-xs text-amber-400/70">${resTimeText2}</div></div></div>`;
                        }).join('');
                    }
                    const allLegs = [...flights, ...groundLegs].sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));
                    if (allLegs.length > 0) {
                        contentHtml = allLegs.map(leg => {
                            if (leg.type === 'ground') {
                                const g = leg;
                                const nextFromGrnd = (g.arrivalAirport && g.arrivalTime) ? getNextLegFrom(g.arrivalAirport, g.arrivalTime) : null;
                                let grndLayover = '';
                                if (nextFromGrnd) {
                                    const gm = (new Date(nextFromGrnd.departureTime) - new Date(g.arrivalTime)) / 60000;
                                    const atHome = isHomeOrBaseAt(g.arrivalAirport, currentPilot, g.arrivalTime);
                                    const sameDay = flightLocalDate(g.arrivalTime, g.arrivalAirport) === flightLocalDate(nextFromGrnd.departureTime, g.arrivalAirport);
                                    const lbl = layoverLabel(gm, atHome, sameDay);
                                    if (lbl) grndLayover = `<span class="text-amber-400 font-semibold ml-2 text-[10px]">${lbl}</span>`;
                                }
                                const gDepFmt2 = g.departureTime ? formatTimeISO(g.departureTime, g.departureAirport) : '';
                                const gArrFmt2 = g.arrivalTime   ? formatTimeISO(g.arrivalTime,   g.arrivalAirport)  : '';
                                const gDepTz2  = g.departureAirport && g.departureTime ? tzAbbr(g.departureAirport, g.departureTime) : '';
                                const gArrTz2  = g.arrivalAirport  && g.arrivalTime   ? tzAbbr(g.arrivalAirport,  g.arrivalTime)   : '';
                                const gTzSpan2 = (lbl) => lbl ? `<span class="text-[8px] text-zinc-600 font-bold ml-0.5">${lbl}</span>` : '';
                                const gEditBtns = (g.id && canEdit()) ? `<div class="flex items-center gap-1 ml-1 shrink-0"><button onclick="openEditGround(${g.id})" title="Edit" class="w-6 h-6 flex items-center justify-center rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors text-xs">✏️</button><button onclick="deleteManualFlight(${g.id})" title="Delete" class="w-6 h-6 flex items-center justify-center rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors text-xs">🗑️</button></div>` : '';
                                return `<div class="px-3 py-2 rounded-lg border border-zinc-700/25 bg-zinc-800/20 ground-item" data-dep-apt="${g.departureAirport||''}" data-arr-apt="${g.arrivalAirport||''}" data-dep-time="${g.departureTime||''}" data-arr-time="${g.arrivalTime||''}" data-flight="${g.flightNumber||''}">
                                    <div class="flex items-center gap-2">
                                        <span class="text-[9px] font-black uppercase tracking-widest text-zinc-500 shrink-0">Ground</span>
                                        <span class="text-xs font-semibold text-zinc-400">${aptLabel(g.departureAirport, currentPilot)} <span class="text-zinc-600">→</span> ${aptLabel(g.arrivalAirport, currentPilot)}</span>
                                        <span class="text-[9px] text-zinc-600 ml-auto">${g.flightNumber || ''}</span>
                                        ${gEditBtns}
                                    </div>
                                    <div class="flex items-center justify-between mt-0.5">
                                        <span class="text-[10px] text-zinc-500">${gDepFmt2}${gTzSpan2(gDepTz2)} <span class="text-zinc-700">→</span> ${gArrFmt2}${gTzSpan2(gArrTz2)}</span>
                                        ${grndLayover}
                                    </div>
                                </div>`;
                            } else {
                                const f = leg;
                                const depAttr = f.departureTime || '';
                                const arrAttr = f.arrivalTime || '';
                                const tailAttr = displayTail(f.tail, currentPilot) || '';
                                const tripAttr = f.trip || '';
                                const depApt = f.departureAirport || '';
                                const arrApt = f.arrivalAirport || '';
                                const depTime = formatTimeISO(depAttr, depApt);
                                const arrTime = formatTimeISO(arrAttr, arrApt);
                                const depTz = depApt ? tzAbbr(depApt, depAttr) : '';
                                const arrTz = arrApt ? tzAbbr(arrApt, arrAttr) : '';
                                const tzSup = (lbl) => lbl ? `<span style="font-size:9px;color:#52525b;font-weight:700;margin-left:2px">${lbl}</span>` : '';
                                const blockMins = calcBlockMins(f);
                                const isPersonal = tripAttr === 'PERSONAL';
                                const isCommute = tripAttr === 'COMMUTE';
                                const dhBadge = f.dh ? `<span class="ml-1.5 text-[10px] font-semibold text-pink-400">Deadhead</span>` : '';
                                const personalBadge = isPersonal ? `<span class="ml-1.5 text-[10px] font-semibold text-violet-400">Personal</span>` : '';
                                const commuteBadge = isCommute ? `<span class="ml-1.5 text-[10px] font-semibold text-amber-400">Commute</span>` : '';
                                const flightNumAttr = f.flightNumber || '';
                                const _flLabel = deriveCallsign({ flightNumber: flightNumAttr, tail: tailAttr }, currentPilot) || '';
                                let layoverText = '';
                                if (!isPersonal && arrApt && arrAttr) {
                                    const nextLeg = getNextLegFrom(arrApt, arrAttr);
                                    if (nextLeg) {
                                        const groundMins = (new Date(nextLeg.departureTime) - new Date(arrAttr)) / 60000;
                                        const atHome = isHomeOrBaseAt(arrApt, currentPilot, arrAttr);
                                        const sameDay = flightLocalDate(arrAttr, arrApt) === flightLocalDate(nextLeg.departureTime, arrApt);
                                        layoverText = layoverLabel(groundMins, atHome, sameDay);
                                    }
                                }
                                const nowMs2 = Date.now();
                                const depMs2 = depAttr ? flightUTCTime(depAttr, depApt)?.getTime() : null;
                                const arrMs2 = arrAttr ? flightUTCTime(arrAttr, arrApt)?.getTime() : null;
                                const csig2 = deriveCallsign({ flightNumber: flightNumAttr, tail: tailAttr }, currentPilot) || '';
                                const isActiveLeg2 = isFlightStillActive(depMs2, arrMs2, nowMs2, csig2, depApt) && !_isLandedEarly(csig2, arrMs2);
                                // Same "actually finished, not just not-yet-departed" check as the
                                // grid -- see its own comment. Scoped to today only, same reasoning.
                                const isCompletedLeg2 = !isActiveLeg2 && !!arrMs2 && (nowMs2 >= arrMs2 || _isLandedEarly(csig2, arrMs2)) && dateKey === _localToday();
                                // Same "don't glow green for a flight nothing has confirmed left the
                                // gate" check as the grid -- see its own comment.
                                const confirmedLive2 = isActiveLeg2 && _confirmedLive.has(_delayedKey(csig2, depMs2));
                                const confirmedDelayEtd2 = isActiveLeg2 && !confirmedLive2 ? _getConfirmedDelayEtd(csig2, depMs2) : null;
                                const confirmedDue2 = isActiveLeg2 && !confirmedLive2 && !confirmedDelayEtd2 && _confirmedDue.has(_delayedKey(csig2, depMs2));
                                const showActiveGlow2 = confirmedLive2;
                                const rowAccent2 = showActiveGlow2 ? '#22c55e' : confirmedDelayEtd2 ? '#f97316' : confirmedDue2 ? '#eab308' : isPersonal ? '#a78bfa' : isCommute ? '#f59e0b' : (PILOT_COLORS[currentPilot] || '#38bdf8');
                                const rowBg = isPersonal ? 'bg-violet-950/15' : isCommute ? 'bg-amber-950/15' : showActiveGlow2 ? 'bg-emerald-950/10' : (confirmedDelayEtd2 || confirmedDue2) ? 'bg-orange-950/10' : 'bg-black/30';
                                const editBtns = (f.id && canEdit()) ? `<div class="flex items-center gap-0.5 ml-1 shrink-0"><button onclick="openEditFlight(${f.id})" title="Edit" class="w-6 h-6 flex items-center justify-center rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors text-xs">✏️</button><button onclick="deleteManualFlight(${f.id})" title="Delete" class="w-6 h-6 flex items-center justify-center rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors text-xs">🗑️</button></div>` : '';
                                const _liveSlotBorder = 'rgba(34,197,94,0.15)';
                                const liveSlot = isActiveLeg2 && csig2 ? `<div id="live-${csig2}" style="font-size:11px;color:#4ade80;font-weight:700;margin-top:6px;padding-top:5px;border-top:1px solid ${_liveSlotBorder};display:none"></div>` : '';
                                // Same id convention as the grid's note -- startCalListLivePolling()'s
                                // poll() fills both views from one shared lookup, keyed by callsign.
                                // Placed under the block-time/layover line below (see its own comment),
                                // not in badgeRow -- same "note sits under the overnight line" placement
                                // as the grid. Pre-filled when already known at render time, same
                                // wording/colors as the map's 'delayed'/'due' states.
                                const delayLine2 = (isActiveLeg2 && csig2)
                                    ? `<div id="delay-${csig2}" class="text-[10px] font-bold mt-0.5" style="color:${confirmedDelayEtd2 ? '#f97316' : '#eab308'}">${confirmedDelayEtd2 ? `DELAYED · ETD ${formatTimeISO(confirmedDelayEtd2, depApt)}` : (confirmedDue2 ? 'DEPARTURE DUE' : '')}</div>`
                                    : '';
                                const badgeRow = [
                                    showActiveGlow2 ? `<span class="flex items-center gap-1 text-[10px] font-semibold text-emerald-400"><span style="width:6px;height:6px;border-radius:50%;background:#4ade80;display:inline-block;animation:pulse 1.5s infinite"></span>In the air</span>` : '',
                                    isCompletedLeg2 ? `<span class="text-[11px] font-black text-emerald-400" title="Completed">✓</span>` : '',
                                    dhBadge, personalBadge, commuteBadge
                                ].filter(Boolean).join('');
                                return `<div class="flight-row rounded-2xl overflow-hidden ${rowBg}${showActiveGlow2 ? ' active-leg' : ''}"${isActiveLeg2 && csig2 ? ` data-live-callsign="${csig2}" data-dep-time="${depAttr}" data-dep-apt="${depApt}" data-arr-time="${arrAttr}" data-arr-apt="${arrApt}"` : ''} style="border:1px solid ${rowAccent2}22">
                                    <div style="height:2px;background:linear-gradient(90deg,${rowAccent2},${rowAccent2}44,transparent)"></div>
                                    <div class="flex items-center gap-3 px-4 py-3">
                                        <div class="flex-1 min-w-0">
                                            <div class="flex items-center gap-2 flex-wrap">
                                                <span class="text-base font-bold" style="color:rgba(255,255,255,0.9)">${aptLabel(depApt, currentPilot)}</span>
                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="${rowAccent2}" style="flex-shrink:0;opacity:0.4"><path d="M21 16l-4-8-4 3.9-5-1.9-1.5 1.5 4.5 3-1 4 2-1 1 2 1.5-1-.5-2.5 3.5-.5L21 16z"/></svg>
                                                <span class="text-base font-bold" style="color:rgba(255,255,255,0.9)">${aptLabel(arrApt, currentPilot)}</span>
                                                ${badgeRow}
                                            </div>
                                            ${(_flLabel || tailAttr) ? `<div class="text-[10px] text-zinc-500 mt-0.5">${_flLabel ? flightAwareLink(_flLabel, _flLabel, flightAwareEligible(depMs2)) : tailAttr}</div>` : ''}
                                        </div>
                                        <div class="text-right shrink-0">
                                            <div class="text-sm font-bold text-zinc-200 font-mono">${depTime}${tzSup(depTz)}<span class="text-zinc-600 mx-1">→</span>${arrTime}${tzSup(arrTz)}</div>
                                            <div class="text-[10px] text-zinc-500 mt-0.5">${blockMins !== null ? formatDurationMinutes(blockMins) : ''}${layoverText ? ` · <span style="color:#fbbf24;font-weight:600">${layoverText}</span>` : ''}</div>
                                            ${delayLine2}
                                        </div>
                                        ${editBtns}
                                    </div>
                                    ${liveSlot ? `<div class="px-4 pb-1">${liveSlot}</div>` : ''}
                                </div>`;
                            }
                        }).join('');
                    }
                    const listClasses = ["flex gap-4 p-4 border rounded-2xl", bgColor];
                    if (isPastDay) listClasses.push('list-past');
                    if (isToday) listClasses.push('day-today');
                    listHtml += `<div class="${listClasses.join(' ')}"><div class="w-16 shrink-0 text-center border-r ${sidebarBorder} pr-4 flex flex-col justify-center"><div class="text-[9px] font-black uppercase ${sidebarColor} opacity-70">${dateLabel.split(' ')[0]}</div><div class="text-2xl font-black ${sidebarColor}">${d}</div><div class="text-[8px] font-bold uppercase ${labelColor} mt-1 tracking-widest">${label}</div>${_tourEditButton(dateKey, 'Edit')}</div><div class="flex-1 space-y-2 min-w-0">${contentHtml}</div></div>`;
                }
                listContainer.innerHTML = listHtml;
                const todayEl = listContainer.querySelector('.day-today');
                if (todayEl) todayEl.scrollIntoView({ block: 'start' });
            } else if (currentView === 'map') {
                renderMap();
            }
            // attach tooltips to any newly-rendered flight items
            attachTooltips();
            // start live ADS-B polling for any active flights in calendar/list
            if (currentView === 'grid' || currentView === 'list') startCalListLivePolling();
            // Grid cells scroll their own flight list independently (.overflow-y-auto per day) --
            // a live leg later in the day can load scrolled out of view behind earlier legs.
            // scrollIntoView with 'nearest' scrolls just that cell's internal list, not the page.
            // Deferred a frame: calling this synchronously right after the innerHTML assignment
            // above measured against a layout the browser hadn't actually committed yet (the cell's
            // scrollable height wasn't settled), so the scroll silently did nothing -- waiting for
            // the next paint guarantees the real, final layout before measuring where to scroll.
            if (currentView === 'grid') {
                requestAnimationFrame(() => {
                    const liveLegs = gridContainer.querySelectorAll('.flight-item.active-leg');
                    liveLegs.forEach(el => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
                    if (liveLegs.length) return;
                    // Nothing in the air: today's next leg, which can sit below the fold of a busy day.
                    const today = _localToday(), nowMs = Date.now();
                    const nextLeg = [...gridContainer.querySelectorAll('.flight-item[data-dep-time]')].find(el => {
                        if (flightLocalDate(el.dataset.depTime, el.dataset.depApt || '') !== today) return false;
                        const arrMs = el.dataset.arrTime ? flightUTCTime(el.dataset.arrTime, el.dataset.arrApt || '')?.getTime() : null;
                        return !!arrMs && arrMs > nowMs;
                    });
                    // Only the day's own list. scrollIntoView() also moves the page, and this runs on most
                    // redraws, so it would pull you back to today while you're scrolling the month.
                    const dayList = nextLeg?.closest('.overflow-y-auto');
                    if (dayList && dayList.id !== 'view-grid') {
                        const leg = nextLeg.getBoundingClientRect(), box = dayList.getBoundingClientRect();
                        if (leg.bottom > box.bottom) dayList.scrollTop += leg.bottom - box.bottom;
                        else if (leg.top < box.top) dayList.scrollTop -= box.top - leg.top;
                    }
                });
            }
        }

