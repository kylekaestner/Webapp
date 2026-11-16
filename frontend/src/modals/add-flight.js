        // ── Add Flight ──────────────────────────────────────────────────
        let _addFlightType = 'work';
        let _editSegmentId = null;

        // The tour's tail/EJA flight # only belong on a Work leg -- a DH, commute or personal flight
        // is an airline flight with its own number. Cleared on switching away (only if still the
        // untouched pre-fill), restored on switching back to Work for a new flight.
        var _addFlightNjPrefill = null; // var: setAddFlightType may run before this line during startup
        function _applyNetjetsPrefill(type) {
            if (!_addFlightNjPrefill || _editSegmentId !== null) return;
            const tailEl = document.getElementById('add-tail-num'), fnEl = document.getElementById('add-flight-num');
            if (type === 'work') {
                if (!tailEl.value) tailEl.value = _addFlightNjPrefill.tail;
                if (!fnEl.value) fnEl.value = _addFlightNjPrefill.fn;
            } else {
                if (tailEl.value === _addFlightNjPrefill.tail) tailEl.value = '';
                if (fnEl.value === _addFlightNjPrefill.fn) fnEl.value = '';
            }
        }
        function setAddFlightType(type) {
            _addFlightType = type;
            _applyNetjetsPrefill(type);
            const colors    = { work: 'bg-blue-600 text-white', dh: 'bg-pink-700 text-white', commute: 'bg-amber-600 text-white', personal: 'bg-violet-600 text-white', training: 'bg-orange-600 text-white', vacation: 'bg-teal-600 text-white' };
            const accentHex = { work: '#3b82f6', dh: '#be185d', commute: '#d97706', personal: '#7c3aed', training: '#f97316', vacation: '#14b8a6' };
            ['work', 'dh', 'commute', 'personal', 'training', 'vacation'].forEach(t => {
                const btn = document.getElementById(`ftype-${t}`);
                if (!btn) return;
                btn.className = btn.className.replace(/bg-\S+ text-white/g, '').trim();
                if (t === type) btn.className += ' ' + colors[t];
                btn.classList.toggle('text-zinc-500', t !== type);
            });
            const bar = document.getElementById('add-flight-accent-bar');
            if (bar) { const c = accentHex[type] || '#3b82f6'; bar.style.background = `linear-gradient(90deg,${c},${c}44,transparent)`; }

            const isDateOnly = type === 'vacation' || type === 'training';
            const flightFields = document.getElementById('add-flight-only-fields');
            if (flightFields) flightFields.style.display = isDateOnly ? 'none' : '';
            const trainingLoc = document.getElementById('add-training-location-row');
            if (trainingLoc) trainingLoc.classList.toggle('hidden', type !== 'training');

            const title = document.getElementById('add-flight-title');
            if (title) title.textContent = type === 'vacation' ? (_editSegmentId ? 'Edit Vacation' : 'Add Vacation') : type === 'training' ? (_editSegmentId ? 'Edit Training' : 'Add Training') : (_editSegmentId ? 'Edit Flight' : 'Add Flight');
            const btn = document.getElementById('add-flight-submit-btn');
            if (btn) btn.textContent = type === 'vacation' ? (_editSegmentId ? 'Save Vacation' : 'Add Vacation') : type === 'training' ? (_editSegmentId ? 'Save Training' : 'Add Training') : (_editSegmentId ? 'Save Changes' : 'Add Flight');
        }

let _blockUserEdited = false;

        // Block totals (anyone's choice, per device). Worked legs only: no deadheads, commutes, personal
        // or cancelled legs. A leg counts on its departure day, so a red-eye isn't counted twice.
        var _blockTotalsOn = false;
        try { _blockTotalsOn = localStorage.getItem('cs_block_totals') === '1'; } catch (_) {}
        function _canSeeBlockTotals() { return !isDemo; }
        function _showBlockTotals() { return _blockTotalsOn && _canSeeBlockTotals(); }
        function _refreshBlockProfileRow() {
            const btn = document.getElementById('profile-block-btn');
            document.getElementById('profile-block-section')?.classList.toggle('hidden', !_canSeeBlockTotals());
            if (!btn) return;
            btn.textContent = _blockTotalsOn ? 'On' : 'Off';
            btn.className = 'px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wide transition-colors ' +
                (_blockTotalsOn ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30' : 'bg-zinc-700/40 text-zinc-400 border border-zinc-600/40');
        }
        function toggleBlockTotals() {
            _blockTotalsOn = !_blockTotalsOn;
            try { localStorage.setItem('cs_block_totals', _blockTotalsOn ? '1' : '0'); } catch (_) {}
            _refreshBlockProfileRow();
            render();
        }
        // One pass over the pilot's segments: { 'YYYY-MM-DD': minutes }. Built once per render, not per day.
        function _blockByDay() {
            const byDay = new Map();
            for (const s of segments) {
                if (s.type !== 'flight' || !s.departureTime || s.cancelled || s.dh || s.trip === 'PERSONAL' || s.trip === 'COMMUTE') continue;
                const mins = calcBlockMins(s);
                if (!(mins > 0)) continue;
                const day = flightLocalDate(s.departureTime, s.departureAirport);
                byDay.set(day, (byDay.get(day) || 0) + mins);
            }
            return byDay;
        }
        function _tourBlockMins(byDay, tourStart, tourEnd) {
            let total = 0;
            for (const [day, mins] of byDay) if (day >= tourStart && day <= tourEnd) total += mins;
            return total;
        }
        // { day, tourStart, tourEnd, tour } for one calendar day. tourEnds memoizes across a render.
        function _blockTotalsFor(byDay, dateKey, tourEnds) {
            const tourStart = pilotsCache[currentPilot]?.parser_type === 'manual_netjets' ? _tourStartDateFor(currentPilot, dateKey) : null;
            const tourEnd = tourStart ? (tourEnds[tourStart] ||= _tourEndDateFor(currentPilot, tourStart)) : null;
            return { day: byDay.get(dateKey) || 0, tourEnd, tour: tourStart ? _tourBlockMins(byDay, tourStart, tourEnd) : 0 };
        }

        function calcBlockMins(f) {
            if (f.blockMinutes != null) return f.blockMinutes;
            if (!f.departureTime || !f.arrivalTime) return null;
            if (f.isManual) {
                const depTz = airportTz(f.departureAirport);
                const arrTz = airportTz(f.arrivalAirport);
                if (depTz && arrTz) {
                    try {
                        const depUTC = localTimeToUTC(f.departureTime.slice(0, 16), depTz);
                        const arrUTC = localTimeToUTC(f.arrivalTime.slice(0, 16), arrTz);
                        const m = Math.round((arrUTC - depUTC) / 60000);
                        return (m > 0 && m < 24 * 60) ? m : null;
                    } catch (e) { /* fall through */ }
                }
            }
            return Math.round((new Date(f.arrivalTime) - new Date(f.departureTime)) / 60000);
        }

        function localTimeToUTC(localISO, tzName) {
            const memoKey = tzName + '|' + localISO;
            const memo = _utcMemo.get(memoKey);
            if (memo !== undefined) return new Date(memo);
            const approx = new Date(localISO + 'Z');
            let fmt = _tzOffsetFmts.get(tzName);
            if (!fmt) {
                fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzName, timeZoneName: 'longOffset' });
                _tzOffsetFmts.set(tzName, fmt);
            }
            const offsetAt = d => {
                const parts = fmt.formatToParts(d);
                const m = (parts.find(p => p.type === 'timeZoneName')?.value || '').match(/GMT([+-])(\d+):(\d{2})/);
                return m ? (m[1] === '+' ? 1 : -1) * (parseInt(m[2]) * 60 + parseInt(m[3])) : null;
            };
            const first = offsetAt(approx);
            if (first == null) return approx;
            // Second pass with the offset at the corrected instant: the first guess reads the offset
            // a few hours away from the real moment, so on a DST-change day a time shortly after
            // the switch came out an hour off (Nov 1 3:00 AM CST converted as 2:00 AM).
            const second = offsetAt(new Date(approx.getTime() - first * 60000));
            const utcMs = approx.getTime() - (second ?? first) * 60000;
            _utcMemo.set(memoKey, utcMs);
            return new Date(utcMs);
        }

        // Returns the local calendar date (YYYY-MM-DD) of a flight time at its airport.
        // Non-Z strings already encode the local date — use the prefix directly.
        // Only apply timezone conversion for UTC (Z-suffixed) strings.
        function flightLocalDate(isoStr, airportCode) {
            if (!isoStr) return '';
            try {
                const d = new Date(isoStr);
                if (isNaN(d.getTime())) return isoStr.substring(0, 10);
                if ((isoStr.endsWith('Z') || isoStr.endsWith('z')) && airportCode) {
                    const tz = airportTz(airportCode);
                    if (tz) {
                        let fmt = _tzDateFmts.get(tz);
                        if (!fmt) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz }); _tzDateFmts.set(tz, fmt); }
                        return fmt.format(d);
                    }
                }
                return isoStr.substring(0, 10);
            } catch(e) { return isoStr.substring(0, 10); }
        }

        // Returns a proper UTC Date for a flight time, accounting for airport timezone.
        // Times ending in Z are already UTC. Local times (Adam/Sam/Logan) are converted
        // using the airport's IANA timezone so browser timezone doesn't corrupt comparisons.
        function flightUTCTime(isoStr, airportCode) {
            if (!isoStr) return null;
            if (isoStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(isoStr)) return new Date(isoStr);
            const tz = airportTz(airportCode);
            if (tz) {
                try { return localTimeToUTC(isoStr.slice(0, 16), tz); } catch(e) {}
            }
            return new Date(isoStr); // fallback: browser-local (old behavior)
        }

        function parseBlockInput(val) {
            if (!val) return null;
            const m = val.match(/^(\d+):(\d{2})$/);
            if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
            // A bare whole number of 20+ means minutes, not hours -- James typed "30" for a
            // 35-minute leg and it saved as a 30-hour block. "1.5" / "2" still mean hours.
            if (/^\d+$/.test(val.trim()) && parseInt(val) >= 20) return parseInt(val);
            const h = parseFloat(val);
            return isNaN(h) ? null : Math.round(h * 60);
        }

        // Returns the arrival date string (YYYY-MM-DD), adding a day only when
        // the arrival UTC time is at or before the departure UTC time.
        // Uses timezone-aware comparison so transpacific flights (e.g. SIN→SFO)
        // where arrival local-time < departure local-time don't get a false +1 day.
        function inferArrDate(date, depTime, arrTime, dep, arr) {
            const depTz = airportTz(dep);
            const arrTz = airportTz(arr);
            const _nextDay = () => {
                const d = new Date(`${date}T12:00:00`);
                d.setDate(d.getDate() + 1);
                return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            };
            if (depTz && arrTz) {
                try {
                    const depUTC = localTimeToUTC(`${date}T${depTime}`, depTz);
                    const arrUTC = localTimeToUTC(`${date}T${arrTime}`, arrTz);
                    return arrUTC <= depUTC ? _nextDay() : date;
                } catch(e) { /* fall through */ }
            }
            const [dH, dM] = depTime.split(':').map(Number);
            const [aH, aM] = arrTime.split(':').map(Number);
            return (aH * 60 + aM <= dH * 60 + dM) ? _nextDay() : date;
        }

        function autoComputeBlockTime() {
            if (_blockUserEdited) return;
            const dep = document.getElementById('add-dep').value.trim().toUpperCase();
            const arr = document.getElementById('add-arr').value.trim().toUpperCase();
            const depTime = document.getElementById('add-dep-time').value;
            const arrTime = document.getElementById('add-arr-time').value;
            const date = document.getElementById('add-date').value;
            if (!dep || !arr || !depTime || !arrTime || !date) return;
            const depTz = airportTz(dep);
            const arrTz = airportTz(arr);
            const arrDate = inferArrDate(date, depTime, arrTime, dep, arr);
            const nextDay = arrDate !== date;
            const arrLbl = document.getElementById('add-arr-next-day-label');
            if (arrLbl) arrLbl.textContent = nextDay ? '(next day)' : '';
            const depISO = `${date}T${depTime}:00`;
            const arrISO = `${arrDate}T${arrTime}:00`;
            let blockMin;
            if (depTz && arrTz) {
                const depUTC = localTimeToUTC(depISO, depTz);
                const arrUTC = localTimeToUTC(arrISO, arrTz);
                blockMin = Math.round((arrUTC - depUTC) / 60000);
            } else {
                blockMin = Math.round((new Date(arrISO + 'Z') - new Date(depISO + 'Z')) / 60000);
            }
            if (blockMin > 0 && blockMin < 36 * 60) {
                const h = Math.floor(blockMin / 60);
                const mn = blockMin % 60;
                document.getElementById('add-block-time').value = `${h}:${String(mn).padStart(2, '0')}`;
            }
        }

        function openAddFlight(dateKey) {
            if (!canEdit()) { showToast('You can only add flights to your own schedule.', 'error'); return; }
            _editSegmentId = null;
            _blockUserEdited = false;
            document.getElementById('add-flight-title').textContent = 'Add Flight';
            document.getElementById('add-flight-submit-btn').textContent = 'Add Flight';
            document.getElementById('add-date').value = dateKey || _localToday();
            document.getElementById('add-pilot').value = myPilot || currentPilot || PILOT_KEYS[0];
            ['add-dep','add-arr','add-dep-time','add-arr-time','add-flight-num','add-tail-num','add-block-time','add-training-location'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
            document.getElementById('add-block-auto-label').textContent = '(auto-calculated)';
            document.getElementById('add-arr-next-day-label').textContent = '';
            document.getElementById('add-flight-error').classList.add('hidden');
            _addFlightNjPrefill = null; // before setAddFlightType, so a previous open's pre-fill can't leak in
            setAddFlightType('work');
            // NetJets: tail/flight-number stay the same for the whole tour, so pre-fill from
            // whatever was saved for TODAY's tour rather than making them retype it per leg --
            // the whole point of entering it once on day 1 (see netjets_tracking_plan).
            const targetKey = myPilot || currentPilot;
            _addFlightNjPrefill = null;
            if (pilotsCache[targetKey]?.parser_type === 'manual_netjets') {
                const tourStart = _tourStartDateFor(targetKey, _localToday());
                const tail = _tourTailFor(targetKey, tourStart);
                if (tail) {
                    const digits = tail.replace(/\D/g, '');
                    _addFlightNjPrefill = { tail, fn: digits ? `EJA${digits}` : '' };
                    _applyNetjetsPrefill('work');
                }
            }
            document.getElementById('add-flight-modal').classList.remove('hidden');
        }

        function openEditFlight(segmentId) {
            const seg = segments.find(s => s.id === segmentId);
            if (!seg) return;
            _editSegmentId = segmentId;
            document.getElementById('add-flight-title').textContent = 'Edit Flight';
            document.getElementById('add-flight-submit-btn').textContent = 'Save Changes';
            document.getElementById('add-pilot').value = myPilot || currentPilot || PILOT_KEYS[0];
            // The form is local airport time (what gets saved), but NetJets auto legs / Schedaero
            // rows are stored in UTC -- slicing "19:56" out of a Z string pre-filled the UTC clock as
            // if local, so saving any edit (even just the destination) shifted the leg by the UTC
            // offset (James's TEB->APF moved 2:56 PM -> 7:56 PM EST). Convert to airport-local first.
            const localParts = (iso, apt) => {
                if (!iso) return { date: '', time: '' };
                const tz = /Z$/.test(iso) && airportTz(apt);
                if (!tz) return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
                const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
                    .formatToParts(new Date(iso)).map(x => [x.type, x.value]));
                return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
            };
            const depLocal = localParts(seg.departureTime, seg.departureAirport);
            const arrLocal = localParts(seg.arrivalTime, seg.arrivalAirport);
            // Date
            const depDate = depLocal.date;
            document.getElementById('add-date').value = depDate;
            document.getElementById('add-dep').value = seg.departureAirport || '';
            document.getElementById('add-arr').value = seg.arrivalAirport || '';
            // Times
            document.getElementById('add-dep-time').value = depLocal.time;
            document.getElementById('add-arr-time').value = arrLocal.time;
            document.getElementById('add-flight-num').value = seg.flightNumber || '';
            document.getElementById('add-tail-num').value = seg.tail || '';
            document.getElementById('add-flight-error').classList.add('hidden');
            // Block time
            _blockUserEdited = false;
            const blockEl = document.getElementById('add-block-time');
            const blockLbl = document.getElementById('add-block-auto-label');
            if (seg.blockMinutes != null && seg.blockMinutes > 0) {
                const bh = Math.floor(seg.blockMinutes / 60);
                const bm = seg.blockMinutes % 60;
                blockEl.value = `${bh}:${String(bm).padStart(2, '0')}`;
                blockLbl.textContent = '(saved)';
                // Not locked: changing times/airports on an edit recomputes it (the saved value
                // was derived from the old times); untouched, the saved value is kept as-is.
                _blockUserEdited = false;
            } else {
                blockEl.value = '';
                blockLbl.textContent = '(auto-calculated)';
            }
            const type = seg.type === 'vacation' ? 'vacation' : seg.type === 'training' ? 'training' : seg.trip === 'PERSONAL' ? 'personal' : seg.trip === 'COMMUTE' ? 'commute' : (seg.dh ? 'dh' : 'work');
            setAddFlightType(type);
            if (seg.type === 'training') {
                const locEl = document.getElementById('add-training-location');
                if (locEl) locEl.value = seg.departureAirport || '';
            }
            document.getElementById('add-flight-modal').classList.remove('hidden');
        }

        function closeAddFlight() {
            document.getElementById('add-flight-modal').classList.add('hidden');
            _editSegmentId = null;
        }

        async function deleteManualFlight(segmentId) {
            const seg = segments.find(s => s.id === segmentId);
            const label = seg?.type === 'ground' ? 'Delete Ground Leg' : seg?.type === 'training' ? 'Delete Training Day' : seg?.type === 'vacation' ? 'Delete Vacation Day' : 'Delete Flight';
            const ok = await showConfirm(label, 'This cannot be undone.');
            if (!ok) return;
            try {
                const resp = await fetch(`${API_BASE}/pilots/${currentPilot}/segments/${segmentId}${myToken ? `?token=${myToken}` : ''}`, { method: 'DELETE' });
                const data = await resp.json();
                if (data.success) { haptic('success'); loadPilot(currentPilot); showToast(seg?.type === 'ground' ? 'Ground leg deleted' : 'Flight deleted'); }
                else showToast(data.error || 'Failed to delete.', 'error');
            } catch (e) {
                showToast('Network error — is the server running?', 'error');
            }
        }

        let _editGroundId = null;

        function openEditGround(segmentId) {
            const g = segments.find(s => s.id === segmentId);
            if (!g) return;
            _editGroundId = segmentId;
            document.getElementById('eg-dep').value = g.departureAirport || '';
            document.getElementById('eg-arr').value = g.arrivalAirport || '';
            document.getElementById('eg-date').value = g.departureTime ? g.departureTime.slice(0, 10) : '';
            document.getElementById('eg-dep-time').value = g.departureTime ? g.departureTime.slice(11, 16) : '';
            document.getElementById('eg-arr-time').value = g.arrivalTime ? g.arrivalTime.slice(11, 16) : '';
            document.getElementById('eg-label').value = g.flightNumber || '';
            document.getElementById('eg-error').classList.add('hidden');
            document.getElementById('edit-ground-modal').classList.remove('hidden');
        }

        function closeEditGround() {
            document.getElementById('edit-ground-modal').classList.add('hidden');
            _editGroundId = null;
        }

        async function saveEditGround() {
            const dep = document.getElementById('eg-dep').value.trim().toUpperCase();
            const arr = document.getElementById('eg-arr').value.trim().toUpperCase();
            const date = document.getElementById('eg-date').value;
            const depTime = document.getElementById('eg-dep-time').value;
            const arrTime = document.getElementById('eg-arr-time').value;
            const label = document.getElementById('eg-label').value.trim() || null;
            const errEl = document.getElementById('eg-error');
            if (!dep || !arr || !date || !depTime) {
                errEl.textContent = 'From, To, Date, and Departs are required.';
                errEl.classList.remove('hidden');
                return;
            }
            const depISO = `${date}T${depTime}:00`;
            const arrISO = arrTime ? `${date}T${arrTime}:00` : null;
            try {
                const resp = await fetch(`${API_BASE}/pilots/${currentPilot}/segments/${_editGroundId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ departure_time: depISO, arrival_time: arrISO, departure_airport: dep, arrival_airport: arr, flight_number: label, tail: null, is_dh: false, is_personal: false, is_commute: false, block_minutes: null, token: myToken })
                });
                const data = await resp.json();
                if (data.success) { closeEditGround(); haptic('success'); loadPilot(currentPilot); showToast('Ground transport updated'); }
                else { errEl.textContent = data.error || 'Failed to save.'; errEl.classList.remove('hidden'); }
            } catch (e) {
                errEl.textContent = 'Network error — is the server running?';
                errEl.classList.remove('hidden');
            }
        }

        function _buildFlightPayload(pilot, date, dep, arr, depTime, arrTime) {
            const depISO = `${date}T${depTime}:00`;
            let arrISO = null;
            if (arrTime) {
                const arrDate = inferArrDate(date, depTime, arrTime, dep, arr);
                arrISO = `${arrDate}T${arrTime}:00`;
            }
            return {
                departure_time: depISO,
                arrival_time: arrISO,
                departure_airport: dep,
                arrival_airport: arr,
                flight_number: document.getElementById('add-flight-num').value.trim() || null,
                tail: document.getElementById('add-tail-num').value.trim() || null,
                is_dh: _addFlightType === 'dh',
                is_personal: _addFlightType === 'personal',
                is_commute: _addFlightType === 'commute',
                block_minutes: parseBlockInput(document.getElementById('add-block-time').value),
                token: myToken
            };
        }

        async function submitAddFlight() {
            const pilot    = document.getElementById('add-pilot').value;
            const date     = document.getElementById('add-date').value;
            const errEl    = document.getElementById('add-flight-error');
            errEl.classList.add('hidden');

            if (!date) {
                errEl.textContent = 'Date is required.';
                return errEl.classList.remove('hidden');
            }

            // Training / Vacation — no flight fields needed
            if (_addFlightType === 'training' || _addFlightType === 'vacation') {
                const location = (_addFlightType === 'training')
                    ? (document.getElementById('add-training-location')?.value.trim().toUpperCase() || null)
                    : null;
                const payload = {
                    segment_type: _addFlightType,
                    departure_time: `${date}T00:00:00`,
                    departure_airport: location || null,
                    arrival_airport:   location || null,
                    token: myToken,
                };
                const isEdit = _editSegmentId !== null;
                const url = isEdit
                    ? `${API_BASE}/pilots/${pilot}/segments/${_editSegmentId}`
                    : `${API_BASE}/pilots/${pilot}/add-segment`;
                try {
                    const resp = await fetch(url, { method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    const data = await resp.json();
                    if (data.success) {
                        closeAddFlight();
                        if (pilot === currentPilot) loadPilot(currentPilot);
                        showToast(isEdit ? 'Updated' : (_addFlightType === 'vacation' ? 'Vacation day added' : 'Training day added'));
                    } else {
                        errEl.textContent = data.error || 'Failed to save.';
                        errEl.classList.remove('hidden');
                    }
                } catch (e) {
                    errEl.textContent = 'Network error — is the server running?';
                    errEl.classList.remove('hidden');
                }
                return;
            }

            const dep      = document.getElementById('add-dep').value.trim().toUpperCase();
            const arr      = document.getElementById('add-arr').value.trim().toUpperCase();
            const depTime  = document.getElementById('add-dep-time').value;
            const arrTime  = document.getElementById('add-arr-time').value;

            if (!dep || !arr || !depTime) {
                errEl.textContent = 'Date, From, To, and Departure time are required.';
                return errEl.classList.remove('hidden');
            }
            if (dep.length < 3 || arr.length < 3) {
                errEl.textContent = 'Airport codes must be 3–4 characters (e.g. ORD or KORD).';
                return errEl.classList.remove('hidden');
            }
            const flightNumVal = document.getElementById('add-flight-num').value.trim();
            if (flightNumVal && !/^[A-Z]{3}\d+$/.test(flightNumVal)) {
                errEl.textContent = 'Flight # must use the 3-letter ICAO code (e.g. SKW1234, UAL442, SWA88).';
                return errEl.classList.remove('hidden');
            }

            const payload = _buildFlightPayload(pilot, date, dep, arr, depTime, arrTime);
            if (payload.block_minutes != null && payload.block_minutes > 24 * 60) {
                errEl.textContent = 'Block time is over 24 hours — enter it as h:mm (e.g. 0:35 or 2:15).';
                return errEl.classList.remove('hidden');
            }
            const isEdit = _editSegmentId !== null;
            // Keep a UTC-stored row (NetJets auto leg, Schedaero) in UTC: the form is local airport
            // time, and saving it back as local left that pilot's rows mixed, so Crossings (which
            // reads a UTC pilot's rows as UTC) was off by the viewer-vs-airport timezone gap.
            const origSeg = isEdit ? segments.find(s => s.id === _editSegmentId) : null;
            if (origSeg && /Z$/.test(origSeg.departureTime || '')) {
                const toUtc = (iso, apt) => { const tz = iso && airportTz(apt); return tz ? localTimeToUTC(iso, tz).toISOString() : iso; };
                payload.departure_time = toUtc(payload.departure_time, dep);
                payload.arrival_time = toUtc(payload.arrival_time, arr);
            }
            const url = isEdit
                ? `${API_BASE}/pilots/${pilot}/segments/${_editSegmentId}`
                : `${API_BASE}/pilots/${pilot}/add-segment`;

            try {
                const resp = await fetch(url, {
                    method: isEdit ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await resp.json();
                if (data.success) {
                    closeAddFlight();
                    if (pilot === currentPilot) loadPilot(currentPilot);
                    // Say where it went: a flight saved on the wrong day looks like it never saved.
                    const addedOn = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                    showToast(`${isEdit ? 'Flight updated' : 'Flight added'} for ${addedOn}`);
                } else {
                    errEl.textContent = data.error || (isEdit ? 'Failed to save changes.' : 'Failed to add flight.');
                    errEl.classList.remove('hidden');
                }
            } catch (e) {
                errEl.textContent = 'Network error — is the server running?';
                errEl.classList.remove('hidden');
            }
        }
        // ────────────────────────────────────────────────────────────────

        function changeMonth(dir) { viewDate.setMonth(viewDate.getMonth() + dir); render(); }

        async function handleMobileUpload(input) {
            if (_isDemo || !input.files[0]) return;
            const file = input.files[0];
            const uploadPilot = document.getElementById('mobile-upload-pilot-select').value;
            document.getElementById('mobile-upload-sheet').classList.add('hidden');
            if (file.name.toLowerCase().endsWith('.pdf')) {
                showToast('Reading PDF schedule — this can take up to a minute…', 'info', 8000);
            }
            const result = await uploadPilotSchedule(uploadPilot, file);
            if (result && result.success) {
                showToast(result.ccSchedule
                    ? `Schedule uploaded — ${result.daysParsed} days parsed for ${uploadPilot}`
                    : `Schedule uploaded — ${result.segmentsAdded} segments for ${uploadPilot}`);
                if (myPilot === null && !myViewer && result.warnings && result.warnings.length) {
                    showToast(`⚠ ${result.warnings.length} unrecognized item${result.warnings.length > 1 ? 's' : ''} in this schedule — see Admin → Manage Users for details.`, 'info', 6000);
                }
                if (uploadPilot === currentPilot) loadPilot(currentPilot);
            } else {
                showToast('Upload failed — check the browser console for details.', 'error');
            }
            input.value = '';
        }

