        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('sidebar-hidden');
        }

        // Own schedule, or admin on any pilot's, and only on a NetJets tour day, not Kyle's "ON CALL".
        function _tourEditButton(dateKey, text) {
            if (!canEdit() || !_pilotOnDutyDefault(currentPilot, dateKey) || _onDutyDefaultLabel(currentPilot) !== 'ON TOUR') return '';
            const ts = _tourStartDateFor(currentPilot, dateKey);
            return ts ? `<button onclick="openNetjetsTourModal('${ts}')" class="text-[9px] font-black uppercase tracking-widest text-indigo-400 border border-indigo-900 rounded-full px-2.5 py-1 mt-1.5 hover:bg-indigo-950/40 transition-colors">${text}</button>` : '';
        }

        function showDayDetail(dateKey) {
            const dayEvents = segments.filter(s => s.departureTime && !s.cancelled && flightLocalDate(s.departureTime, s.departureAirport) === dateKey);
            const [yr, mo, dy] = dateKey.split('-');
            const dateObj = new Date(parseInt(yr), parseInt(mo) - 1, parseInt(dy));
            const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

            const isHard = dayEvents.some(e => e.type === 'hard');
                    const isSoft = dayEvents.some(e => e.type === 'soft');
            const isVacation = dayEvents.some(e => e.type === 'vacation');
            const isTraining = dayEvents.some(e => e.type === 'training');
            let away = dayEvents.find(e => e.type === 'away');
            if (away && isHomeAirport(away.arrivalAirport, currentPilot)) away = null;
            const flights = dayEvents.filter(e => e.type === 'flight').sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));
            const workFlights = flights.filter(f => f.trip !== 'PERSONAL');
            const isPersonalFlight = flights.some(f => f.trip === 'PERSONAL');
            const _detailPersonallyAwayApt = isPersonalFlight ? null : isPersonallyAway(dateKey);
            const _detailRawPersonalApt = isPersonalFlight
                ? (flights.filter(f => f.trip === 'PERSONAL').slice(-1)[0] || {}).arrivalAirport || null
                : null;
            const _detailPersonalFlightApt = (_detailRawPersonalApt && !isHomeOrBase(normApt(_detailRawPersonalApt), currentPilot)) ? _detailRawPersonalApt : null;
            const awayApt = _detailPersonalFlightApt || _detailPersonallyAwayApt;
            const reserves = dayEvents.filter(e => e.type === 'reserve').sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));
            const groundLegs = dayEvents.filter(e => e.type === 'ground').sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));

            const nowMs = Date.now();
            const flightMs = flights.map(f => {
                const cs = deriveCallsign(f, currentPilot) || '';
                const dMs = f.departureTime ? flightUTCTime(f.departureTime, f.departureAirport)?.getTime() : null;
                const rawAMs = f.arrivalTime ? flightUTCTime(f.arrivalTime, f.arrivalAirport)?.getTime() : null;
                return { dMs, aMs: rawAMs, cs, dep: f.departureAirport };
            });
            // "IN THE AIR" only when a position fix confirmed it, the same rule as the grid/list's green.
            // It used to follow the schedule clock alone, so a delayed or "departure due" flight read as live.
            const anyLive = flightMs.some(({dMs, aMs, cs, dep}) => _legLiveState(cs, dMs, isFlightStillActive(dMs, aMs, nowMs, cs, dep) && !_isLandedEarly(cs, aMs)) === 'live');
            let label = _pilotOnDutyDefault(currentPilot, dateKey) ? _onDutyDefaultLabel(currentPilot) : 'DAY OFF';
            let labelColor = 'text-zinc-400';
            if (isVacation) { label = awayApt ? `VACATION · AWAY - ${aptLabel(awayApt, currentPilot)}` : 'VACATION'; labelColor = 'text-teal-400'; }
            else if (isHard) { label = awayApt ? `HARD OFF · AWAY - ${aptLabel(awayApt, currentPilot)}` : 'HARD OFF'; labelColor = 'text-red-400'; }
            else if (isSoft && workFlights.length === 0) { label = awayApt ? `SOFT DAY · AWAY - ${aptLabel(awayApt, currentPilot)}` : 'SOFT DAY'; labelColor = 'text-rose-300'; }
            else if (isTraining && workFlights.length === 0) { label = 'TRAINING'; labelColor = 'text-orange-400'; }
            else if (anyLive) { label = '▶ IN THE AIR'; labelColor = 'text-emerald-400'; }
            else if (workFlights.length > 0) { label = 'FLYING'; labelColor = 'text-blue-400'; }
            else if (isPersonalFlight) { label = 'PERSONAL'; labelColor = 'text-violet-400'; }
            else if (away) { label = `AWAY — ${aptLabel(away.arrivalAirport, currentPilot)}`; labelColor = 'text-amber-400'; }
            else if (awayApt) { label = `AWAY - ${aptLabel(awayApt, currentPilot)}`; labelColor = 'text-yellow-400'; }
            else if (reserves.length > 0) { label = 'ON CALL'; labelColor = 'text-amber-400'; }

            // "Edit Tour" entry point -- raised directly: "going into the my info each tour isn't
            // the best way to do it," wanting to click into the tour itself instead. Own schedule,
            // or admin on any pilot's, and only on an actual NetJets tour day, not Kyle's reserve
            // "ON CALL" system which shares the same _pilotOnDutyDefault() plumbing.
            const _tourEditBtn = _tourEditButton(dateKey, '✈️ Edit Tour');
            // Opens on this day, not today: James's old flights kept landing on the current date.
            const _addFlightBtn = canEdit() ? `<button onclick="document.getElementById('day-detail-sheet').classList.add('hidden');openAddFlight('${dateKey}')" class="text-[9px] font-black uppercase tracking-widest text-blue-400 border border-blue-900 rounded-full px-2.5 py-1 mt-1.5 hover:bg-blue-950/40 transition-colors">+ Add Flight</button>` : '';
            // A tour day with no legs yet isn't missing data -- NetJets only files ~16-18h ahead
            // (research log, 2026-10-30..11-03), so say when to expect them instead of looking empty.
            const _tourLegsNote = (_pilotOnDutyDefault(currentPilot, dateKey) && _onDutyDefaultLabel(currentPilot) === 'ON TOUR'
                && workFlights.length === 0 && dateKey >= _todayLocalDateStr())
                ? `<div class="text-[10px] text-zinc-500 mt-1.5 max-w-[16rem] leading-snug">Legs show up once NetJets files them — usually the evening before.</div>` : '';
            let _blockNote = '';
            if (_showBlockTotals()) {
                const bt = _blockTotalsFor(_blockByDay(), dateKey, {});
                const parts = [];
                if (bt.day > 0) parts.push(`Block ${formatDurationMinutes(bt.day)}`);
                if (bt.tour > 0) parts.push(`Tour ${formatDurationMinutes(bt.tour)}`);
                if (parts.length) _blockNote = `<div class="text-[10px] font-black text-sky-400 mt-1.5">${parts.join(' · ')}</div>`;
            }
            let html = `<div class="flex items-start justify-between mb-4">
                <div>
                    <div class="text-[10px] font-black uppercase tracking-widest ${labelColor}">${label}</div>
                    <div class="text-lg font-black text-white mt-0.5">${dateLabel}</div>
                    ${_tourLegsNote}
                    ${_blockNote}
                    <div class="flex flex-wrap gap-1.5">${_tourEditBtn}${_addFlightBtn}</div>
                </div>
                <button onclick="document.getElementById('day-detail-sheet').classList.add('hidden')" class="w-8 h-8 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-400 text-sm shrink-0">✕</button>
            </div>`;

            if (flights.length === 0 && reserves.length === 0 && groundLegs.length === 0) {
                // Must agree with the header label above (line), not re-derive its own answer --
                // this used to hardcode "On Call" for Kyle only (his reserve system) and "Day
                // Off" for literally everyone else, so a NetJets pilot's rotation/CC on-call day
                // showed "ON CALL" in the header and "Day Off" in the body simultaneously. Found
                // live on Mack while on tour.
                const _onDutyHere = _pilotOnDutyDefault(currentPilot, dateKey);
                const icon = isHard ? '🔴' : isSoft ? '🌸' : away ? '🏨' : _onDutyHere ? '📟' : '😴';
                const msg  = isHard ? 'Hard Day Off' : isSoft ? 'Soft Day' : away ? `Away at ${aptLabel(away.arrivalAirport, currentPilot)}` : _onDutyHere ? (_onDutyDefaultLabel(currentPilot) === 'ON TOUR' ? 'On Tour' : 'On Call') : 'Day Off';
                // A vacation or training day is already its own card below, with the Edit/Delete
                // buttons. A hard or soft day still needs saying here, since no card covers it.
                const cardCoversDay = isVacation || (isTraining && !isHard && !isSoft);
                if (!cardCoversDay) html += `<div class="py-8"><div class="text-center"><div class="text-3xl mb-2">${icon}</div><div class="text-sm font-bold text-zinc-400">${msg}</div></div></div>`;
            }

            // Training/vacation card — shown whenever the segment exists, even alongside flights
            const _tvSegs = dayEvents.filter(e => e.type === 'training' || e.type === 'vacation');
            _tvSegs.forEach(tvSeg => {
                const tvIcon = tvSeg.type === 'vacation' ? '🌴' : '🎓';
                const tvColor = tvSeg.type === 'vacation' ? '#14b8a6' : '#f97316';
                const tvLabel = tvSeg.type === 'vacation' ? 'Vacation' : (tvSeg.departureAirport ? `Training · ${tvSeg.departureAirport}` : 'Training Day');
                const tvEditActions = (tvSeg.id && canEdit()) ? `<div class="flex gap-2 mt-3 pt-3 border-t border-white/5">
                    <button onclick="document.getElementById('day-detail-sheet').classList.add('hidden');openEditFlight(${tvSeg.id})" class="flex-1 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg border border-zinc-700 text-zinc-400 hover:text-blue-400 hover:border-blue-700 transition-colors">✏️ Edit</button>
                    <button onclick="deleteManualFlight(${tvSeg.id}).then(()=>document.getElementById('day-detail-sheet').classList.add('hidden'))" class="flex-1 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg border border-zinc-700 text-zinc-400 hover:text-red-400 hover:border-red-800 transition-colors">🗑️ Delete</button>
                </div>` : '';
                html += `<div class="bg-zinc-900/60 border rounded-xl px-4 py-3 mb-3" style="border-color:${tvColor}28">
                    <div class="flex items-center gap-2">
                        <span class="text-lg">${tvIcon}</span>
                        <span class="text-sm font-bold text-zinc-300">${tvLabel}</span>
                    </div>
                    ${tvEditActions}
                </div>`;
            });

            const allDayLegs = [...flights, ...groundLegs].sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)));
            allDayLegs.forEach(leg => {
            if (leg.type === 'ground') {
                const g = leg;
                const nextFromGrnd = (g.arrivalAirport && g.arrivalTime) ? getNextLegFrom(g.arrivalAirport, g.arrivalTime) : null;
                let grndLayover = '';
                if (nextFromGrnd) {
                    const gm = (new Date(nextFromGrnd.departureTime) - new Date(g.arrivalTime)) / 60000;
                    const atHome = isHomeOrBaseAt(g.arrivalAirport, currentPilot, g.arrivalTime);
                    const sameDay = flightLocalDate(g.arrivalTime, g.arrivalAirport) === flightLocalDate(nextFromGrnd.departureTime, g.arrivalAirport);
                    const lbl = layoverLabel(gm, atHome, sameDay);
                    if (lbl) grndLayover = `<div class="text-amber-300 text-xs font-semibold mt-1">${lbl}</div>`;
                }
                const gDep = g.departureTime ? formatTimeISO(g.departureTime, g.departureAirport) : '';
                const gArr = g.arrivalTime   ? formatTimeISO(g.arrivalTime,   g.arrivalAirport)  : '';
                const gDepTz = g.departureAirport && g.departureTime ? tzAbbr(g.departureAirport, g.departureTime) : '';
                const gArrTz = g.arrivalAirport  && g.arrivalTime   ? tzAbbr(g.arrivalAirport,  g.arrivalTime)   : '';
                const gTzTag = (lbl) => lbl ? ` <span class="text-[10px] font-semibold text-zinc-500">${lbl}</span>` : '';
                const gEditActions = (g.id && canEdit()) ? `<div class="flex gap-2 mt-3 pt-3 border-t border-white/5">
                    <button onclick="document.getElementById('day-detail-sheet').classList.add('hidden');openEditGround(${g.id})" class="flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl border border-zinc-700 text-zinc-400 hover:text-blue-400 hover:border-blue-700 transition-colors">✏️ Edit</button>
                    <button onclick="deleteManualFlight(${g.id}).then(()=>document.getElementById('day-detail-sheet').classList.add('hidden'))" class="flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl border border-zinc-700 text-zinc-400 hover:text-red-400 hover:border-red-800 transition-colors">🗑️ Delete</button>
                </div>` : '';
                html += `<div class="bg-zinc-800/40 border border-zinc-700/30 rounded-xl px-4 py-2.5 mb-2">
                    <div class="flex items-center gap-3">
                        <div class="text-[10px] font-black uppercase tracking-widest text-zinc-500">Ground</div>
                        <div class="text-sm font-bold text-zinc-300">${aptLabel(g.departureAirport, currentPilot)} <span class="text-zinc-600">→</span> ${aptLabel(g.arrivalAirport, currentPilot)}</div>
                        <div class="text-[10px] text-zinc-600 ml-auto">${g.flightNumber || ''}</div>
                    </div>
                    <div class="text-sm font-bold text-zinc-400 mt-1">${gDep}${gTzTag(gDepTz)} <span class="text-zinc-600">→</span> ${gArr}${gTzTag(gArrTz)}</div>
                    ${grndLayover}
                    ${gEditActions}
                </div>`;
                return;
            }
            { // flight
                const f = leg;
                const fi = flights.indexOf(f);
                const { dMs, aMs, cs: _dayCs } = flightMs[fi];
                const dep = f.departureAirport || '';
                const arr = f.arrivalAirport || '';
                const depTime = formatTimeISO(f.departureTime || '', f.departureAirport);
                const arrTime = formatTimeISO(f.arrivalTime || '', f.arrivalAirport);
                const depTz = f.departureAirport ? tzAbbr(f.departureAirport, f.departureTime) : '';
                const arrTz = f.arrivalAirport ? tzAbbr(f.arrivalAirport, f.arrivalTime) : '';
                const tzTag = (lbl) => lbl ? ` <span class="text-[10px] font-semibold text-zinc-500">${lbl}</span>` : '';
                const blockMins = calcBlockMins(f);
                const isPersonal = f.trip === 'PERSONAL';
                const isCommute = f.trip === 'COMMUTE';
                const _dayFlLabel = deriveCallsign(f, currentPilot) || '';
                let groundBadge = '';
                if (!isPersonal && arr && f.arrivalTime) {
                    const nextLeg = getNextLegFrom(arr, f.arrivalTime);
                    if (nextLeg) {
                        const gm = (new Date(nextLeg.departureTime) - new Date(f.arrivalTime)) / 60000;
                        const atHome = isHomeOrBaseAt(arr, currentPilot, f.arrivalTime);
                        const sameDay = flightLocalDate(f.arrivalTime, arr) === flightLocalDate(nextLeg.departureTime, arr);
                        const lbl = layoverLabel(gm, atHome, sameDay);
                        if (lbl) groundBadge = `<div class="text-amber-300 text-xs font-semibold mt-1">${lbl}</div>`;
                    }
                }
                const isActiveLeg = isFlightStillActive(dMs, aMs, nowMs, _dayCs, f.departureAirport) && !_isLandedEarly(_dayCs, aMs);
                // Same rule as the grid/list's own completed checkmark (isCompletedLeg/isCompletedLeg2)
                // -- scoped to today only, since every past day already reads as "done" by definition.
                // Added because the day-detail sheet (opened by tapping a grid cell) was the one place
                // showing a completed leg with no indicator at all, after the grid itself got one.
                const isCompletedLeg = !isActiveLeg && !!aMs && (nowMs >= aMs || _isLandedEarly(_dayCs, aMs)) && dateKey === _localToday();
                const legState = _legLiveState(_dayCs, dMs, isActiveLeg);
                const showLive = legState === 'live';
                const accentColor = showLive ? '#22c55e' : isPersonal ? '#a78bfa' : isCommute ? '#f59e0b' : (PILOT_COLORS[currentPilot] || '#38bdf8');
                const cardBg = isPersonal ? 'bg-violet-950/20' : isCommute ? 'bg-amber-950/20' : showLive ? 'bg-emerald-950/10' : 'bg-zinc-900/60';
                const aptColor = showLive ? '#22c55e' : 'rgba(255,255,255,0.92)';
                const editActions = (f.id && canEdit()) ? `<div class="flex gap-2 px-4 py-2.5 border-t border-white/5">
                    <button onclick="document.getElementById('day-detail-sheet').classList.add('hidden');openEditFlight(${f.id})" class="flex-1 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg border border-zinc-700 text-zinc-400 hover:text-blue-400 hover:border-blue-700 transition-colors">✏️ Edit</button>
                    <button onclick="deleteManualFlight(${f.id}).then(()=>document.getElementById('day-detail-sheet').classList.add('hidden'))" class="flex-1 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg border border-zinc-700 text-zinc-400 hover:text-red-400 hover:border-red-800 transition-colors">🗑️ Delete</button>
                </div>` : '';
                const groundBadgeTxt = groundBadge.replace(/<[^>]+>/g,'').trim();
                const depCity = _intelAreaLabel(dep) || '';
                const arrCity = _intelAreaLabel(arr) || '';
                const hasStub = (_dayFlLabel || f.flightNumber) || f.tail || groundBadgeTxt || isCompletedLeg;
                // Speed and altitude for the live leg, starting from what the grid/list last polled.
                const _liveNow = isActiveLeg && _dayCs ? document.getElementById(`live-${_dayCs}`) : null;
                const _liveLine = isActiveLeg && _dayCs
                    ? `<div data-live-mirror="${_dayCs}" class="px-4 pb-3 text-xs font-bold text-center" style="color:${_liveNow?.style.color || '#4ade80'};${_liveNow?.textContent ? '' : 'display:none'}">${_liveNow?.textContent || ''}</div>`
                    : '';
                html += `<div class="bp-card border mb-3 ${cardBg}" style="border-color:${accentColor}28">
                    <div class="bp-top-bar" style="background:linear-gradient(90deg,${accentColor},${accentColor}44,transparent)"></div>
                    <div class="flex items-center gap-2 px-4 pt-3 pb-0 flex-wrap">
                        ${isActiveLeg && _dayCs ? `<span style="display:contents" data-leg-status="${_dayCs}" data-dep-ms="${dMs}" data-dep-apt="${f.departureAirport || ''}">${_legStatusBadge(legState, _dayCs, dMs, f.departureAirport)}</span>` : ''}
                        ${f.dh ? `<span class="text-[10px] font-semibold text-pink-400">Deadhead</span>` : ''}
                        ${isPersonal ? `<span class="text-[10px] font-semibold text-violet-400">Personal</span>` : ''}
                        ${isCommute ? `<span class="text-[10px] font-semibold text-amber-400">Commute</span>` : ''}
                    </div>
                    <div class="flex items-center px-4 py-3 gap-0">
                        <div class="flex-1 min-w-0">
                            <div class="bp-apt-code" style="color:${aptColor}">${aptLabel(dep, currentPilot)}</div>
                            ${depCity ? `<div class="bp-city">${depCity}</div>` : ''}
                            <div class="text-xs text-zinc-500 mt-2">${depTime}${depTz ? `<span class="text-zinc-600 ml-1">${depTz}</span>` : ''}</div>
                        </div>
                        <div class="flex flex-col items-center justify-center px-4 gap-1 shrink-0">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19.5 2.5S18 2 16.5 3.5L13 7 4.8 5.2l-2 2 2.8 4.5-2.8 2.8 1 3 3-1 2.8 4.5 2-2z"/></svg>
                            ${blockMins !== null ? `<div class="text-[9px] text-zinc-600 text-center whitespace-nowrap">${formatDurationMinutes(blockMins)}</div>` : ''}
                        </div>
                        <div class="flex-1 min-w-0 text-right">
                            <div class="bp-apt-code" style="color:${aptColor}">${aptLabel(arr, currentPilot)}</div>
                            ${arrCity ? `<div class="bp-city">${arrCity}</div>` : ''}
                            <div class="text-xs text-zinc-500 mt-2">${arrTime}${arrTz ? `<span class="text-zinc-600 ml-1">${arrTz}</span>` : ''}</div>
                        </div>
                    </div>
                    ${_liveLine}
                    ${hasStub ? `<div class="bp-stub">
                        ${_dayFlLabel || f.flightNumber ? `<div class="bp-stub-field"><div class="bp-stub-label">Flight</div><div class="bp-stub-value">${_dayFlLabel ? flightAwareLink(_dayFlLabel, _dayFlLabel, flightAwareEligible(dMs)) : f.flightNumber}</div></div>` : ''}
                        ${f.tail ? `<div class="bp-stub-field"><div class="bp-stub-label">Tail</div><div class="bp-stub-value">${displayTail(f.tail, currentPilot)}</div></div>` : ''}
                        ${groundBadgeTxt ? `<div class="bp-stub-field"><div class="bp-stub-label">Layover</div><div class="bp-stub-value" style="color:#fbbf24">${groundBadgeTxt}</div></div>` : ''}
                        ${isCompletedLeg ? `<span class="text-[13px] font-black text-emerald-400 ml-auto" title="Completed">✓</span>` : ''}
                    </div>` : ''}
                    ${editActions}
                </div>`;
            } // end flight block
            }); // end allDayLegs.forEach

            // Don't show reserve blocks when work flights exist (reserve was converted to a trip)
            reserves.filter(() => workFlights.length === 0).forEach(r => {
                const resType = r.flightNumber || 'RES';
                const typeLabels = { RESR: 'Red-Eye Reserve', RESP: 'PM Reserve', RESA: 'AM Reserve' };
                const typeLabel = typeLabels[resType] || 'On-Call Reserve';
                const dep = r.departureAirport || '';
                const arr = r.arrivalAirport || '';
                const depTime = r.departureTime ? formatTimeISO(r.departureTime, dep) : '—';
                const arrTime = r.arrivalTime ? formatTimeISO(r.arrivalTime, arr) : '—';
                const depTz = dep ? tzAbbr(dep, r.departureTime) : '';
                const arrTz = arr ? tzAbbr(arr, r.arrivalTime) : '';
                const tzTag = (lbl) => lbl ? ` <span class="text-[10px] font-semibold text-zinc-500">${lbl}</span>` : '';
                const durMs = (r.departureTime && r.arrivalTime) ? new Date(r.arrivalTime) - new Date(r.departureTime) : 0;
                html += `<div class="bg-amber-950/30 border border-amber-400/20 rounded-xl p-4 mb-3">
                    <div class="flex items-center justify-between mb-1">
                        <div class="text-[10px] font-black uppercase tracking-widest text-amber-400">ON CALL${dep ? ` — ${aptLabel(dep, currentPilot)}` : ''}</div>
                        <div class="text-[10px] font-semibold text-amber-600">${resType}</div>
                    </div>
                    <div class="text-sm font-bold text-amber-200 mb-1">${typeLabel}</div>
                    <div class="flex items-center justify-between text-sm">
                        <div class="font-bold text-zinc-200">${depTime}${tzTag(depTz)} <span class="text-zinc-600">→</span> ${arrTime}${tzTag(arrTz)}</div>
                        <div class="text-zinc-500">${durMs > 0 ? formatDurationMinutes(durMs / 60000) : ''}</div>
                    </div>
                </div>`;
            });

            document.getElementById('day-detail-content').innerHTML = html;
            document.getElementById('day-detail-sheet').classList.remove('hidden');
            if (!_dayDetailSwipeSetup) {
                const panel = document.querySelector('#day-detail-sheet > div:not(.absolute)');
                if (panel) { setupSheetSwipe(panel, () => document.getElementById('day-detail-sheet').classList.add('hidden')); _dayDetailSwipeSetup = true; }
            }
        }

