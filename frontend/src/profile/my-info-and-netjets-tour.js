        // ── Self-service profile editing (base / home / airline) ──────────────
        // Lets a pilot update their own base, home airport, and carrier without going through
        // admin -- for when they move, change crew base, or start flying for a new airline.
        // Reuses the same PUT /api/pilots/:key endpoint the admin edit-user modal uses, but a
        // self-edit can't touch `role` (server-enforced too) since that's a permission level.
        function _renderMyInfoSummary() {
            const el = document.getElementById('my-info-summary');
            if (!el || !myPilot) return;
            const p = pilotsCache[myPilot];
            if (!p) { el.textContent = ''; return; }
            const opt = AIRLINE_OPTIONS.find(o => o.icao === (p.airline_code || ''));
            const airlineLabel = (opt && opt.icao !== 'OTHER')
                ? document.querySelector(`#edit-user-airline-sel option[value="${opt.icao}"]`)?.textContent
                : null;
            el.textContent = `${p.base || '—'} base · ${p.home_airport || '—'} home${airlineLabel ? ' · ' + airlineLabel : ''}`;
        }

        async function openEditMyInfoModal() {
            if (!myPilot) return;
            document.getElementById('my-info-error').classList.add('hidden');
            let pilot = pilotsCache[myPilot];
            if (!pilot) {
                try { pilot = await fetch(`${API_BASE}/pilots/${myPilot}?token=${encodeURIComponent(myToken)}`).then(r => r.json()); }
                catch { pilot = {}; }
            }
            document.getElementById('my-info-base').value = pilot?.base || '';
            _myInfoOriginalBase = (pilot?.base || '').toUpperCase().trim();
            document.getElementById('my-info-base-effective-row').classList.add('hidden');
            document.getElementById('my-info-base-effective').value = new Date().toISOString().slice(0, 10);
            document.getElementById('my-info-home').value = pilot?.home_airport || '';
            const asel = _airlineSelectValue(pilot?.airline_code || '', pilot?.parser_type || '');
            document.getElementById('my-info-airline-sel').value = asel;
            _onMyInfoAirlineChange();
            document.getElementById('my-info-ics-url').value = '';
            const aopt = AIRLINE_OPTIONS.find(o => o.icao === asel);
            if (aopt?.needsIcs) {
                fetch(`${API_BASE}/pilots/${myPilot}/ics-url${myToken ? `?token=${myToken}` : ''}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(d => { if (d?.url) document.getElementById('my-info-ics-url').value = d.url; })
                    .catch(() => {});
            }
            if (asel === 'EJA') {
                pilotsCache[myPilot] = pilot; // _tourStartDateFor/_tourTailFor read through this cache
                const rh = pilot?.rotation_history || [];
                document.getElementById('my-info-rotation-family').value = '';
                let lineValueToSet = '';
                if (pilot?.cc_variant || (pilot?.cc_schedule_days || []).length) {
                    // A CC schedule overrides any Line-based rotation whenever it has data (see
                    // _isNetJetsOnDuty()'s precedence) -- showing "CC" here reflects what's
                    // actually governing, even if a stale 7&7/8&6 rotation row also still exists
                    // underneath it from before the pilot switched onto a CC schedule.
                    document.getElementById('my-info-rotation-family').value = 'CC';
                    if (pilot?.cc_variant) lineValueToSet = String(pilot.cc_variant);
                } else {
                    // NOT rh[rh.length-1] -- that's just "latest effective_from in the array,"
                    // which is wrong the moment a FUTURE-dated row exists (e.g. a stray test save
                    // for next week): it would sort after today's actually-current row and get
                    // shown instead. _resolveRotationAt correctly picks whichever row is actually
                    // in effect today.
                    const rotation = _resolveRotationAt(rh, _todayLocalDateStr());
                    if (rotation) {
                        // Every rotation is now saved via the line formula, so this reverse-maps
                        // exactly (no guessing) -- family comes straight from days_on, line number
                        // from how many days the stored anchor sits past the reference date.
                        document.getElementById('my-info-rotation-family').value = String(rotation.days_on === 8 ? 8 : 7);
                        const lineNum = _anchorDateToLine(rotation.anchor_date);
                        if (lineNum) lineValueToSet = String(lineNum);
                    }
                }
                // Rebuilds the Line select's options for the now-set family BEFORE applying the
                // saved value -- _onRotationFamilyChange() replaces the <select>'s innerHTML, so
                // setting .value first would just get wiped out by that rebuild.
                _onRotationFamilyChange();
                if (lineValueToSet) document.getElementById('my-info-rotation-line').value = lineValueToSet;
                _refreshMyInfoNetjetsStatus();
            }
            document.getElementById('edit-my-info-modal').classList.remove('hidden');
        }

        function _todayLocalDateStr() {
            const n = new Date();
            return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
        }

        function _refreshMyInfoNetjetsStatus() {
            if (!myPilot) return; // admin saving another pilot's tour has no My Info to refresh
            const todayStr = _todayLocalDateStr();
            const tourStart = _tourStartDateFor(myPilot, todayStr);
            const rotStatus = document.getElementById('my-info-rotation-status');
            const tailStatus = document.getElementById('my-info-tour-tail-status');
            const tailInput = document.getElementById('my-info-tour-tail');
            const airportInput = document.getElementById('my-info-tour-start-airport');
            if (!rotStatus || !tailStatus || !tailInput || !airportInput) return;
            if (tourStart === null) {
                rotStatus.textContent = _resolveRotationAt(pilotsCache[myPilot]?.rotation_history, todayStr)
                    ? 'Currently off-duty.' : 'No rotation saved yet.';
                tailStatus.textContent = 'Not currently on a tour.';
                tailInput.value = ''; airportInput.value = '';
                tailInput.disabled = true; airportInput.disabled = true;
            } else {
                rotStatus.textContent = `Currently on duty — this tour started ${tourStart}.`;
                tailStatus.textContent = '';
                tailInput.disabled = false; airportInput.disabled = false;
                tailInput.value = _tourTailFor(myPilot, tourStart) || '';
                airportInput.value = _tourStartAirportFor(myPilot, tourStart) || '';
            }
        }

        // CC has no line/formula to pick -- toggles the Line-select+Save-button group off and a
        // plain "use the Upload button" note on instead. The note itself is just explanatory; a CC
        // pilot's actual schedule always comes in through the standard Upload button (see
        // _handlePilotUpload()'s manual_netjets branch, server.js), never a save here.
        // CC has no line/formula -- the "Line" dropdown becomes a program picker (52/60/72/76)
        // instead of Line 1-14. Still saved through the same dropdown+button, just a different
        // save path (saveMyRotation() branches on family === 'CC').
        const _ROTATION_LINE_OPTIONS = Array.from({ length: 14 }, (_, i) => [String(i + 1), `Line ${i + 1}`]);
        const _CC_VARIANT_OPTIONS = [['52', 'CC52'], ['60', 'CC60'], ['72', 'CC72'], ['76', 'CC76']];
        function _onRotationFamilyChange() {
            const family = document.getElementById('my-info-rotation-family').value;
            const isCC = family === 'CC';
            const lineSel = document.getElementById('my-info-rotation-line');
            const prevValue = lineSel.value;
            const opts = isCC ? _CC_VARIANT_OPTIONS : _ROTATION_LINE_OPTIONS;
            lineSel.innerHTML = `<option value="">${isCC ? '— Program —' : '— Line —'}</option>`
                + opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
            // Keep the current selection if it's still valid under the new option set (e.g.
            // toggling Family back and forth shouldn't silently clear a real choice).
            if (opts.some(([v]) => v === prevValue)) lineSel.value = prevValue;
            document.getElementById('my-info-rotation-note').textContent = isCC
                ? 'Pick which CC program you bid. The real on/off-duty schedule always comes from your uploaded monthly export (Upload Schedule button) — this is just for reference.'
                : 'Pick your schedule family and bid line.';
            document.getElementById('my-info-cc-clear-row').classList.toggle('hidden', !isCC);
            if (isCC) _refreshCcClearMonthOptions();
        }

        // Only months that actually have uploaded CC days, latest first and preselected -- a bare
        // type="month" input had no value until picked (iOS shows a month it never sets).
        function _refreshCcClearMonthOptions() {
            const sel = document.getElementById('my-info-cc-clear-month');
            const months = [...new Set((pilotsCache[myPilot]?.cc_schedule_days || []).map(d => d.date.slice(0, 7)))].sort().reverse();
            sel.innerHTML = months.length
                ? months.map(m => `<option value="${m}">${new Date(m + '-15T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</option>`).join('')
                : '<option value="">No uploaded months</option>';
        }

        // Notes.md: "no way currently to get them off of a rotation. For testing purposes while
        // NJ is in beta." Full reset -- rotation, seams, and cc_variant.
        async function clearMyRotation() {
            const statusEl = document.getElementById('my-info-rotation-status');
            const ok = await showConfirm('Clear rotation?', 'Removes your saved duty rotation entirely (formula, line-switch seams, and CC program). On/off days fall back to whatever flights are actually logged until you set a new one.', { label: 'Clear' });
            if (!ok) return;
            statusEl.textContent = 'Clearing…';
            try {
                const r = await fetch(`${API_BASE}/pilots/${myPilot}/rotation`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken })
                });
                if (!r.ok) { statusEl.textContent = 'Clear failed — try again.'; return; }
                if (pilotsCache[myPilot]) {
                    pilotsCache[myPilot].rotation_history = [];
                    pilotsCache[myPilot].rotation_seams = [];
                    pilotsCache[myPilot].cc_variant = null;
                }
                document.getElementById('my-info-rotation-family').value = '';
                document.getElementById('my-info-rotation-line').innerHTML = '<option value="">— Line —</option>'
                    + _ROTATION_LINE_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
                document.getElementById('my-info-cc-clear-row').classList.add('hidden');
                document.getElementById('my-info-rotation-note').textContent = 'Pick your schedule family and bid line.';
                statusEl.textContent = 'Rotation cleared.';
                _refreshMyInfoNetjetsStatus();
            } catch { statusEl.textContent = 'Clear failed — try again.'; }
        }

        // Notes.md: "Once a month is uploaded for CC schedule no way to revert that."
        async function clearMyCcScheduleMonth() {
            const monthVal = document.getElementById('my-info-cc-clear-month').value; // YYYY-MM
            const statusEl = document.getElementById('my-info-rotation-status');
            if (!monthVal) { statusEl.textContent = 'Pick a month to clear first.'; return; }
            const ok = await showConfirm('Clear this month?', `Deletes every uploaded CC schedule day for ${monthVal}. You can re-upload it afterward.`, { label: 'Clear' });
            if (!ok) return;
            statusEl.textContent = 'Clearing…';
            try {
                const r = await fetch(`${API_BASE}/pilots/${myPilot}/cc-schedule`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, month: monthVal })
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) { statusEl.textContent = j.error || 'Clear failed — try again.'; return; }
                if (pilotsCache[myPilot]?.cc_schedule_days) {
                    pilotsCache[myPilot].cc_schedule_days = pilotsCache[myPilot].cc_schedule_days.filter(d => !d.date.startsWith(monthVal));
                }
                statusEl.textContent = `Cleared ${j.deleted || 0} day(s) for ${monthVal}.`;
                _refreshCcClearMonthOptions();
                if (currentPilot === myPilot) {
                    render();
                    if (document.getElementById('view-overlap')?.classList.contains('view-active')) computeOffDays();
                }
            } catch { statusEl.textContent = 'Clear failed — try again.'; }
        }

        async function saveMyRotation() {
            const statusEl = document.getElementById('my-info-rotation-status');
            const family = document.getElementById('my-info-rotation-family').value; // '7' = 7&7, '8' = 8&6, 'CC' = CC52/60/72/76
            const lineSel = document.getElementById('my-info-rotation-line').value;
            // Both dropdowns default to a blank placeholder specifically so this can't slip
            // through unnoticed -- confirmed live as a real failure mode: a pilot could click
            // Save with 7&7/Line 1 still sitting there from the default, saving the wrong
            // rotation without ever having chosen it.
            if (!family || !lineSel) { statusEl.textContent = 'Pick both a family and a line first.'; return; }

            if (family === 'CC') {
                statusEl.textContent = 'Saving…';
                try {
                    const r = await fetch(`${API_BASE}/pilots/${myPilot}/rotation`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: myToken, ccVariant: lineSel, effectiveFrom: _todayLocalDateStr() })
                    });
                    if (!r.ok) { statusEl.textContent = 'Save failed — try again.'; return; }
                    if (!pilotsCache[myPilot]) pilotsCache[myPilot] = {};
                    pilotsCache[myPilot].cc_variant = lineSel;
                    // Server ended any 7&7/8&6 formula from today (days_on=0 row) -- mirror it so
                    // days with no uploaded CC data stop showing the old rotation.
                    const rh = pilotsCache[myPilot].rotation_history || [];
                    if (rh.length) {
                        const today = _todayLocalDateStr();
                        pilotsCache[myPilot].rotation_history = [...rh.filter(r => r.effective_from !== today), { anchor_date: today, days_on: 0, days_off: 0, effective_from: today }];
                    }
                    _refreshMyInfoNetjetsStatus();
                    statusEl.textContent = 'Saved.';
                    if (currentPilot === myPilot) {
                        render();
                        if (document.getElementById('view-overlap')?.classList.contains('view-active')) computeOffDays();
                    }
                } catch { statusEl.textContent = 'Save failed — try again.'; }
                return;
            }

            const lineNum = parseInt(lineSel, 10);
            const daysOn  = family === '8' ? 8 : 7;
            const daysOff = family === '8' ? 6 : 7;
            const anchor  = _lineToAnchorDate(lineNum);
            // The line formula is valid for any date, past or future -- a first-time setup
            // should backfill the pilot's ENTIRE history (Off Days for past months shouldn't
            // stay blank just because the rotation was entered late), so it gets a far-past floor
            // effectiveFrom, same pattern pilot_base_history already uses for a pilot's first-ever
            // recorded change. A pilot who already has a rotation and is switching to a new line
            // is a real dated change, not a backfill -- that one is forward-only from today, so it
            // doesn't retroactively overwrite the old line's own history.
            const existingRotation = _resolveRotationAt(pilotsCache[myPilot]?.rotation_history, _todayLocalDateStr());
            // Any history at all (even an ended one, after a CC stint) means this is a dated
            // change -- a 2000-01-01 backfill would overwrite the original first row.
            const effectiveFrom = (pilotsCache[myPilot]?.rotation_history || []).length ? _todayLocalDateStr() : '2000-01-01';
            // A real switch (there's a current rotation to switch FROM) gets a seam row -- the
            // 28-day transition isn't a clean cutover, see _computeSeamWindow()'s own comment.
            // First-time setup has nothing to seam from, so these stay null.
            const previousFamily = existingRotation ? (existingRotation.days_on === 8 ? '8' : '7') : null;
            const previousLine = existingRotation ? _anchorDateToLine(existingRotation.anchor_date) : null;
            statusEl.textContent = 'Saving…';
            try {
                const r = await fetch(`${API_BASE}/pilots/${myPilot}/rotation`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, anchorDate: anchor, daysOn, daysOff, effectiveFrom, family, lineNum, previousFamily, previousLine })
                });
                if (!r.ok) { statusEl.textContent = 'Save failed — try again.'; return; }
                if (!pilotsCache[myPilot]) pilotsCache[myPilot] = {};
                pilotsCache[myPilot].cc_variant = null;
                pilotsCache[myPilot].rotation_history = [...(pilotsCache[myPilot].rotation_history || []).filter(r => r.effective_from !== effectiveFrom), { anchor_date: anchor, days_on: Number(daysOn), days_off: Number(daysOff), effective_from: effectiveFrom }];
                _refreshMyInfoNetjetsStatus();
                statusEl.textContent = 'Saved.';
                // The cache update above is enough for the My Info modal's own status text, but
                // nothing else re-renders on its own -- the grid/list and Off Days views were
                // already built from the OLD rotation and don't know anything changed.
                if (currentPilot === myPilot) {
                    render();
                    if (document.getElementById('view-overlap')?.classList.contains('view-active')) computeOffDays();
                }
            } catch { statusEl.textContent = 'Save failed — try again.'; }
        }

        async function saveMyTourTail() {
            const tailStatus = document.getElementById('my-info-tour-tail-status');
            const tail = document.getElementById('my-info-tour-tail').value.trim();
            const startAirport = document.getElementById('my-info-tour-start-airport').value.trim();
            const tourStart = _tourStartDateFor(myPilot, _todayLocalDateStr());
            if (!tourStart) { tailStatus.textContent = 'Not currently on a tour.'; return; }
            if (!tail) { tailStatus.textContent = 'Enter the number off your tail first.'; return; }
            tailStatus.textContent = 'Saving…';
            try {
                const r = await fetch(`${API_BASE}/pilots/${myPilot}/tour-tail`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, tourStartDate: tourStart, tail, startAirport })
                });
                if (!r.ok) { tailStatus.textContent = 'Save failed — try again.'; return; }
                if (!pilotsCache[myPilot]) pilotsCache[myPilot] = {};
                const existing = (pilotsCache[myPilot].tour_tails || []).filter(t => t.tour_start_date !== tourStart);
                const prior = (pilotsCache[myPilot].tour_tails || []).find(t => t.tour_start_date === tourStart);
                pilotsCache[myPilot].tour_tails = [...existing, { tour_start_date: tourStart, tail, start_airport: startAirport || prior?.start_airport || null }];
                tailStatus.textContent = 'Saved.';
                if (currentPilot === myPilot) render();
            } catch { tailStatus.textContent = 'Save failed — try again.'; }
        }

        // Dedicated per-tour modal -- NOT routed through My Info (raised directly: "going into the
        // my info each tour isn't the best way to do it"). Opened from the day-detail sheet's
        // "Edit Tour" button on any on-duty NetJets day, or from the reminder popup. Also supports
        // a genuine mid-tour tail SWAP (raised directly: "there also should be able to tail swap it
        // too") -- re-opening this for an already-tailed tour and saving a DIFFERENT tail is exactly
        // that; the server detects the change and finalizes whatever was still open under the old
        // callsign (see PUT /tour-tail's own comment) instead of silently abandoning it, a real gap
        // confirmed live twice this session before this existed.
        let _netjetsTourModalDate = null;
        let _netjetsTourModalPilot = null; // the pilot being edited: self, or the viewed pilot for admin
        function openNetjetsTourModal(tourStartDate) {
            const pilot = myPilot || (canEdit() ? currentPilot : null);
            if (!tourStartDate || !pilot) return;
            _netjetsTourModalPilot = pilot;
            _netjetsTourModalDate = tourStartDate;
            _refreshNetjetsTourRange();
            document.getElementById('netjets-tour-modal-tail').value = _tourTailFor(_netjetsTourModalPilot, tourStartDate) || '';
            document.getElementById('netjets-tour-modal-start-airport').value = _tourStartAirportFor(_netjetsTourModalPilot, tourStartDate) || '';
            document.getElementById('netjets-tour-modal-status').textContent = '';
            _refreshNetjetsLastLegPicker();
            // Nothing saved for this tour yet -- no point offering to reset a blank.
            document.getElementById('netjets-tour-modal-reset-btn').classList.toggle('hidden', !_tourTailFor(_netjetsTourModalPilot, tourStartDate));
            document.getElementById('netjets-tour-modal').classList.remove('hidden');
        }
        // Legs on this tour's tail from yesterday on, flown or not, so a pilot already off the plane can
        // still pick the leg they left on. Includes legs a last-leg pick already took off.
        function _refreshNetjetsLastLegPicker() {
            const data = pilotsCache[_netjetsTourModalPilot];
            const tourStart = _netjetsTourModalDate;
            const tail = (_tourTailFor(_netjetsTourModalPilot, tourStart) || '').toUpperCase();
            const saved = (data?.tour_tails || []).find(t => t.tour_start_date === tourStart)?.last_leg_id || null;
            const yesterday = new Date(Date.now() - 86400000);
            const fromDay = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
            const legs = (data?.segments || []).filter(s => s.type === 'flight' && s.departure_time
                && s.auto_leg_key?.split('|')[1] === tourStart && String(s.tail || '').toUpperCase() === tail
                && (s.id === saved || ((!s.auto_leg_cancelled || s.auto_leg_cancelled === 2)
                    && (!s.auto_leg_complete || flightLocalDate(s.departure_time, s.departure_airport) >= fromDay))))
                .sort((a, b) => Date.parse(a.departure_time) - Date.parse(b.departure_time));
            document.getElementById('netjets-tour-modal-last-leg-wrap').classList.toggle('hidden', !legs.length);
            const label = s => {
                const [, m, d] = flightLocalDate(s.departure_time, s.departure_airport).split('-');
                return `Last leg: ${aptLabel(s.departure_airport, _netjetsTourModalPilot)} → ${aptLabel(s.arrival_airport, _netjetsTourModalPilot)} · ${+m}/${+d}`;
            };
            const select = document.getElementById('netjets-tour-modal-last-leg');
            select.innerHTML = `<option value="">Staying on this aircraft</option>` + legs.map(s => `<option value="${s.id}">${label(s)}</option>`).join('');
            select.value = saved ? String(saved) : '';
            const next = (data?.tour_tails || []).find(t => t.tour_start_date === tourStart)?.next_tail;
            document.getElementById('netjets-tour-modal-last-leg-note').textContent = next
                ? `Tail ${next} starts after your last leg.`
                : saved ? 'Later legs are off your schedule. Know your next tail? Enter it above, and it starts when this leg lands.'
                : 'Pick your last leg on this plane. Later legs come off your schedule.';
        }
        // Walks the actual tour (rotation, CC days, seam, and any extension days) rather than
        // assuming days_on, so an extended tour shows its real length.
        function _refreshNetjetsTourRange() {
            const ts = _netjetsTourModalDate;
            if (!ts) return;
            const end = _tourEndDateFor(_netjetsTourModalPilot, ts);
            const ext = (pilotsCache[_netjetsTourModalPilot]?.tour_extensions || []).filter(e => e.tour_start_date === ts).length;
            const fmt = ds => new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const days = Math.round((new Date(end + 'T12:00:00') - new Date(ts + 'T12:00:00')) / 86400000) + 1;
            document.getElementById('netjets-tour-modal-range').textContent =
                `${_netjetsTourModalPilot !== myPilot ? `${PILOT_NAMES[_netjetsTourModalPilot] || _netjetsTourModalPilot} · ` : ''}${fmt(ts)} – ${fmt(end)} (${days} day${days === 1 ? '' : 's'}${ext ? `, extended +${ext}` : ''})`;
            document.getElementById('netjets-tour-modal-unextend-btn').classList.toggle('hidden', !ext);
        }
        async function extendNetjetsTour() {
            const ts = _netjetsTourModalDate;
            const statusEl = document.getElementById('netjets-tour-modal-status');
            if (!ts) return;
            const end = new Date(_tourEndDateFor(_netjetsTourModalPilot, ts) + 'T12:00:00');
            end.setDate(end.getDate() + 1);
            const date = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
            statusEl.textContent = 'Saving…';
            try {
                const r = await fetch(`${API_BASE}/pilots/${_netjetsTourModalPilot}/tour-extension`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, tourStartDate: ts, date })
                });
                if (!r.ok) { statusEl.textContent = 'Extend failed — try again.'; return; }
                const exts = (pilotsCache[_netjetsTourModalPilot].tour_extensions || []).filter(e => e.date !== date);
                pilotsCache[_netjetsTourModalPilot].tour_extensions = [...exts, { date, tour_start_date: ts }];
                statusEl.textContent = 'Extended — same tail, no commute home until the new last day.';
                _refreshNetjetsTourRange();
                if (currentPilot === _netjetsTourModalPilot) render();
            } catch { statusEl.textContent = 'Extend failed — try again.'; }
        }
        async function unextendNetjetsTour() {
            const ts = _netjetsTourModalDate;
            const statusEl = document.getElementById('netjets-tour-modal-status');
            const last = (pilotsCache[_netjetsTourModalPilot]?.tour_extensions || []).filter(e => e.tour_start_date === ts).map(e => e.date).sort().pop();
            if (!last) return;
            statusEl.textContent = 'Saving…';
            try {
                const r = await fetch(`${API_BASE}/pilots/${_netjetsTourModalPilot}/tour-extension`, {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, date: last })
                });
                if (!r.ok) { statusEl.textContent = 'Undo failed — try again.'; return; }
                pilotsCache[_netjetsTourModalPilot].tour_extensions = pilotsCache[_netjetsTourModalPilot].tour_extensions.filter(e => e.date !== last);
                statusEl.textContent = 'Extension removed.';
                _refreshNetjetsTourRange();
                if (currentPilot === _netjetsTourModalPilot) render();
            } catch { statusEl.textContent = 'Undo failed — try again.'; }
        }
        function dismissNetjetsTourModal() {
            document.getElementById('netjets-tour-modal')?.classList.add('hidden');
            _netjetsTourModalDate = null;
        }
        async function saveNetjetsTourTail() {
            const pilot = _netjetsTourModalPilot, tourStart = _netjetsTourModalDate;
            const statusEl = document.getElementById('netjets-tour-modal-status');
            const tail = document.getElementById('netjets-tour-modal-tail').value.trim();
            const startAirport = document.getElementById('netjets-tour-modal-start-airport').value.trim();
            if (!tourStart) { statusEl.textContent = 'No tour selected.'; return; }
            if (!tail) { statusEl.textContent = 'Enter the tail number first.'; return; }
            const priorTail = _tourTailFor(pilot, tourStart);
            const isSwap = priorTail && priorTail.toUpperCase() !== tail.toUpperCase();
            const priorRow = (pilotsCache[pilot]?.tour_tails || []).find(t => t.tour_start_date === tourStart);
            const savedLast = priorRow?.last_leg_id || null;
            const pickerShown = !document.getElementById('netjets-tour-modal-last-leg-wrap').classList.contains('hidden');
            const pickedLast = pickerShown ? (+document.getElementById('netjets-tour-modal-last-leg').value || null) : savedLast;
            const lastChanged = pickedLast !== savedLast;
            const put = (path, body) => fetch(`${API_BASE}/pilots/${pilot}/${path}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: myToken, tourStartDate: tourStart, ...body })
            });
            statusEl.textContent = 'Saving…';
            try {
                // Last leg first: the server holds a new tail only once it knows there's a last leg to wait for.
                let removed = 0;
                if (lastChanged) {
                    const r = await put('tour-tail/last-leg', { segmentId: pickedLast });
                    if (!r.ok) { statusEl.textContent = 'Save failed — try again.'; return; }
                    removed = (await r.json()).removed;
                }
                const r = await put('tour-tail', { tail, startAirport });
                if (!r.ok) { statusEl.textContent = 'Save failed — try again.'; return; }
                const { queued } = await r.json();
                if (lastChanged || queued) {
                    const fresh = await fetchPilotData(pilot);
                    if (fresh) pilotsCache[pilot] = fresh;
                    if (pilot === currentPilot) loadPilot(pilot);
                } else {
                    if (!pilotsCache[pilot]) pilotsCache[pilot] = {};
                    const existing = (pilotsCache[pilot].tour_tails || []).filter(t => t.tour_start_date !== tourStart);
                    pilotsCache[pilot].tour_tails = [...existing, { ...priorRow, tour_start_date: tourStart, tail, start_airport: startAirport || null }];
                    if (pilot === currentPilot) render(); // the list shows the tour's tail
                }
                _refreshMyInfoNetjetsStatus();
                // Done -- close the tour modal and the day detail sheet it was opened from.
                dismissNetjetsTourModal();
                document.getElementById('day-detail-sheet')?.classList.add('hidden');
                const legsOff = removed ? ` ${removed} later leg${removed === 1 ? '' : 's'} off your schedule.` : '';
                showToast(queued ? `Tail ${tail.toUpperCase()} starts after your last leg.${legsOff}`
                    : isSwap ? 'Tail swapped — tracking switches to the new tail now.'
                    : lastChanged ? (pickedLast ? `Last leg saved.${legsOff}` : 'Staying on this aircraft.')
                    : 'Tour saved.', 'success');
            } catch { statusEl.textContent = 'Save failed — try again.'; }
        }

        // Notes.md: "should be able to remove tail for a tour/starting airport. (Reset)"
        async function resetNetjetsTour() {
            const tourStart = _netjetsTourModalDate;
            const statusEl = document.getElementById('netjets-tour-modal-status');
            if (!tourStart) return;
            const ok = await showConfirm('Reset this tour?', 'This clears the saved tail and starting airport for this tour. Any leg already tracked stays on the schedule, just marked complete.', { label: 'Reset' });
            if (!ok) return;
            statusEl.textContent = 'Resetting…';
            try {
                const r = await fetch(`${API_BASE}/pilots/${_netjetsTourModalPilot}/tour-tail`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, tourStartDate: tourStart })
                });
                if (!r.ok) { statusEl.textContent = 'Reset failed — try again.'; return; }
                if (pilotsCache[_netjetsTourModalPilot]?.tour_tails) {
                    pilotsCache[_netjetsTourModalPilot].tour_tails = pilotsCache[_netjetsTourModalPilot].tour_tails.filter(t => t.tour_start_date !== tourStart);
                }
                document.getElementById('netjets-tour-modal-tail').value = '';
                document.getElementById('netjets-tour-modal-start-airport').value = '';
                document.getElementById('netjets-tour-modal-reset-btn').classList.add('hidden');
                statusEl.textContent = 'Reset.';
                if (currentPilot === _netjetsTourModalPilot) render();
                _refreshMyInfoNetjetsStatus();
            } catch { statusEl.textContent = 'Reset failed — try again.'; }
        }

        // Raised directly: "they could technically DH to a new airport to get to the new
        // aircraft" -- a tail swap (or Day 1 itself) commonly means a commercial deadhead the
        // tail-based tracking can never see on its own (known, documented gap). Shortcut straight
        // from the tour modal into the existing Add Flight / Commute type, pre-filling the
        // arrival airport with whatever's currently in the Starting Airport field -- the pilot
        // only has to supply where they're commuting FROM.
        function _openCommuteForTour() {
            const startAirport = document.getElementById('netjets-tour-modal-start-airport').value.trim().toUpperCase();
            dismissNetjetsTourModal();
            // Same z-index as Add Flight and later in the DOM, so left open it covers the form.
            document.getElementById('day-detail-sheet')?.classList.add('hidden');
            openAddFlight();
            setAddFlightType('commute');
            if (startAirport) document.getElementById('add-arr').value = startAirport;
        }

        let _myInfoOriginalBase = '';
        function _onMyInfoBaseChange() {
            const changed = document.getElementById('my-info-base').value.trim() !== _myInfoOriginalBase;
            document.getElementById('my-info-base-effective-row').classList.toggle('hidden', !changed);
        }

        function _onMyInfoAirlineChange() {
            const val = document.getElementById('my-info-airline-sel').value;
            const opt = AIRLINE_OPTIONS.find(o => o.icao === val);
            document.getElementById('my-info-ics-row').classList.toggle('hidden', !opt?.needsIcs);
            document.getElementById('my-info-ics-label').textContent = opt?.icsLabel || 'ICS Calendar URL';
            document.getElementById('my-info-ics-hint').textContent  = opt?.icsHint
                || "Paste the private subscription link from your airline's scheduling app.";
            document.getElementById('my-info-netjets-section').classList.toggle('hidden', val !== 'EJA');
        }

        function closeEditMyInfoModal() {
            document.getElementById('edit-my-info-modal').classList.add('hidden');
        }

        async function saveMyInfo() {
            if (!myPilot) return;
            const base        = document.getElementById('my-info-base').value.trim();
            const baseChanged  = base !== _myInfoOriginalBase;
            const baseEffectiveFrom = baseChanged ? (document.getElementById('my-info-base-effective').value || null) : null;
            const homeAirport = document.getElementById('my-info-home').value.trim();
            const airlineSel  = document.getElementById('my-info-airline-sel').value;
            const airlineOpt  = AIRLINE_OPTIONS.find(o => o.icao === airlineSel) || { dbCode: '', parser: 'other', needsIcs: false };
            const airline     = airlineOpt.dbCode || '';
            const parser      = airlineOpt.parser;
            const icsUrl      = airlineOpt.needsIcs ? document.getElementById('my-info-ics-url').value.trim() : '';
            const errEl       = document.getElementById('my-info-error');
            const saveBtn     = document.getElementById('my-info-save-btn');

            errEl.classList.add('hidden');
            saveBtn.textContent = 'Saving…';
            saveBtn.disabled = true;

            try {
                const r = await fetch(`${API_BASE}/pilots/${myPilot}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, name: PILOT_NAMES[myPilot] || myPilot, base, homeAirport, parserType: parser, airlineCode: airline, baseEffectiveFrom })
                });
                if (!r.ok) { errEl.textContent = 'Save failed — try again'; errEl.classList.remove('hidden'); return; }

                if (icsUrl) {
                    saveBtn.textContent = 'Syncing…';
                    const syncR = await fetch(`${API_BASE}/pilots/${myPilot}/sync-ics`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: icsUrl, token: myToken })
                    });
                    if (!syncR.ok) {
                        const syncErr = await syncR.json().catch(() => ({}));
                        errEl.textContent = `Saved, but sync failed: ${syncErr.error || 'Unknown'}`;
                        errEl.classList.remove('hidden');
                    }
                }

                PILOT_HOME[myPilot] = homeAirport || PILOT_HOME[myPilot];
                closeEditMyInfoModal();
                await loadPilot(myPilot);
                _renderMyInfoSummary();
                updateUploadSyncButtons(myPilot);
                if (!errEl.textContent) showToast('Your info was updated');
            } catch { errEl.textContent = 'Network error'; errEl.classList.remove('hidden'); }
            finally { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        }

        async function confirmDeleteUser(pilotKey, name) {
            const ok = await showConfirm(`Delete ${name}?`, 'This will permanently remove their account and all schedule data.');
            if (!ok) return;
            try {
                const r = await fetch(`${API_BASE}/pilots/${pilotKey}?token=${encodeURIComponent(myToken)}`, { method: 'DELETE' });
                if (!r.ok) { showToast('Delete failed', 'error'); return; }
                await loadAdminUsers();
                showToast(`${name} deleted`);
            } catch { showToast('Network error', 'error'); }
        }

        async function confirmRegenerateToken(pilotKey, name) {
            const ok = await showConfirm(`New link for ${name}?`, 'Their old link will stop working immediately.', { label: 'Regenerate', danger: false });
            if (!ok) return;
            try {
                const r = await fetch(`${API_BASE}/pilots/${pilotKey}/regenerate-token?token=${encodeURIComponent(myToken)}`, { method: 'POST' });
                if (!r.ok) { showToast('Failed to regenerate link', 'error'); return; }
                await loadAdminUsers();
                showToast(`New link generated for ${name}`);
            } catch { showToast('Network error', 'error'); }
        }

