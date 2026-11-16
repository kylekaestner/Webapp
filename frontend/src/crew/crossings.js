        function toggleCrossingsPilot(key) {
            if (!_crossingsFilter) _crossingsFilter = new Set(PILOT_KEYS);
            if (_crossingsFilter.has(key)) {
                _crossingsFilter.delete(key);
            } else {
                _crossingsFilter.add(key);
            }
            renderOverlapFilterBar();
            computeOverlap();
        }

        function openOverlapDetail(idx) {
            const o = _overlapData[idx];
            if (!o) return;
            const modal = document.getElementById('overlap-detail-modal');
            const title = document.getElementById('overlap-detail-title');
            const body  = document.getElementById('overlap-detail-body');

            const cls      = o.classification;
            const locLabel = o.airport === o.airportB ? aptLabel(o.airport) : (()=>{ const mA = METRO_GROUPS[o.airport], mB = METRO_GROUPS[o.airportB]; return (mA && mA === mB) ? (METRO_LABELS[mA] || `${aptLabel(o.airport)} / ${aptLabel(o.airportB)}`) : `${aptLabel(o.airport)} / ${aptLabel(o.airportB)}`; })();
            const locSub   = o.airport !== o.airportB ? `${aptLabel(o.airport)} · ${aptLabel(o.airportB)}` : null;
            title.textContent = locLabel;

            const _detailTz = (pilotUsesUtc(o.kA) ? airportTz(o.airport) : null)
                           || (pilotUsesUtc(o.kB) ? airportTz(o.airportB) : null)
                           || null;
            const _dtOpts = _detailTz ? { timeZone: _detailTz } : {};
            const fmtT = d => d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ..._dtOpts }) : '—';
            const fmtD = d => d ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ..._dtOpts }) : '';
            const fmtDurMs = ms => { if (!ms || ms <= 0) return ''; const h = Math.floor(ms/3600000), m = Math.round((ms%3600000)/60000); return h > 0 ? `${h}h ${m}m` : `${m}m`; };

            const refTime = o.directStart || new Date(o.sortKey);
            const now = new Date();
            const isNow = o.isDirect && o.directStart <= now && o.directEnd >= now;

            const pilotSections = [{ k: o.kA, p: o.pA }, { k: o.kB, p: o.pB }].map(({ k, p }) => {
                const color   = PILOT_COLORS[k];
                const name    = shortName(PILOT_NAMES[k]);
                const role    = PILOT_ROLES[k] || '';
                const isHome  = isHomeAirport(p.airport, k);
                const isBase  = pilotsCache[k]?.base && sameApt(p.airport, pilotsCache[k].base);
                const locCtx  = isHome ? 'Home airport' : isBase ? 'Airline base' : 'Layover';
                const fn      = p.arrFlightNum || '';
                const dur     = fmtDurMs(p.end - p.start);
                const pTz     = pilotUsesUtc(k) ? (airportTz(p.airport) || null) : null;
                const pTzOpts = pTz ? { timeZone: pTz } : {};
                const pFmtT   = d => d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...pTzOpts }) : '—';
                const pTzLbl  = tzAbbr(p.airport, p.start.toISOString());
                const tzSpan  = pTzLbl ? ` <span class="text-zinc-600">${pTzLbl}</span>` : '';
                return `<div class="rounded-xl border border-zinc-800 p-3.5 space-y-1.5">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${color}"></span>
                        <span class="font-black text-white text-sm">${name}</span>
                        ${role ? `<span class="text-[10px] text-zinc-600 ml-1">${role}</span>` : ''}
                    </div>
                    <div class="flex justify-between text-xs"><span class="text-zinc-500">Airport</span><span class="text-zinc-300 font-mono font-bold">${aptLabel(p.airport)} <span class="text-zinc-600 font-normal">${locCtx}</span></span></div>
                    <div class="flex justify-between text-xs"><span class="text-zinc-500">Arrives</span><span class="text-zinc-300 font-mono">${pFmtT(p.start)}${tzSpan}</span></div>
                    <div class="flex justify-between text-xs"><span class="text-zinc-500">Departs</span><span class="text-zinc-300 font-mono">${pFmtT(p.end)}${tzSpan}</span></div>
                    <div class="flex justify-between text-xs"><span class="text-zinc-500">Ground time</span><span class="text-zinc-300">${dur || '—'}</span></div>
                    ${fn ? `<div class="flex justify-between text-xs"><span class="text-zinc-500">Arrival flight</span><span class="text-zinc-300 font-mono">${fn}</span></div>` : ''}
                </div>`;
            }).join('');

            const _togetherTzLbl = tzAbbr(o.airport, o.directStart?.toISOString() || new Date().toISOString());
            const overlapSection = o.isDirect ? `
                <div class="rounded-xl border ${isNow ? 'border-green-800/50 bg-green-950/20' : 'border-zinc-800'} p-3.5">
                    <div class="text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-2">Together</div>
                    <div class="text-2xl font-black ${isNow ? 'text-green-400' : 'text-white'}">${fmtDurMs(o.directEnd - o.directStart)}</div>
                    <div class="text-xs text-zinc-500 mt-1">${fmtT(o.directStart)} – ${fmtT(o.directEnd)}${_togetherTzLbl ? ` <span class="text-zinc-600">${_togetherTzLbl}</span>` : ''} · ${fmtD(o.directStart)}</div>
                </div>` : o.gapMs > 0 ? `
                <div class="rounded-xl border border-amber-900/40 bg-amber-950/10 p-3.5">
                    <div class="text-[10px] font-black uppercase tracking-widest text-amber-600 mb-1">Near Miss</div>
                    <div class="text-sm text-amber-400">${fmtDurMs(o.gapMs)} apart in time</div>
                    <div class="text-xs text-zinc-600 mt-1">${[{k:o.kA,p:o.pA},{k:o.kB,p:o.pB}].map(({k,p})=>{const lbl=tzAbbr(p.airport,p.start.toISOString());return`${PILOT_NAMES[k].split(' ')[0]}: ${fmtT(p.start)}–${fmtT(p.end)}${lbl?` ${lbl}`:''}`}).join(' · ')}</div>
                </div>` : '';

            const classSection = cls ? `
                <div class="text-[10px] text-zinc-600 flex items-center gap-2">
                    <span class="px-1.5 py-0.5 rounded-full font-black uppercase tracking-wide" style="background:${cls.color}22;color:${cls.color}">${cls.label}</span>
                    ${o.distMi > 0 ? `<span>${o.distMi} mi between airports</span>` : ''}
                    ${cls.transitNote ? `<span>${cls.transitNote}</span>` : ''}
                </div>` : '';

            const annoSection = cls?.type === 'HOME_VISIT'
                ? `<div class="text-xs text-emerald-400/80">✈ ${PILOT_NAMES[cls.visitorPilot]?.split(' ')[0]} visiting ${PILOT_NAMES[cls.homePilot]?.split(' ')[0]}'s home city</div>`
                : cls?.cityMeetup
                ? `<div class="text-xs text-orange-400/80">Both in city — potential meetup outside the airport</div>`
                : '';

            body.innerHTML = `
                <div class="text-xs text-zinc-500 -mt-1">${fmtD(refTime)}${locSub ? ` · <span class="font-mono">${locSub}</span>` : ''}</div>
                ${classSection}
                ${annoSection ? `<div>${annoSection}</div>` : ''}
                ${overlapSection}
                <div class="space-y-2">${pilotSections}</div>
            `;
            modal.classList.remove('hidden');
        }

        // computeOverlap -- 3-step pipeline:
        //   1. buildGroundPeriods(): walk each pilot's flights and emit { airport, start, end }
        //      periods for every ground window (gate arrival -> next departure).
        //   2. Cross every pair of pilots' periods; airportsNear() checks metro groups first,
        //      then haversine fallback (50 mi). classifyOverlap() assigns tier + label.
        //   3. Render: tier 1-2 -> primary cards; tier 3 -> compact "Also Nearby" rows.
        //      involvesMyPilot filters cards shown in "Your Crossings" vs "Other Crew".
        async function computeOverlap() {
            const container = document.getElementById('overlap-content');
            container.innerHTML = '<div class="flex items-center justify-center gap-2.5 py-10 text-zinc-500 text-sm"><div class="spinner"></div><span>Loading schedules…</span></div>';

            // Yield to the browser so the spinner actually paints before the pipeline
            // below runs. When every pilot is already cached, `await Promise.all(...)`
            // resolves via microtasks with no real fetch — no macrotask boundary, so
            // the browser never gets a chance to paint before the (fairly heavy)
            // buildGroundPeriods/cross-pairing/render work below runs, and switching
            // to Overlap can feel like it hangs before the view even appears.
            await new Promise(r => setTimeout(r, 0));

            const now = new Date();
            const bufferMs = 3 * 60 * 60 * 1000;

            // Crossings only make sense between people who can actually see each other --
            // only fetch pilots we're friends with (or everyone, for admin/viewer).
            await Promise.all(visiblePilotKeys().map(async key => {
                if (!pilotsCache[key]) {
                    try { await _loadPilotOnce(key); }
                    catch (e) { return; }
                }
            }));

            function buildGroundPeriods(segments, homeBase, homeCity, baseHistory) {
                // Normalize all airport codes so KLGA === LGA, CYYZ === YYZ, etc.
                // `home` is the pilot's base AS OF TODAY, used for homeC/nextFromBase matching
                // below; baseAt() (defined after allDeps, which it needs) resolves whichever base
                // actually governed a given moment, for a pilot whose base changed over time.
                const home  = homeBase  ? normApt(homeBase)  : null;
                const homeC = homeCity  ? normApt(homeCity)  : null;
                // A pilot's whole history runs through the scans below, once per flight. Every date and
                // airport code is worked out once here, not again on each pass of each scan.
                const _tMemo = new Map();
                const tMs = str => {
                    let v = _tMemo.get(str);
                    if (v === undefined) { v = new Date(str).getTime(); _tMemo.set(str, v); }
                    return v;
                };
                const flights = segments
                    .filter(s => (s.type === 'flight' || s.type === 'ground') && s.departure_time && s.arrival_time && s.departure_airport && s.arrival_airport && !s.auto_leg_cancelled)
                    .sort((a, b) => tMs(a.departure_time) - tMs(b.departure_time));
                // All departing segments including personal/commute — used to terminate ground periods
                // so a commute home from a layover airport correctly ends the stay there.
                const allDeps = segments
                    .filter(s => s.departure_time && s.departure_airport && !s.auto_leg_cancelled)
                    .sort((a, b) => tMs(a.departure_time) - tMs(b.departure_time));
                const depTimes = allDeps.map(n => tMs(n.departure_time));
                const depApts = allDeps.map(n => normApt(n.departure_airport));
                const fltDepTimes = flights.map(n => tMs(n.departure_time));
                const fltDepApts = flights.map(n => normApt(n.departure_airport));

                // baseAt(d) resolves whichever base actually governed the pilot AT A GIVEN MOMENT,
                // for one whose base changed (baseHistory from the API, see resolveBaseAt). It is
                // NOT a plain date lookup against baseHistory's own effective_from -- a trip already
                // in progress when the change takes effect must stay on the OLD base for its whole
                // duration, even for legs landing after the change, not just whichever exact day the
                // change happened to land on. So baseAt first finds the pairing's own anchor: the
                // most recent moment, at or before `d`, that the pilot departed from ANY base
                // they've ever had (old or current) -- not necessarily today's `home`. Everything
                // from that departure up to the next one like it belongs to the same trip, and the
                // trip's governing base is whichever applied back when it actually left.
                // No `trip`/pairing number is relied on since not every parser populates one (e.g.
                // Republic/csv). Falls back to `d` itself (today's base) when there's no history at
                // all, which resolves identically to the pilot's single, unchanging base either way.
                const knownBases = new Set();
                if (home) knownBases.add(home);
                (baseHistory || []).forEach(h => h.base && knownBases.add(normApt(h.base)));
                const depIsBase = depApts.map(a => knownBases.has(a));
                const _baseMemo = new Map();
                const baseAt = (d) => {
                    const atMs = d instanceof Date ? d.getTime() : tMs(d);
                    if (_baseMemo.has(atMs)) return _baseMemo.get(atMs);
                    let anchorMs = atMs;
                    for (let x = 0; x < depTimes.length; x++) {
                        if (depTimes[x] > atMs) break;
                        if (depIsBase[x]) anchorMs = depTimes[x];
                    }
                    const base = resolveBaseAt(homeBase, baseHistory, new Date(anchorMs));
                    _baseMemo.set(atMs, base);
                    return base;
                };
                const periods = [];
                const latestArrAt = new Map(); // airport -> the latest-arriving flight so far (first one wins a tie)

                flights.forEach((f, i) => {
                    const dep = normApt(f.departure_airport);
                    const arr = normApt(f.arrival_airport);
                    const depT = new Date(f.departure_time);
                    const arrT = new Date(f.arrival_time);

                    const depMs = depT.getTime(), arrMs = arrT.getTime();
                    const recentArr = latestArrAt.get(dep);
                    const prevLatest = latestArrAt.get(arr);
                    if (!prevLatest || arrMs > tMs(prevLatest.arrival_time)) latestArrAt.set(arr, f);
                    const recentArrT = recentArr ? new Date(recentArr.arrival_time) : null;
                    const recentArrMs = recentArr ? recentArrT.getTime() : null;
                    // For home base: only use arrival if within 24h (pilot lives there).
                    // For other airports: only use if pilot hasn't flown elsewhere since — i.e. still
                    // on the same trip. A departure from any other airport between recentArr and now
                    // means the pilot went home and came back; use a fresh 2h window instead.
                    const useRecentArr = recentArr && (
                        dep === baseAt(depT)
                            ? (depT - recentArrT) < 24 * 3600000
                            : !depTimes.some((t, x) => depApts[x] !== dep && t > recentArrMs && t < depMs)
                    );
                    const groundStart = useRecentArr ? new Date(recentArr.arrival_time)
                        : new Date(depT.getTime() - 2 * 3600000);
                    const alreadyCovered = periods.some(p => p.airport === dep &&
                        p.start.getTime() <= groundStart.getTime() && p.end.getTime() >= depT.getTime());
                    if (!alreadyCovered) periods.push({ airport: dep, start: groundStart, end: depT, flightNum: f.flight_number || null });

                    // Skip post-arrival period at airline base — UNLESS the pilot's home city IS their
                    // base (non-commuters like Drew/Kyle). For them, fall through to the homeCity branch
                    // so a ground period is generated covering the at-home stay. Base is resolved as of
                    // this specific arrival so a pilot whose base changed mid-history is judged against
                    // whichever base actually applied back then, not today's.
                    const baseHere = baseAt(arrT);
                    if (baseHere && arr === baseHere && homeC !== baseHere) {
                        // Commuter back at base: the trip home isn't logged, so they're at their home city once the
                        // commute window has passed, until they next leave from home or base.
                        const commuteStart = new Date(arrT.getTime() + 3 * 3600000);
                        const commuteStartMs = commuteStart.getTime();
                        const nextLeave = allDeps.find((n, x) =>
                            depTimes[x] > commuteStartMs && (depApts[x] === homeC || depApts[x] === baseAt(n.departure_time)));
                        const commuteEnd = nextLeave ? new Date(nextLeave.departure_time) : new Date(arrT.getTime() + 7 * 86400000);
                        if (homeC && commuteEnd > commuteStart) {
                            // Two commutes back close together (e.g. two base arrivals in a day) are one stay at home.
                            const same = periods.find(p => p.airport === homeC && p.start <= commuteEnd && p.end >= commuteStart);
                            if (same) {
                                same.start = new Date(Math.min(same.start, commuteStart));
                                same.end = new Date(Math.max(same.end, commuteEnd));
                            } else {
                                periods.push({ airport: homeC, start: commuteStart, end: commuteEnd });
                            }
                        }
                        return;
                    }
                    // Use allDeps so personal/commute departures also terminate ground periods
                    const nextFromArr = allDeps.find((n, x) => depApts[x] === arr && depTimes[x] > arrMs);
                    let groundEnd;
                    if (homeC && arr === homeC) {
                        const nextFromArrMs = nextFromArr ? tMs(nextFromArr.departure_time) : null;
                        const nextFromBase = home ? flights.find((n, x) =>
                            x > i && (!nextFromArr || fltDepTimes[x] < nextFromArrMs) && fltDepApts[x] === baseAt(n.departure_time)
                        ) : null;
                        // Stays put until the next logged flight; the seven-day bound only stops a stay with nothing
                        // scheduled after it from running on forever.
                        const cap = nextFromArr
                            ? new Date(nextFromArr.departure_time)
                            : new Date(arrT.getTime() + 7 * 86400000);
                        groundEnd = (nextFromBase && new Date(nextFromBase.departure_time) < cap)
                            ? new Date(nextFromBase.departure_time)
                            : cap;
                    } else if (nextFromArr) {
                        const nextT = new Date(nextFromArr.departure_time);
                        const gapDays = (nextT - arrT) / 86400000;
                        if (gapDays > 2) {
                            // Long gap before next departure from arr — if the pilot flew from any
                            // other airport during this gap, they went home after this arrival.
                            const nextMs = nextT.getTime();
                            const wentHome = depTimes.some((t, x) => depApts[x] !== arr && t > arrMs && t < nextMs);
                            groundEnd = wentHome ? new Date(arrT.getTime() + 8 * 3600000) : nextT;
                        } else {
                            groundEnd = nextT;
                        }
                    } else {
                        // No later flight logged: they're still at this airport until one is (seven-day bound).
                        groundEnd = new Date(arrT.getTime() + 7 * 86400000);
                    }
                    periods.push({ airport: arr, start: arrT, end: groundEnd, arrFlightNum: f.flight_number || null, isDH: !!f.is_dh });
                });

                // Inject reserve windows as ground periods at the reserve base
                segments.filter(s => s.type === 'reserve' && s.departure_time && s.arrival_time && s.departure_airport)
                    .forEach(r => {
                        const airport = normApt(r.departure_airport);
                        const start = new Date(r.departure_time);
                        const end   = new Date(r.arrival_time);
                        if (!airport || isNaN(start) || isNaN(end)) return;
                        if (!periods.some(p => p.airport === airport && p.start <= start && p.end >= end))
                            periods.push({ airport, start, end });
                    });

                return periods;
            }

            const pilotPeriods = {};
            const overlapKeys = [...VALID_PILOTS];
            overlapKeys.forEach(key => {
                const data = pilotsCache[key];
                const periods = data?.segments ? buildGroundPeriods(data.segments, data.base, data.home_airport || PILOT_HOME[key], data.base_history) : [];
                pilotPeriods[key] = data?.parser_type === 'manual_netjets' ? _netjetsHomeOnOffDays(key, periods) : periods;
            });

            const getCoords = code => AIRPORTS[code] || AIRPORTS['K' + code] || null;
            const sameMetro = (a, b) => { const mA = METRO_GROUPS[a], mB = METRO_GROUPS[b]; return !!(mA && mA === mB); };
            const airportsNear = (a, b) => {
                if (a === b) return true;
                if (sameMetro(a, b)) return true;
                // Haversine fallback for airports not in a metro group (50 mi)
                const ca = getCoords(a), cb = getCoords(b);
                if (!ca || !cb) return false;
                return haversineMi(ca[0], ca[1], cb[0], cb[1]) <= 50;
            };

            // Minimum ground time to be considered a "real stay" vs just connecting
            const LAYOVER_MS = 5 * 3600000;

            // Classify the nature of an overlap.
            // Returns { type, label, color, tier } where tier:
            //   1 = meaningful — both pilots actually at the same place, worth highlighting
            //   2 = possible — passing through the same airport, or chance encounter
            //   3 = coincidence — different airports in same metro with one just transiting, or haversine-only
            function classifyOverlap(kA, kB, pA, pB, isDirect, directStart, directEnd) {
                const locA = pA.airport, locB = pB.airport;
                const homeA = normApt(PILOT_HOME[kA] || ''), homeB = normApt(PILOT_HOME[kB] || '');
                const durA = pA.end - pA.start, durB = pB.end - pB.start;
                const aHasTime = durA >= LAYOVER_MS, bHasTime = durB >= LAYOVER_MS;
                const inSameMetro = sameMetro(locA, locB);

                // Same-flight DH
                if (isDirect && pA.arrFlightNum && pB.arrFlightNum && pA.arrFlightNum === pB.arrFlightNum) {
                    return { type: 'SAME_FLIGHT', label: 'Same Flight', color: '#a78bfa', tier: 1 };
                }

                // Home visit: one pilot is on a layover in the other's home city
                const aMetro = METRO_GROUPS[locA] || locA, bMetro = METRO_GROUPS[locB] || locB;
                const homeAMetro = homeA ? (METRO_GROUPS[homeA] || homeA) : null;
                const homeBMetro = homeB ? (METRO_GROUPS[homeB] || homeB) : null;
                const aAtBHome = homeBMetro && aMetro === homeBMetro;
                const bAtAHome = homeAMetro && bMetro === homeAMetro;
                if (aAtBHome || bAtAHome) {
                    const homePilot = aAtBHome ? kB : kA;
                    const visitorPilot = aAtBHome ? kA : kB;
                    const visitorHasTime = aAtBHome ? aHasTime : bHasTime;
                    // Only show Home Turf when the visitor has a real layover — quick transits through
                    // a pilot's home airport (e.g. ORD connection) fall through to normal logic.
                    if (visitorHasTime) {
                        return { type: 'HOME_VISIT', label: 'Home Turf', color: '#34d399', homePilot, visitorPilot, tier: 1 };
                    }
                }

                // Different airports
                if (locA !== locB) {
                    if (inSameMetro) {
                        // Same city, different airports — only meaningful if BOTH have real layover time
                        // so they could actually leave the airport and meet in the city
                        if (aHasTime && bHasTime) {
                            return { type: 'METRO', label: 'City Meetup', color: '#fb923c', tier: 1, cityMeetup: true };
                        }
                        // One or both just connecting — geographic coincidence
                        const transiter = !aHasTime ? PILOT_NAMES[kA].split(' ')[0] : PILOT_NAMES[kB].split(' ')[0];
                        const transitApt = !aHasTime ? locA : locB;
                        return { type: 'METRO', label: 'Same Metro', color: '#6b7280', tier: 3, transitNote: `${transiter} is just transiting ${transitApt}` };
                    }
                    // Haversine-only (airports in the same general area but no metro group) — coincidence
                    return { type: 'NEARBY', label: 'Nearby', color: '#6b7280', tier: 3 };
                }

                // Same airport
                if (isDirect) {
                    const overlapMs = directEnd - directStart;
                    if (!aHasTime || !bHasTime) {
                        // One is just connecting — still at the same airport, can still meet
                        const transiter = !aHasTime ? PILOT_NAMES[kA].split(' ')[0] : PILOT_NAMES[kB].split(' ')[0];
                        return { type: 'PASSING_THROUGH', label: 'Passing Through', color: '#60a5fa', tier: 1, transitNote: `${transiter} is connecting` };
                    }
                    const spansNight = new Date(directStart).toDateString() !== new Date(directEnd).toDateString();
                    if (spansNight || overlapMs >= 5 * 3600000) {
                        return { type: 'LAYOVER', label: 'Overnight', color: '#a78bfa', tier: 1 };
                    }
                }
                return { type: 'MEETUP', label: 'Meetup', color: '#22d3ee', tier: 1 };
            }

            // Build location display label
            function locationLabel(locA, locB) {
                if (locA === locB) return locA;
                const mA = METRO_GROUPS[locA], mB = METRO_GROUPS[locB];
                if (mA && mA === mB) return METRO_LABELS[mA] || `${locA} / ${locB}`;
                return `${locA} / ${locB}`;
            }
            // The two pilot airports when same metro but different
            function locationSub(locA, locB) {
                const mA = METRO_GROUPS[locA], mB = METRO_GROUPS[locB];
                if (mA && mA === mB && locA !== locB) return `${locA} · ${locB}`;
                return null;
            }
            // For non-UTC pilots, their times are stored as local airport time but parsed by the browser
            // as if they were in the browser's timezone. Shift by the difference so UTC comparisons are correct.
            const adjustedPeriod = (k, p) => {
                if (pilotUsesUtc(k) || p.absolute) return p;
                const tz = airportTz(p.airport);
                if (!tz) return p;
                const ref = p.start;
                const airportOff = (() => {
                    try {
                        let fmt = _tzOffsetFmts.get(tz);
                        if (!fmt) {
                            fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
                            _tzOffsetFmts.set(tz, fmt);
                        }
                        const parts = fmt.formatToParts(ref);
                        const str = (parts.find(x => x.type === 'timeZoneName') || {}).value || '';
                        const m = str.match(/GMT([+-])(\d+):(\d{2})/);
                        if (!m) return null;
                        return (m[1] === '+' ? 1 : -1) * (parseInt(m[2]) * 60 + parseInt(m[3]));
                    } catch (e) { return null; }
                })();
                const browserOff = -ref.getTimezoneOffset();
                if (airportOff === null || airportOff === browserOff) return p;
                // browserOff - airportOff: browser parsed local time as browser-tz; shift to make it airport-tz
                const diffMs = (browserOff - airportOff) * 60000;
                return { ...p, start: new Date(p.start.getTime() + diffMs), end: new Date(p.end.getTime() + diffMs) };
            };

            const overlaps = [];
            // Each pilot's periods span their whole history, and any crossing that has ended is dropped
            // below. A pair where both periods ended before this cutoff can't survive that, so it's
            // skipped here. Two days of slack covers adjustedPeriod()'s shift.
            const oldCutMs = now.getTime() - 2 * 86400000;
            const recentPeriods = {};
            overlapKeys.forEach(k => { recentPeriods[k] = pilotPeriods[k].filter(p => p.end.getTime() >= oldCutMs); });
            const adjMemo = new Map();
            const adjOf = (k, p) => {
                let adj = adjMemo.get(p);
                if (!adj) { adj = adjustedPeriod(k, p); adjMemo.set(p, adj); }
                return adj;
            };
            for (let i = 0; i < overlapKeys.length; i++) {
                for (let j = i + 1; j < overlapKeys.length; j++) {
                    const kA = overlapKeys[i], kB = overlapKeys[j];
                    for (const pA of pilotPeriods[kA]) {
                        const adjA = adjOf(kA, pA);
                        const candidates = pA.end.getTime() < oldCutMs ? recentPeriods[kB] : pilotPeriods[kB];
                        for (const pB of candidates) {
                            // Time check first: it's only arithmetic, and it rejects nearly every pair
                            // before the distance math. Timezone-adjusted periods, for UTC comparisons.
                            const adjB = adjOf(kB, pB);
                            if (adjA.start.getTime() - bufferMs > adjB.end.getTime()) continue;
                            if (adjB.start.getTime() - bufferMs > adjA.end.getTime()) continue;
                            if (!airportsNear(pA.airport, pB.airport)) continue;
                            const homeA = normApt(PILOT_HOME[kA] || ''), homeB = normApt(PILOT_HOME[kB] || '');
                            if (homeA && homeB && airportsNear(pA.airport, homeA) && airportsNear(pB.airport, homeB)) continue;
                            const _ca = getCoords(pA.airport), _cb = getCoords(pB.airport);
                            const distMi = (pA.airport !== pB.airport && _ca && _cb)
                                ? Math.round(haversineMi(_ca[0], _ca[1], _cb[0], _cb[1]))
                                : 0;

                            const directStart = new Date(Math.max(adjA.start.getTime(), adjB.start.getTime()));
                            const directEnd   = new Date(Math.min(adjA.end.getTime(),   adjB.end.getTime()));
                            const isDirect = directStart < directEnd;
                            const gapMs = isDirect ? 0 : Math.max(
                                adjA.start.getTime() - adjB.end.getTime(),
                                adjB.start.getTime() - adjA.end.getTime()
                            );
                            const classification = classifyOverlap(kA, kB, pA, pB, isDirect, directStart, directEnd);
                            const overlap = {
                                airport: pA.airport, airportB: pB.airport, distMi,
                                kA, kB, pA, pB, isDirect,
                                directStart: isDirect ? directStart : null,
                                directEnd:   isDirect ? directEnd   : null,
                                gapMs, classification,
                                sortKey: isDirect ? directStart.getTime() : Math.max(adjA.start.getTime(), adjB.start.getTime())
                            };
                            overlaps.push(overlap);
                        }
                    }
                }
            }

            const seen = new Set();
            const unique = overlaps.filter(o => {
                const k = `${o.airport}|${o.airportB}|${o.kA}|${o.kB}|${o.pA.start.toISOString()}|${o.pB.start.toISOString()}`;
                if (seen.has(k)) return false;
                seen.add(k);
                const endTime = o.isDirect ? o.directEnd?.getTime() : Math.max(o.pA.end.getTime(), o.pB.end.getTime());
                return endTime >= now.getTime();
            });

            // Regular pilots only see overlaps involving themselves; everyone respects crew visibility
            const visibleCrew = new Set(getCrewVisible());
            const byPilot = myPilot ? unique.filter(o => o.kA === myPilot || o.kB === myPilot) : unique;
            const filtered = byPilot.filter(o => visibleCrew.has(o.kA) && visibleCrew.has(o.kB));

            filtered.sort((a, b) => a.sortKey - b.sortKey);

            const _pad = n => String(n).padStart(2, '0');
            const localDateStr = d => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;
            const todayStr = localDateStr(now);
            const tomorrowStr = localDateStr(new Date(now.getTime() + 86400000));

            const fmtDateShort = t => t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const fmtDur = ms => {
                if (ms <= 0) return '';
                const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
                return h > 0 ? `${h}h ${m}m` : `${m}m`;
            };
            const fmtH = (t, tz) => t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...(tz ? { timeZone: tz } : {}) });
            const fmtTimeRange = (start, end, tz) => {
                if (!start || !end) return '';
                const tzOpts = tz ? { timeZone: tz } : {};
                const sDay = start.toLocaleDateString('en-US', tzOpts);
                const eDay = end.toLocaleDateString('en-US', tzOpts);
                if (sDay === eDay) {
                    const hourOf = d => {
                        if (!tz) return d.getHours();
                        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).formatToParts(d);
                        return parseInt(parts.find(p => p.type === 'hour')?.value ?? d.getHours());
                    };
                    const minOf = d => {
                        if (!tz) return d.getMinutes();
                        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: '2-digit' }).formatToParts(d);
                        return parseInt(parts.find(p => p.type === 'minute')?.value ?? d.getMinutes());
                    };
                    const sH = hourOf(start), eH = hourOf(end);
                    const sAP = sH >= 12 ? 'PM' : 'AM', eAP = eH >= 12 ? 'PM' : 'AM';
                    if (sAP === eAP) {
                        const h = sH % 12 || 12;
                        const m = String(minOf(start)).padStart(2, '0');
                        return `${h}:${m} – ${fmtH(end, tz)}`;
                    }
                    return `${fmtH(start, tz)} – ${fmtH(end, tz)}`;
                }
                const day = d => d.toLocaleDateString('en-US', { weekday: 'short', ...tzOpts });
                return `${day(start)} ${fmtH(start, tz)} – ${day(end)} ${fmtH(end, tz)}`;
            };

            const primary   = filtered.filter(o => (o.classification?.tier || 3) <= 2);
            const secondary = filtered.filter(o => (o.classification?.tier || 3) >= 3);


            const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const scrollTargetIdx = primary.findIndex(o => o.sortKey >= todayMidnight.getTime());



            // Render a primary card (tiers 1 & 2)
            function renderPrimaryCard(o, idx, isScrollTarget) {
                // Use airport timezone only for pilots whose times are stored as UTC.
                // Local-time pilots (airline CSVs) must not have timezone conversion applied.
                const tzA = pilotUsesUtc(o.kA) ? (airportTz(o.airport)  || null) : null;
                const tzB = pilotUsesUtc(o.kB) ? (airportTz(o.airportB) || null) : null;
                const tz  = tzA || tzB || null; // for shared displays (stripe, bar)
                const refTime    = o.directStart || new Date(o.sortKey);
                const refDay     = localDateStr(refTime);
                const isToday    = refDay === todayStr;
                const isTomorrow = refDay === tomorrowStr;
                const isPast     = refDay < todayStr;
                const isNear     = !o.isDirect;
                const isNow      = o.isDirect && o.directStart <= now && o.directEnd >= now;
                const scrollId   = ` id="overlap-card-${idx}"${isScrollTarget ? ' data-scroll-target="1"' : ''}`;

                const cls        = o.classification;
                const tier       = cls?.tier || 1;

                let dateLabel;
                if (isNow)           dateLabel = 'Right Now';
                else if (isToday)    dateLabel = 'Today';
                else if (isTomorrow) dateLabel = 'Tomorrow';
                else                 dateLabel = fmtDateShort(refTime);

                let badgeCls, pulseDot = '';
                if (isNow)                  { badgeCls = 'text-green-400'; pulseDot = `<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5" style="animation:here-pulse 2s ease-out infinite"></span>`; }
                else if (isNear && !isPast) badgeCls = 'text-amber-400';
                else if (isToday)           badgeCls = 'text-sky-400';
                else if (isTomorrow)        badgeCls = 'text-blue-400';
                else if (isPast)            badgeCls = 'text-zinc-600';
                else                        badgeCls = 'text-zinc-400';

                const typeBadge = cls
                    ? `<span class="text-[9px] font-black px-1.5 py-0.5 rounded-full uppercase tracking-wide" style="background:${cls.color}22;color:${cls.color}">${isNear && !isPast ? 'Near Miss' : cls.label}</span>`
                    : '';

                // Contextual annotation (home visit, city meetup, transit note)
                let annotation = '';
                if (!isPast) {
                    if (cls?.type === 'HOME_VISIT') {
                        const homeName    = PILOT_NAMES[cls.homePilot]?.split(' ')[0];
                        const visitorName = PILOT_NAMES[cls.visitorPilot]?.split(' ')[0];
                        annotation = `<div class="px-4 pb-2 text-[11px] text-emerald-400/80">✈ ${visitorName} visiting ${homeName}'s home turf</div>`;
                    } else if (cls?.cityMeetup) {
                        const city = METRO_LABELS[METRO_GROUPS[o.airport]] || locationLabel(o.airport, o.airportB);
                        annotation = `<div class="px-4 pb-2 text-[11px] text-orange-400/80">Both in ${city} — could meet outside the airport</div>`;
                    } else if (cls?.transitNote) {
                        annotation = `<div class="px-4 pb-2 text-[11px] text-blue-400/60">${cls.transitNote}</div>`;
                    }
                }

                const locLabel   = locationLabel(o.airport, o.airportB);
                const locSub     = locationSub(o.airport, o.airportB);
                const distTag  = o.distMi > 0 ? `<span class="text-sm font-normal text-zinc-500 ml-1.5">${o.distMi} mi apart</span>` : '';

                const pilotRows = [{ k: o.kA, p: o.pA }, { k: o.kB, p: o.pB }].map(({ k, p }) => {
                    const color      = PILOT_COLORS[k];
                    const name       = PILOT_NAMES[k].split(' ')[0];
                    const dur        = fmtDur(p.end - p.start);
                    const isBase     = pilotsCache[k]?.base && sameApt(p.airport, pilotsCache[k].base);
                    const isHome     = isHomeAirport(p.airport, k);
                    const locTag     = isHome ? `<span class="text-[9px] text-zinc-600 ml-1">home</span>`
                                     : isBase ? `<span class="text-[9px] text-zinc-600 ml-1">base</span>` : '';
                    const fnTag      = p.arrFlightNum ? `<span class="text-[9px] text-zinc-700 font-mono ml-1">${p.arrFlightNum}</span>` : '';
                    const pilotTz    = pilotUsesUtc(k) ? (airportTz(p.airport) || null) : null;
                    const pilotTzLbl = tzAbbr(p.airport, p.start.toISOString());
                    const tzTag      = pilotTzLbl ? `<span class="text-[9px] text-zinc-600 ml-1">${pilotTzLbl}</span>` : '';
                    return `<div class="flex items-center gap-2.5">
                        <span class="w-2 h-2 rounded-full shrink-0" style="background:${color}"></span>
                        <span class="text-xs font-black w-10 shrink-0" style="color:${color}">${name}</span>
                        <span class="text-xs text-zinc-400 font-mono flex-1">${fmtTimeRange(p.start, p.end, pilotTz)}${tzTag}${locTag}${fnTag}</span>
                        ${dur ? `<span class="text-[10px] text-zinc-600 shrink-0">${dur}</span>` : ''}
                    </div>`;
                }).join('');

                // Duration bar — only for tier 1 direct overlaps
                let durationBar = '';
                if (o.isDirect && tier === 1) {
                    const spanStart = Math.min(o.pA.start.getTime(), o.pB.start.getTime());
                    const spanEnd   = Math.max(o.pA.end.getTime(),   o.pB.end.getTime());
                    const spanMs    = spanEnd - spanStart;
                    if (spanMs > 0) {
                        const barLeft  = ((o.directStart.getTime() - spanStart) / spanMs * 100).toFixed(1);
                        const barWidth = ((o.directEnd.getTime() - o.directStart.getTime()) / spanMs * 100).toFixed(1);
                        const barColor = isNow ? '#22c55e' : isToday ? '#38bdf8' : cls?.color || '#818cf8';
                        const dur      = fmtDur(o.directEnd - o.directStart);
                        durationBar = `<div class="px-4 pb-3">
                            <div class="relative h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                <div class="absolute top-0 h-full rounded-full" style="left:${barLeft}%;width:${barWidth}%;background:${barColor};${isNow ? 'box-shadow:0 0 6px ' + barColor : ''}"></div>
                            </div>
                            <div class="flex justify-between mt-1">
                                <span class="text-[10px] text-zinc-600">${fmtH(new Date(spanStart), tz)}</span>
                                <span class="text-[10px] font-bold" style="color:${barColor}">${dur} overlap</span>
                                <span class="text-[10px] text-zinc-600">${fmtH(new Date(spanEnd), tz)}</span>
                            </div>
                        </div>`;
                    }
                }

                let stripe = '';
                if (o.isDirect) {
                    const dur      = fmtDur(o.directEnd - o.directStart);
                    const timeStr  = fmtTimeRange(o.directStart, o.directEnd, tz);
                    const stripeTzLbl = tz ? tzAbbr(o.airport, o.directStart.toISOString()) : '';
                    const sCls    = isNow   ? 'bg-green-950/60 border-green-800/40 text-green-400'
                                  : isToday ? 'bg-sky-950/50 border-sky-800/30 text-sky-400'
                                  : 'bg-zinc-900 border-zinc-800/60 text-zinc-300';
                    stripe = `<div class="px-4 py-2.5 border-t ${sCls} flex items-center justify-between gap-2">
                        <span class="text-[11px] font-black uppercase tracking-wide">${dur} together</span>
                        <span class="text-[11px] font-mono opacity-60">${timeStr}${stripeTzLbl ? ` <span class="text-[9px] opacity-70">${stripeTzLbl}</span>` : ''}</span>
                    </div>`;
                } else if (!isPast) {
                    const nameA   = PILOT_NAMES[o.kA].split(' ')[0];
                    const nameB   = PILOT_NAMES[o.kB].split(' ')[0];
                    const gap     = fmtDur(o.gapMs);
                    const gapDesc = o.pA.end <= o.pB.start
                        ? `${nameA} leaves ${gap} before ${nameB} arrives`
                        : `${nameB} leaves ${gap} before ${nameA} arrives`;
                    stripe = `<div class="px-4 py-2.5 border-t border-amber-900/30 bg-amber-950/10 text-amber-500/80 text-[11px]">${gapDesc}</div>`;
                }

                // Tier 2 cards are slightly muted — dashed border, no glows
                const border  = tier === 2
                    ? (isNow ? 'border-blue-800/40' : 'border-zinc-700/60 border-dashed')
                    : (isNow ? 'border-green-700/50' : isToday ? 'border-sky-700/40' : isNear && !isPast ? 'border-amber-900/40' : 'border-zinc-800');
                const bg      = tier === 2 ? 'bg-zinc-900/20' : (isNow ? 'bg-green-950/20' : isToday ? 'bg-sky-950/15' : 'bg-zinc-900/40');
                const opacity = isPast ? 'opacity-40' : '';

                const _intelCnt = (_intelCounts[o.airport] || 0) + (o.airportB && o.airportB !== o.airport ? (_intelCounts[o.airportB] || 0) : 0);
                const intelBadge = _intelCnt > 0
                    ? `<button onclick="event.stopPropagation();openIntelForAirport('${o.airport}')" class="mx-4 mb-2.5 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-blue-400 hover:text-blue-300 transition-colors"><span class="intel-badge">${_intelCnt}</span><span>${_intelCnt === 1 ? 'crew tip' : 'crew tips'} for this area</span></button>`
                    : '';
                return `<div${scrollId} onclick="openOverlapDetail(${idx})" class="border ${border} rounded-2xl overflow-hidden ${bg} ${opacity} cursor-pointer active:scale-[0.99] transition-transform">
                    <div class="px-4 pt-3.5 pb-3">
                        <div class="text-[10px] font-black uppercase tracking-widest ${badgeCls} mb-1.5 flex items-center flex-wrap gap-1">${pulseDot}${dateLabel}${typeBadge}<span class="ml-auto text-zinc-700 text-[9px] font-normal">tap for details</span></div>
                        <div class="text-2xl font-black ${tier === 2 ? 'text-zinc-300' : 'text-white'} leading-none">${locLabel}${distTag}</div>
                        ${locSub ? `<div class="text-xs text-zinc-400 mt-1 font-mono tracking-wider">${locSub}</div>` : ''}
                    </div>
                    ${annotation}
                    <div class="px-4 pb-3 pt-2.5 space-y-2 border-t border-zinc-800/50">
                        ${pilotRows}
                    </div>
                    ${durationBar}
                    ${intelBadge}
                    ${stripe}
                </div>`;
            }

            // Render a secondary (tier 3) coincidence as a compact row, expandable for detail
            function renderSecondaryRow(o, idx) {
                const tzA = pilotUsesUtc(o.kA) ? (airportTz(o.airport)  || null) : null;
                const tzB = pilotUsesUtc(o.kB) ? (airportTz(o.airportB) || null) : null;
                const tz  = tzA || tzB || null;
                const refTime  = o.directStart || new Date(o.sortKey);
                const isPast   = localDateStr(refTime) < todayStr;
                const locLabel = locationLabel(o.airport, o.airportB);
                const locSub   = locationSub(o.airport, o.airportB);
                const cls      = o.classification;
                const nameA    = PILOT_NAMES[o.kA].split(' ')[0];
                const nameB    = PILOT_NAMES[o.kB].split(' ')[0];
                const colorA   = PILOT_COLORS[o.kA];
                const colorB   = PILOT_COLORS[o.kB];
                const refDay   = localDateStr(refTime);
                const dayLabel = refDay === todayStr ? 'Today' : refDay === tomorrowStr ? 'Tomorrow' : fmtDateShort(refTime);
                const distStr  = o.distMi > 0 ? `${o.distMi} mi apart` : '';
                const noteStr  = cls?.transitNote || distStr || cls?.label || '';
                const rowId    = `also-detail-${idx}`;


                return `<div class="border-b border-zinc-800/30 last:border-0 ${isPast ? 'opacity-30' : 'opacity-60'}">
                    <button onclick="document.getElementById('${rowId}').classList.toggle('hidden');this.querySelector('.sec-chevron').classList.toggle('rotate-180')" class="w-full flex items-center gap-3 py-2.5 text-left">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-1.5 flex-wrap">
                                <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${colorA}"></span>
                                <span class="text-[11px] font-black" style="color:${colorA}">${nameA}</span>
                                <span class="text-[10px] text-zinc-600">+</span>
                                <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${colorB}"></span>
                                <span class="text-[11px] font-black" style="color:${colorB}">${nameB}</span>
                                <span class="text-[10px] text-zinc-600 ml-1">·</span>
                                <span class="text-[11px] text-zinc-400 font-black truncate">${locLabel}${locSub ? ` <span class="text-zinc-600 font-mono font-normal">(${locSub})</span>` : ''}</span>
                            </div>
                            <div class="mt-1 space-y-0.5">
                                ${[{k: o.kA, p: o.pA, color: colorA, name: nameA}, {k: o.kB, p: o.pB, color: colorB, name: nameB}].map(({k, color, name, p}) => {
                                    const rowTz = pilotUsesUtc(k) ? (airportTz(p.airport) || null) : null;
                                    const rowTzLbl = tzAbbr(p.airport, p.start.toISOString());
                                    return `<div class="flex items-center gap-1.5">
                                        <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${color}"></span>
                                        <span class="text-[10px] font-black w-7 shrink-0" style="color:${color}">${name}</span>
                                        <span class="text-[10px] text-zinc-500 font-mono">${fmtTimeRange(p.start, p.end, rowTz)}${rowTzLbl ? ` <span class="text-[9px] text-zinc-600">${rowTzLbl}</span>` : ''}</span>
                                        ${fmtDur(p.end - p.start) ? `<span class="text-[10px] text-zinc-700 ml-1">${fmtDur(p.end - p.start)}</span>` : ''}
                                    </div>`;
                                }).join('')}
                                ${o.isDirect ? `<div class="text-[10px] text-zinc-600 pl-3">${fmtDur(o.directEnd - o.directStart)} overlap</div>` : o.gapMs > 0 ? `<div class="text-[10px] text-zinc-600 pl-3">${fmtDur(o.gapMs)} apart</div>` : ''}
                                ${noteStr ? `<div class="text-[10px] text-zinc-600 pl-3">${noteStr}</div>` : ''}
                            </div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0 self-start pt-0.5">
                            <span class="text-[10px] text-zinc-600">${dayLabel}</span>
                            <svg class="sec-chevron w-3 h-3 text-zinc-600 transition-transform duration-150" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"/></svg>
                        </div>
                    </button>
                    <div id="${rowId}" class="hidden pb-2 pt-1 pl-3 border-t border-zinc-800/20 space-y-1">
                        ${cls?.type ? `<div class="text-[10px] text-zinc-600 font-black uppercase tracking-widest">${cls.label}</div>` : ''}
                        ${cls?.transitNote ? `<div class="text-[10px] text-zinc-600">${cls.transitNote}</div>` : ''}
                        ${o.distMi > 0 ? `<div class="text-[10px] text-zinc-600">${o.distMi} mi apart</div>` : ''}
                        ${o.isDirect ? `<div class="text-[10px] text-zinc-600">${fmtDur(o.directEnd - o.directStart)} direct window · ${fmtH(o.directStart, tz)}–${fmtH(o.directEnd, tz)}</div>` : o.gapMs > 0 ? `<div class="text-[10px] text-zinc-600">${fmtDur(o.gapMs)} apart in time</div>` : ''}
                    </div>
                </div>`;
            }

            const recentSec = secondary.filter(o => {
                const endTime = o.isDirect
                    ? (o.directEnd?.getTime() ?? 0)
                    : Math.max(o.pA.end.getTime(), o.pB.end.getTime());
                return endTime >= now.getTime() - 72 * 3600000; // show up to 3 days past
            });

            // When signed in, split into "Your Crossings" and "Other Crew Crossings"
            const involvesMyPilot = o => myPilot && (o.kA === myPilot || o.kB === myPilot);
            const myPrimary    = myPilot ? primary.filter(involvesMyPilot)    : primary;
            const otherPrimary = myPilot ? primary.filter(o => !involvesMyPilot(o)) : [];
            const mySec        = myPilot ? recentSec.filter(involvesMyPilot)  : recentSec;
            const otherSec     = myPilot ? recentSec.filter(o => !involvesMyPilot(o)) : [];

            const myFirstName  = myPilot ? (PILOT_NAMES[myPilot] || '').split(' ')[0] : '';

            const noneMsg = !myPilot && primary.length === 0
                ? `<div class="text-center py-12 text-zinc-500 text-sm">No crew crossings found — everyone's going different directions.</div>`
                : myPilot && myPrimary.length === 0
                ? `<div class="py-6 px-1 text-zinc-500 text-sm">No upcoming crossings for ${myFirstName} — you're flying solo this stretch.</div>`
                : '';

            const myHeader = myPilot && myPrimary.length > 0
                ? `<div class="text-[10px] font-black uppercase tracking-widest text-zinc-500 px-1 mb-2">Your Crossings</div>` : '';
            _overlapData = [...myPrimary, ...otherPrimary];
            const myCards     = myHeader + myPrimary.map((o, idx) => renderPrimaryCard(o, idx, idx === scrollTargetIdx)).join('');
            const otherCards  = otherPrimary.map((o, idx) => renderPrimaryCard(o, myPrimary.length + idx, false)).join('');

            const mySecHtml = mySec.length > 0
                ? `<div class="mt-4 rounded-xl border border-zinc-800/40 overflow-hidden">
                    <button onclick="const b=this.nextElementSibling;const arr=this.querySelector('.an-arr');b.classList.toggle('hidden');arr.textContent=b.classList.contains('hidden')?'›':'‹';" class="w-full px-4 py-2.5 flex items-center gap-2 text-left">
                        <span class="an-arr text-zinc-600 text-xs">›</span>
                        <span class="text-[10px] font-black uppercase tracking-widest text-zinc-500">Also Nearby</span>
                        <span class="text-[10px] text-zinc-600 ml-1">${mySec.length} location${mySec.length !== 1 ? 's' : ''}</span>
                    </button>
                    <div class="hidden border-t border-zinc-800/40">
                        <div class="px-4">${mySec.map((o, i) => renderSecondaryRow(o, i)).join('')}</div>
                    </div>
                </div>` : '';

            const otherSecHtml = otherSec.length > 0
                ? `<div class="px-4">${otherSec.map((o, i) => renderSecondaryRow(o, mySec.length + i)).join('')}</div>` : '';

            const otherCrewHtml = myPilot && (otherPrimary.length > 0 || otherSec.length > 0)
                ? `<div class="mt-6 rounded-xl border border-zinc-800/30 overflow-hidden">
                    <button onclick="const b=this.nextElementSibling;const arr=this.querySelector('.oc-arr');b.classList.toggle('hidden');arr.textContent=b.classList.contains('hidden')?'›':'‹';" class="w-full px-4 py-2.5 flex items-center gap-2 text-left">
                        <span class="oc-arr text-zinc-600 text-xs">›</span>
                        <span class="text-[10px] font-black uppercase tracking-widest text-zinc-600">Other Crew Crossings</span>
                        <span class="text-[10px] text-zinc-700 ml-1">${otherPrimary.length > 0 ? `${otherPrimary.length} crossing${otherPrimary.length > 1 ? 's' : ''}` : ''}</span>
                    </button>
                    <div class="hidden border-t border-zinc-800/30">
                        <div class="p-3 space-y-3">${otherCards}</div>
                        ${otherSec.length > 0 ? `<div class="rounded-xl border border-zinc-800/40 overflow-hidden mx-3 mb-3">
                            <div class="px-4 py-2.5 border-b border-zinc-800/40"><span class="text-[10px] font-black uppercase tracking-widest text-zinc-600">Also Nearby</span></div>
                            ${otherSecHtml}
                        </div>` : ''}
                    </div>
                </div>` : '';

            const primaryHtml  = myPilot
                ? (myPrimary.length > 0 ? myCards : '') + mySecHtml
                : myCards + mySecHtml;
            const secondaryHtml = myPilot ? otherCrewHtml : '';

            container.innerHTML = noneMsg + primaryHtml + secondaryHtml;

            if (scrollTargetIdx >= 0) {
                requestAnimationFrame(() => scrollToOverlapCard(scrollTargetIdx));
            }

            return filtered;
        }

        function scrollToOverlapCard(idx) {
            const target = document.getElementById(`overlap-card-${idx}`);
            const view   = document.getElementById('view-overlap');
            const header = document.getElementById('overlap-header');
            if (target && view) {
                const headerH = header ? header.getBoundingClientRect().height : 0;
                const viewRect = view.getBoundingClientRect();
                const targetRect = target.getBoundingClientRect();
                view.scrollTop += targetRect.top - viewRect.top - headerH - 12;
            }
        }

