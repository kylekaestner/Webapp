        // Shown once per day (localStorage-deduped) when a NetJets pilot is on-duty today with no
        // tail saved for this tour -- the server also sends a push the night before (same reason:
        // a leg flown before the tail is saved can't be recovered after the fact, SWIM has no
        // backlog to replay), this is the client-side companion for whenever they actually open
        // the app that day.
        // Fires the evening before Day 1 too, not just Day 1 itself -- confirmed directly as the
        // preferred timing (matches the server's own night-before push notification exactly,
        // rather than spreading the nudge across several days before a tour the pilot may not be
        // thinking about yet). Still also fires ON Day 1 as a second chance if the evening-before
        // nudge was dismissed or missed. Routes straight to the dedicated tour modal now, not My
        // Info (raised directly: "going into the my info each tour isn't the best way to do it").
        function _maybeShowNetjetsTailReminder(pilotKey, data) {
            if (data?.parser_type !== 'manual_netjets') return;
            const todayStr = _todayLocalDateStr();
            const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`;
            const tourStartToday = _tourStartDateFor(pilotKey, todayStr);
            const tourStartTomorrow = _tourStartDateFor(pilotKey, tomorrowStr);
            // Prefer the evening-before case (tomorrow IS a tour's day 1) over today-is-day-1,
            // since that's the one actually relevant to "tonight" if both somehow matched.
            // Mid-tour counts too: with no tail saved, nothing on this tour is being tracked at all
            // (no legs, no crossings) -- the tail is the one thing the whole NetJets model hangs on.
            const tourStart = (tourStartTomorrow === tomorrowStr && !_tourTailFor(pilotKey, tourStartTomorrow)) ? tourStartTomorrow
                : tourStartToday;
            if (!tourStart) return;
            if (_tourTailFor(pilotKey, tourStart)) return;
            const dedupKey = `cs_netjets_tail_nudge_${pilotKey}_${tourStart}_${todayStr}`;
            try { if (localStorage.getItem(dedupKey)) return; } catch (_) {}
            _netjetsReminderTourStart = tourStart;
            const titleEl = document.getElementById('netjets-tail-reminder-title');
            if (titleEl) titleEl.textContent = (tourStart === todayStr) ? 'Tour Starts Today'
                : (tourStart === tomorrowStr) ? 'Tour Starts Tomorrow' : 'No Tail Set — Not Tracking';
            const modal = document.getElementById('netjets-tail-reminder-modal');
            if (modal) modal.classList.remove('hidden');
            try { localStorage.setItem(dedupKey, '1'); } catch (_) {}
        }
        let _netjetsReminderTourStart = null;
        // A pilot's last leg can't be replaced automatically unless it was refiled (_isLastLegRefile() in
        // server.js), and until it is, every later leg stays off their schedule as another crew's.
        // Only they know if they're still on the aircraft. Once a day per leg until they pick.
        let _netjetsLastLegTourStart = null;
        function _netjetsDeadLastLeg(pilotKey, data, tourStart) {
            const lastLegId = (data?.tour_tails || []).find(t => t.tour_start_date === tourStart)?.last_leg_id;
            const leg = lastLegId ? (data?.segments || []).find(s => s.id === lastLegId) : null;
            return leg && !leg.auto_leg_complete && [1, 3].includes(leg.auto_leg_cancelled) ? leg : null;
        }
        function _maybeShowNetjetsLastLegAlert(pilotKey, data) {
            if (data?.parser_type !== 'manual_netjets') return;
            const todayStr = _todayLocalDateStr();
            const tourStart = _tourStartDateFor(pilotKey, todayStr);
            const leg = tourStart ? _netjetsDeadLastLeg(pilotKey, data, tourStart) : null;
            if (!leg) return;
            const dedupKey = `cs_netjets_last_leg_${pilotKey}_${leg.id}_${todayStr}`;
            try { if (localStorage.getItem(dedupKey)) return; } catch (_) {}
            _netjetsLastLegTourStart = tourStart;
            const deleted = leg.auto_leg_cancelled === 3;
            const route = `${aptLabel(leg.departure_airport, pilotKey)} → ${aptLabel(leg.arrival_airport, pilotKey)}`;
            document.getElementById('netjets-last-leg-title').textContent = deleted ? 'Last Leg Deleted' : 'Last Leg Cancelled';
            document.getElementById('netjets-last-leg-body').textContent = `${route} was your last leg on this aircraft and it ${deleted ? 'was deleted' : 'was cancelled'}. Legs after it stay off your schedule until you pick a new last leg.`;
            document.getElementById('netjets-last-leg-modal')?.classList.remove('hidden');
            try { localStorage.setItem(dedupKey, '1'); } catch (_) {}
        }
        function dismissNetjetsLastLegAlert() {
            document.getElementById('netjets-last-leg-modal')?.classList.add('hidden');
        }
        function _openTourFromLastLegAlert() {
            dismissNetjetsLastLegAlert();
            if (_netjetsLastLegTourStart) openNetjetsTourModal(_netjetsLastLegTourStart);
        }
        function dismissNetjetsTailReminder() {
            document.getElementById('netjets-tail-reminder-modal')?.classList.add('hidden');
        }
        function _openMyInfoFromNetjetsReminder() {
            dismissNetjetsTailReminder();
            if (_netjetsReminderTourStart) openNetjetsTourModal(_netjetsReminderTourStart);
            else openEditMyInfoModal(); // fallback, shouldn't normally happen
        }

        // NetJets-style manual tracking (parser_type 'manual_netjets', no feed exists). History-
        // preserving like resolveBaseAt above -- walk forward, keep the last entry still <= the
        // target date, since a pilot's rotation cadence itself can change over time and a past
        // date must resolve against whatever cadence was actually in effect then.
        function _resolveRotationRowAt(rotationHistory, dateStr) {
            if (!rotationHistory || !rotationHistory.length) return null;
            let resolved = null;
            for (const r of rotationHistory) {
                if (r.effective_from <= dateStr) resolved = r;
                else break;
            }
            return resolved;
        }
        // A days_on=0 row marks the rotation as ended from its effective_from (saved when the
        // pilot switches onto a CC schedule) -- "no rotation" from then on, history before it intact.
        function _resolveRotationAt(rotationHistory, dateStr) {
            const r = _resolveRotationRowAt(rotationHistory, dateStr);
            return r && r.days_on > 0 ? r : null;
        }

        // Given a resolved rotation (anchor_date + days_on/days_off), is dateStr an on-duty day?
        // Modular arithmetic off the anchor -- the ((x % n) + n) % n form handles dates before the
        // anchor too (a negative JS modulo result), not just dates after it.
        // Checks every stored seam row for this pilot (normally at most one applies to a given
        // date) and returns 1 (on-duty) / 0 (off-duty) from the real transition table if dateStr
        // falls inside that 28-day window, or null if none applies / data not loaded yet --
        // callers fall back to the normal rotation formula on null.
        function _seamOverrideFor(pilotKey, dateStr) {
            if (!_seamTables) return null;
            const seams = pilotsCache[pilotKey]?.rotation_seams;
            if (!seams || !seams.length) return null;
            const row = _resolveRotationRowAt(pilotsCache[pilotKey]?.rotation_history, dateStr);
            if (row && !(row.days_on > 0)) return null; // rotation ended (switched to CC)
            for (const s of seams) {
                const windowStart = new Date(s.window_start_date + 'T12:00:00');
                const d = new Date(dateStr + 'T12:00:00');
                const dayIndex = Math.round((d - windowStart) / 86400000);
                if (dayIndex < 0 || dayIndex > 27) continue;
                const arr = _seamTables[s.table_letter]?.[s.from_key]?.[s.to_key];
                if (arr) return arr[dayIndex];
            }
            return null;
        }

        // Highest-precedence signal of all -- an explicit CC-schedule day record is literally what
        // NetJets says happened that day (pasted from the pilot's own monthly email), not an
        // inference from any formula. 'X' = on-duty; anything else (OFF, P<n> PTO) = off-duty.
        function _ccScheduleOverrideFor(pilotKey, dateStr) {
            const info = _ccDayInfo(pilotKey, dateStr);
            return info ? (info.kind === 'duty' ? 1 : 0) : null;
        }
        // The CC code on file for a day (ccCodeInfo: code, kind, label, desc), or null. Indexed once per
        // list, since the grid asks for every day.
        const _ccDayIndex = new WeakMap();
        function _ccDayInfo(pilotKey, dateStr) {
            const days = pilotsCache[pilotKey]?.cc_schedule_days;
            if (!days || !days.length) return null;
            let idx = _ccDayIndex.get(days);
            if (!idx) { idx = new Map(days.map(d => [d.date, d.status])); _ccDayIndex.set(days, idx); }
            return idx.has(dateStr) ? ccCodeInfo(idx.get(dateStr)) : null;
        }
        // Training, travel and office days: working, so not off, but not on tour either.
        function _ccWorkingNotTour(pilotKey, dateStr) {
            const k = _ccDayInfo(pilotKey, dateStr)?.kind;
            return k === 'training' || k === 'travel' || k === 'office';
        }
        // The tag for a NetJets day whose CC code says more than ON TOUR / OFF (TRAINING, PTO, VAC...), or null.
        function _ccStatusTag(pilotKey, dateStr) {
            const info = pilotsCache[pilotKey]?.parser_type === 'manual_netjets' ? _ccDayInfo(pilotKey, dateStr) : null;
            if (!info || info.code === 'X' || info.code === 'OFF') return null;
            if (info.kind === 'duty') return null;
            return info;
        }

        // NetJets pilots are home-based and airline home on the last day of every tour, a commute
        // they rarely log -- so the airline rule ("no later flight logged: still at the last arrival
        // airport") parked them at their last tour airport for the whole week off (false Crossings
        // there, missed Home Turf ones at home). Auto-commute, same 3h rule as an airline commuter
        // landing at base: home starts 3h after the last leg lands on the tour's last day (midnight
        // if that day has no legs), through the end of the off-duty run. Real instants (flagged
        // absolute so adjustedPeriod leaves them alone). Used by Crossings and the here-now pin.
        function _netjetsOffDutyDates(pilotKey, fromDateStr, days) {
            const data = pilotsCache[pilotKey];
            const flown = new Set((data?.segments || [])
                .filter(s => s.type === 'flight' && s.departure_time && !s.auto_leg_cancelled)
                .map(s => flightLocalDate(s.departure_time, s.departure_airport) || s.departure_time.slice(0, 10)));
            const out = [];
            const d = new Date(fromDateStr + 'T12:00:00');
            for (let i = 0; i < days; i++, d.setDate(d.getDate() + 1)) {
                const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (!_isNetJetsOnDuty(pilotKey, ds) && !_ccWorkingNotTour(pilotKey, ds) && !flown.has(ds)) out.push(ds);
            }
            return out;
        }
        function _netjetsHomeWindows(pilotKey) {
            const data = pilotsCache[pilotKey];
            if (data?.parser_type !== 'manual_netjets') return null;
            const homeC = normApt(data.home_airport || PILOT_HOME[pilotKey] || data.base || '');
            const tz = homeC && airportTz(homeC);
            // No rotation/CC configured -> nothing says when they're off; leave the airline rules.
            if (!tz || !((data.rotation_history || []).length || (data.cc_schedule_days || []).length)) return null;
            const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const shift = (ds, n) => { const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
            const offDates = _netjetsOffDutyDates(pilotKey, ymd(new Date(Date.now() - 14 * 86400000)), 14 + 90);
            const midnight = ds => localTimeToUTC(`${ds}T00:00:00`, tz);
            const legs = (data.segments || []).filter(s => s.type === 'flight' && s.departure_time && s.arrival_time && !s.auto_leg_cancelled);
            const windows = [];
            for (const ds of offDates) {
                const last = windows[windows.length - 1];
                if (last && last.endDs === ds) { last.endDs = shift(ds, 1); continue; }
                windows.push({ startDs: ds, endDs: shift(ds, 1) });
            }
            return {
                homeC,
                windows: windows.map(w => {
                    // Auto-commute: 3h after the last leg landing on the tour's last day
                    const lastDay = shift(w.startDs, -1);
                    const lastArr = legs
                        .filter(s => (flightLocalDate(s.departure_time, s.departure_airport) || s.departure_time.slice(0, 10)) === lastDay)
                        .map(s => flightUTCTime(s.arrival_time, s.arrival_airport))
                        .filter(d => d && !isNaN(d))
                        .sort((a, b) => b - a)[0];
                    const start = lastArr ? new Date(lastArr.getTime() + 3 * 3600000) : midnight(w.startDs);
                    return { start, end: midnight(w.endDs) };
                }),
            };
        }
        function _netjetsHomeOnOffDays(pilotKey, periods) {
            const hw = _netjetsHomeWindows(pilotKey);
            if (!hw) return periods;
            // An away stay with no later leg departing it is the airline "still there until the next
            // logged flight" rule. Up to now that's backed by tracking (the tail is watched all tour,
            // so if it had flown there'd be a leg), but NetJets only files ~18h ahead -- past that the
            // pilot's location is genuinely unknown, so the stay is cut there rather than assumed.
            const deps = (pilotsCache[pilotKey]?.segments || [])
                .filter(s => s.departure_time && s.departure_airport && !s.auto_leg_cancelled)
                // Both readings: buildGroundPeriods uses new Date() (browser-local for a hand-edited
                // row stored without Z), flightUTCTime the airport-correct one.
                .flatMap(s => [new Date(s.departure_time).getTime(), flightUTCTime(s.departure_time, s.departure_airport)?.getTime()]
                    .map(t => ({ apt: normApt(s.departure_airport), t })));
            const horizon = 18 * 3600000;
            let out = periods.map(p => {
                if (p.airport === hw.homeC) return { ...p };
                const endsOnDeparture = deps.some(d => d.apt === p.airport && d.t && Math.abs(d.t - p.end.getTime()) < 60000);
                if (endsOnDeparture) return { ...p };
                const cap = new Date(Math.max(Date.now(), p.start.getTime()) + horizon);
                return { ...p, end: p.end > cap ? cap : p.end };
            });
            for (const w of hw.windows) {
                out = out.filter(p => {
                    if (p.airport === hw.homeC) return true;
                    if (p.start < w.start && p.end > w.start) p.end = w.start; // away stay running into time off: cut at the commute
                    return !(p.start >= w.start && p.start < w.end);           // nothing away starts during time off
                });
                out.push({ airport: hw.homeC, start: w.start, end: w.end, absolute: true });
            }
            return out;
        }
        // Here-now: home airport if right now falls in one of this NetJets pilot's home windows.
        function _netjetsOffDutyHome(pilotKey) {
            const hw = _netjetsHomeWindows(pilotKey);
            if (!hw) return null;
            const now = Date.now();
            return hw.windows.some(w => w.start.getTime() <= now && now < w.end.getTime()) ? hw.homeC : null;
        }

        // Voluntary extension day (pilot stayed on past the tour's last day) -> the tour it extends.
        function _tourExtensionFor(pilotKey, dateStr) {
            return (pilotsCache[pilotKey]?.tour_extensions || []).find(e => e.date === dateStr)?.tour_start_date || null;
        }
        // Last day of the tour starting tourStart: walks forward while each day still resolves to
        // this tour (rotation, CC run, seam, extensions).
        function _tourEndDateFor(pilotKey, tourStart) {
            let end = tourStart;
            const d = new Date(tourStart + 'T12:00:00');
            for (let i = 0; i < 45; i++) {
                d.setDate(d.getDate() + 1);
                const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (_tourStartDateFor(pilotKey, ds) !== tourStart) break;
                end = ds;
            }
            return end;
        }

        function _isNetJetsOnDuty(pilotKey, dateStr) {
            if (_tourExtensionFor(pilotKey, dateStr)) return true; // set explicitly -- highest precedence
            const cc = _ccScheduleOverrideFor(pilotKey, dateStr);
            if (cc !== null) return !!cc;
            const seam = _seamOverrideFor(pilotKey, dateStr);
            if (seam !== null) return !!seam;
            return _tourStartDateFor(pilotKey, dateStr) !== null;
        }

        // Line 1's first on-duty day, confirmed directly from the real line-visualizer tool's own
        // source (same reference date used for both the 7&7 and 8&6 families there -- only
        // days_on/days_off differ by family, not this anchor). Line N = this date + (N-1) days.
        // Purely a phase reference for the modular math below -- NOT a real "this rotation became
        // effective in 2021" date, so callers must set their own effectiveFrom separately.
        const _LINE_REFERENCE_DATE = '2021-12-24';
        function _lineToAnchorDate(lineNum) {
            const ref = new Date(_LINE_REFERENCE_DATE + 'T12:00:00');
            const d = new Date(ref.getTime() + (lineNum - 1) * 86400000);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
        // Inverse of _lineToAnchorDate -- exact, not a guess, since manual date entry no longer
        // exists as an alternate path (removed per explicit request: "the old day off and on
        // should just go away"), so every stored anchor_date was produced by this same formula.
        // Returns null for anything outside 1-14 (shouldn't happen, but don't silently mis-map).
        function _anchorDateToLine(anchorDate) {
            if (!anchorDate) return null;
            const ref = new Date(_LINE_REFERENCE_DATE + 'T12:00:00');
            const d = new Date(anchorDate + 'T12:00:00');
            const lineNum = Math.round((d - ref) / 86400000) + 1;
            return (lineNum >= 1 && lineNum <= 14) ? lineNum : null;
        }

        // Shared by the grid/list/day-detail default-status fallback -- a day with no logged
        // flight/reserve/vacation/hard-off segment defaults to "OFF" for everyone except Kyle
        // (whose default has always been "assumed on-call"); a NetJets pilot gets that same
        // assumed-on-call default on any day their saved rotation says they're on duty. Lowest
        // precedence in all three call sites -- any real logged segment still overrides it.
        function _pilotOnDutyDefault(pilotKey, dateKey) {
            return pilotKey === 'kyle' || (pilotsCache[pilotKey]?.parser_type === 'manual_netjets' && _isNetJetsOnDuty(pilotKey, dateKey));
        }
        // Kyle's assumed-on-call default and a NetJets pilot's rotation-on-duty default are the
        // same PRECEDENCE (lowest -- any real logged segment overrides either), but not the same
        // real-world meaning -- a NetJets pilot on a tour day isn't waiting for a call, they're on
        // a scheduled rotation. Separate label so the two don't read identically.
        function _onDutyDefaultLabel(pilotKey) {
            return pilotsCache[pilotKey]?.parser_type === 'manual_netjets' ? 'ON TOUR' : 'ON CALL';
        }

        // Null if off-duty (or no rotation configured) on dateStr; otherwise the calendar date
        // (YYYY-MM-DD) of day 1 of the on-duty tour containing dateStr -- the key used to look up
        // / save that tour's tail in pilot_tour_tail.
        function _tourStartDateFor(pilotKey, dateStr) {
            const ext = _tourExtensionFor(pilotKey, dateStr);
            if (ext) return ext;
            // CC day records win over the formula (same as _isNetJetsOnDuty) -- a CC "tour" is a
            // run of consecutive X days, starting at its first X. Mirrors _netjetsTourStartServer.
            const ccDays = pilotsCache[pilotKey]?.cc_schedule_days;
            if (ccDays && ccDays.length) {
                const cc = new Map(ccDays.map(d => [d.date, d.status]));
                const duty = d => cc.has(d) && ccCodeInfo(cc.get(d)).kind === 'duty';
                if (cc.has(dateStr)) {
                    if (!duty(dateStr)) return null;
                    let start = dateStr;
                    for (;;) {
                        const p = new Date(start + 'T12:00:00');
                        p.setDate(p.getDate() - 1);
                        const prev = `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
                        if (!duty(prev)) break;
                        start = prev;
                    }
                    return start;
                }
            }
            const rotation = _resolveRotationAt(pilotsCache[pilotKey]?.rotation_history, dateStr);
            if (!rotation) return null;
            const period = rotation.days_on + rotation.days_off;
            if (period <= 0) return null;
            const anchor = new Date(rotation.anchor_date + 'T12:00:00');
            const d = new Date(dateStr + 'T12:00:00');
            const daysSince = Math.round((d - anchor) / 86400000);
            const cyclePos = ((daysSince % period) + period) % period;
            if (cyclePos >= rotation.days_on) return null;
            const tourStartOffset = daysSince - cyclePos;
            const start = new Date(anchor.getTime() + tourStartOffset * 86400000);
            const _pad = n => String(n).padStart(2, '0');
            return `${start.getFullYear()}-${_pad(start.getMonth() + 1)}-${_pad(start.getDate())}`;
        }

        // The tail already saved for a given tour (keyed by that tour's own start date), or null.
        function _tourTailFor(pilotKey, tourStartDate) {
            if (!tourStartDate) return null;
            const row = (pilotsCache[pilotKey]?.tour_tails || []).find(t => t.tour_start_date === tourStartDate);
            return row ? row.tail : null;
        }
        function _tourStartAirportFor(pilotKey, tourStartDate) {
            if (!tourStartDate) return null;
            const row = (pilotsCache[pilotKey]?.tour_tails || []).find(t => t.tour_start_date === tourStartDate);
            return row ? (row.start_airport || null) : null;
        }

        // Shared by renderCommonOffSection/renderOffDayCalendar/showOffDayDetail's per-pilot "is
        // this day off" check -- a NetJets pilot with no rotation set up yet falls straight back
        // to pure segment-based (_isNetJetsOnDuty returns false with no rotation_history), same as
        // any other pilot; one a rotation covers is "off" only when NEITHER a real logged segment
        // NOR the rotation itself says they're working that day.
        function _isOffDutyGeneric(pilotKey, dateStr, pilotFlyingDates) {
            const flying = pilotFlyingDates[pilotKey]?.has(dateStr) || _isNetJetsOnDuty(pilotKey, dateStr) || _ccWorkingNotTour(pilotKey, dateStr);
            return !flying;
        }

