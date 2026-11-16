        function toggleOffDayPilot(key) {
            if (!_offDayFilter) _offDayFilter = new Set(PILOT_KEYS);
            if (_offDayFilter.has(key)) {
                _offDayFilter.delete(key);
            } else {
                _offDayFilter.add(key);
            }
            const isTab = _overlapTab === 'offdays';
            if (isTab) _renderOffDayView();
            else renderCommonOffSection(true, false);
        }


        function renderOverlapFilterBar() {
            const chipsEl = document.getElementById('offday-filter-chips');
            if (!chipsEl) return;
            if (!_crossingsFilter) _crossingsFilter = new Set(PILOT_KEYS);
            chipsEl.innerHTML = PILOT_KEYS.map(k => {
                const active = _crossingsFilter.has(k);
                const color  = PILOT_COLORS[k];
                const name   = PILOT_NAMES[k]?.split(' ')[0] || k;
                return `<button onclick="toggleCrossingsPilot('${k}')" style="flex:none;background:${active ? color + '22' : 'transparent'};color:${active ? color : '#52525b'};border:1px solid ${active ? color + '55' : '#3f3f46'};border-radius:9999px;padding:6px 14px;font-size:11px;font-weight:800;white-space:nowrap;cursor:pointer;transition:all 0.15s;-webkit-tap-highlight-color:transparent;min-height:36px;display:inline-flex;align-items:center">${name}</button>`;
            }).join('');
        }

        function renderCommonOffSection(preserveOpen, fullView = false) {
            const visibleCrew = getCrewVisible();
            if (!_offDayFilter) _offDayFilter = new Set(visibleCrew);
            const el = document.getElementById('common-off-section');
            if (!el) return;

            const wasOpen = !fullView && preserveOpen && !el.querySelector('.off-days-body')?.classList.contains('hidden');

            const now = new Date();
            const _pad = n => String(n).padStart(2, '0');
            const localDateStr = d => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;
            const todayStr = localDateStr(now);
            const tomorrowStr = localDateStr(new Date(now.getTime() + 86400000));
            const fmtDateShort = t => t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

            // Only consider pilots the user has chosen to see
            const activeKeys = visibleCrew.filter(k => _offDayFilter.has(k));

            const pilotFlyingDates = {};
            const pilotMaxDate = {};
            const kyleHardOffDates = new Set();
            const kyleSoftDates = new Set();
            const kyleVacationDates = new Set();
            let allDatesMax = null;
            PILOT_KEYS.forEach(k => {
                const flying = new Set();
                (pilotsCache[k]?.segments || []).forEach(s => {
                    if (s.auto_leg_cancelled) return;
                    if (k === 'kyle' && s.type === 'hard' && s.departure_time) {
                        kyleHardOffDates.add(s.departure_time.slice(0, 10));
                        return;
                    }
                    if (k === 'kyle' && s.type === 'soft' && s.departure_time) {
                        kyleSoftDates.add(s.departure_time.slice(0, 10));
                        return;
                    }
                    if (k === 'kyle' && s.type === 'vacation' && s.departure_time) {
                        kyleVacationDates.add(s.departure_time.slice(0, 10));
                        return;
                    }
                    if (s.type !== 'flight' && s.type !== 'reserve' && s.type !== 'ground' && s.type !== 'training') return;
                    if (s.type === 'flight' && s.trip === 'PERSONAL') return;
                    if (s.type === 'reserve' && s.departure_time && s.arrival_time) {
                        // Mark every day in the reserve window using local airport dates
                        const rdStr = flightLocalDate(s.departure_time, s.departure_airport) || s.departure_time.slice(0, 10);
                        const reStr = flightLocalDate(s.arrival_time,   s.departure_airport) || s.arrival_time.slice(0, 10);
                        const rd = new Date(rdStr + 'T12:00:00');
                        const re = new Date(reStr + 'T12:00:00');
                        for (let dd = new Date(rd); dd <= re; dd.setDate(dd.getDate() + 1)) {
                            const ds = localDateStr(dd);
                            flying.add(ds);
                            if (!allDatesMax || ds > allDatesMax) allDatesMax = ds;
                            if (!pilotMaxDate[k] || ds > pilotMaxDate[k]) pilotMaxDate[k] = ds;
                        }
                    } else {
                        // Use local departure date — UTC times can roll past midnight into the
                        // next calendar day, incorrectly marking that day as flying
                        const t = s.departure_time;
                        if (!t) return;
                        const ds = flightLocalDate(t, s.departure_airport) || t.slice(0, 10);
                        flying.add(ds);
                        if (!allDatesMax || ds > allDatesMax) allDatesMax = ds;
                        if (!pilotMaxDate[k] || ds > pilotMaxDate[k]) pilotMaxDate[k] = ds;
                    }
                });
                pilotFlyingDates[k] = flying;
            });

            const stalePilots = allDatesMax
                ? activeKeys.filter(k => {
                    // Same reasoning as Kyle's exclusion -- a manual-tracking pilot's segment
                    // data is sparse by design (legs only exist once auto-created or manually
                    // added), not a sign their schedule is actually out of date.
                    if (k === 'kyle' || pilotsCache[k]?.parser_type === 'manual_netjets') return false;
                    // Schedules publish as whole bid months, so a pilot's data covers through the
                    // end of the month of their last working day -- a real block of days off at the
                    // end of the month (Drew) isn't missing data.
                    const last = new Date((pilotMaxDate[k] || '2000-01-01') + 'T12:00:00');
                    const coveredThrough = new Date(last.getFullYear(), last.getMonth() + 1, 0, 12);
                    const diff = (new Date(allDatesMax + 'T12:00:00') - coveredThrough) / 86400000;
                    return diff > 7;
                  })
                : [];

            const kyleAvail = dateStr => (kyleHardOffDates.has(dateStr) || kyleVacationDates.has(dateStr)) ? 'certain' : kyleSoftDates.has(dateStr) ? 'soft' : 'no';

            const commonOffDays = [];
            const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            // Cap to end of next calendar month — pilots with no data beyond that would
            // falsely appear "off" every day since no segments = off. new Date(y,m+2,0) = last day of next month.
            const nextMonthEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);
            const endDate = allDatesMax
                ? new Date(Math.min(new Date(allDatesMax + 'T12:00:00').getTime(), nextMonthEnd.getTime()))
                : nextMonthEnd;
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateStr = localDateStr(d);
                const offPilots = activeKeys.flatMap(k => {
                    if (k === 'kyle') {
                        const avail = kyleAvail(dateStr);
                        return avail !== 'no' ? [{ key: k, certain: avail === 'certain' }] : [];
                    }
                    return _isOffDutyGeneric(k, dateStr, pilotFlyingDates) ? [{ key: k, certain: true }] : [];
                });
                if (offPilots.length >= 2) commonOffDays.push({ date: new Date(d), dateStr, pilots: offPilots });
            }

            const nextOff = commonOffDays[0];
            const nextOffPreview = nextOff
                ? `<span class="text-zinc-600 text-[10px] font-normal normal-case ml-2">Next: ${nextOff.dateStr === todayStr ? 'Today' : nextOff.dateStr === tomorrowStr ? 'Tomorrow' : fmtDateShort(nextOff.date)} — ${nextOff.pilots.map(p => PILOT_NAMES[p.key].split(' ')[0]).join(', ')}</span>`
                : `<span class="text-zinc-700 text-[10px] font-normal normal-case ml-2">None found</span>`;

            const offDayRows = commonOffDays.map(({ date, dateStr, pilots }) => {
                const isToday = dateStr === todayStr;
                const isTomorrow = dateStr === tomorrowStr;
                const dayLabel = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : fmtDateShort(date);
                const filterCount = activeKeys.length;
                const isAllOff = pilots.length === filterCount;
                const rowStyle = isAllOff ? 'border-left:2px solid rgba(251,191,36,0.45);' : '';
                const countBadge = isAllOff
                    ? `<span class="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-amber-950/60 text-amber-400 border border-amber-700/60">✦ ALL OFF</span>`
                    : pilots.length >= filterCount - 1
                    ? `<span class="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-800/50">${pilots.length} of ${filterCount}</span>`
                    : pilots.length >= filterCount - 2
                    ? `<span class="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-sky-950/60 text-sky-400 border border-sky-800/50">${pilots.length} of ${filterCount}</span>`
                    : '';
                const dayLabelStyle = isAllOff ? 'color:#fbbf24;' : '';
                const chips = pilots.map(({ key: k, certain }) =>
                    `<span class="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black whitespace-nowrap" style="background:${PILOT_COLORS[k]}22;color:${PILOT_COLORS[k]};border:1px solid ${PILOT_COLORS[k]}44"><span class="w-1.5 h-1.5 rounded-full" style="background:${PILOT_COLORS[k]}"></span>${PILOT_NAMES[k].split(' ')[0]}${certain ? '' : ' · soft'}</span>`
                ).join('');
                return `<div class="flex items-center gap-2 px-4 min-w-0" style="padding-top:10px;padding-bottom:10px;${rowStyle}">
                    <div class="offday-row-chips flex items-center gap-1.5 overflow-x-auto min-w-0 flex-1" style="-webkit-overflow-scrolling:touch;scrollbar-width:none;-ms-overflow-style:none;touch-action:pan-x;padding:4px 0">${chips}</div>
                    <div class="flex items-center gap-1.5 shrink-0 ml-2 pl-1">
                        ${countBadge}
                        <div class="text-[11px] font-black whitespace-nowrap" style="${dayLabelStyle}">${dayLabel}</div>
                    </div>
                </div>`;
            }).join('');

            const filterChips = visibleCrew.map(k => {
                const active = _offDayFilter.has(k);
                const color = PILOT_COLORS[k];
                const name = PILOT_NAMES[k].split(' ')[0];
                return `<button onclick="toggleOffDayPilot('${k}')" style="flex:none;background:${active ? color + '22' : 'transparent'};color:${active ? color : '#52525b'};border:1px solid ${active ? color + '55' : '#3f3f46'};border-radius:9999px;padding:6px 14px;font-size:11px;font-weight:800;white-space:nowrap;cursor:pointer;transition:all 0.15s;-webkit-tap-highlight-color:transparent;min-height:36px;display:inline-flex;align-items:center">${name}</button>`;
            }).join('');

            if (fullView) {
                // Populate the external filter bar (outside scroll container — reliable iOS horizontal scroll)
                const chipsEl = document.getElementById('offday-filter-chips');
                if (chipsEl) chipsEl.innerHTML = filterChips;
                // Tab mode — no collapsible wrapper, no inline filter row
                el.innerHTML = `<div class="divide-y divide-zinc-800/30">
                    ${stalePilots.length ? `<div class="px-4 py-2.5 flex items-center gap-2 bg-zinc-900/40">
                        <span style="color:#92400e;font-size:11px">⚠</span>
                        <span style="font-size:10px;color:#78716c">${stalePilots.map(k => PILOT_NAMES[k].split(' ')[0]).join(', ')} ${stalePilots.length === 1 ? 'has' : 'have'} no upcoming schedule — off days may be incomplete</span>
                    </div>` : ''}
                    ${offDayRows || '<div class="px-4 py-3 text-xs text-zinc-600">No common off days found in schedule data.</div>'}
                </div>`;
                return;
            }

            const bodyHidden = wasOpen ? '' : ' hidden';
            const arrText = wasOpen ? '‹' : '›';

            el.innerHTML = `<div class="mb-4 rounded-xl border border-zinc-800/50 overflow-hidden">
                <button onclick="const b=this.parentElement.querySelector('.off-days-body');const arr=this.querySelector('.off-arr');b.classList.toggle('hidden');arr.textContent=b.classList.contains('hidden')?'›':'‹';"
                    class="w-full px-4 py-2.5 flex items-center gap-2 text-left">
                    <span class="off-arr text-zinc-600 text-xs">${arrText}</span>
                    <span class="text-[10px] font-black uppercase tracking-widest text-zinc-500">Common Off Days</span>
                    ${nextOffPreview}
                </button>
                <div class="off-days-body${bodyHidden} border-t border-zinc-800/50 divide-y divide-zinc-800/30">
                    <div class="px-4 py-2.5 flex items-center gap-2.5 border-b border-zinc-800/30">
                        <span class="text-[9px] font-black uppercase tracking-widest text-zinc-600 shrink-0">Show</span>
                        <div id="offday-filter-scroll" style="flex:1;min-width:0;display:flex;gap:6px;align-items:center;padding:2px 0">${filterChips}</div>
                    </div>
                    ${stalePilots.length ? `<div class="px-4 py-2.5 flex items-center gap-2 border-b border-zinc-800/30 bg-zinc-900/40">
                        <span style="color:#92400e;font-size:11px">⚠</span>
                        <span style="font-size:10px;color:#78716c">${stalePilots.map(k => PILOT_NAMES[k].split(' ')[0]).join(', ')} ${stalePilots.length === 1 ? 'has' : 'have'} no upcoming schedule — off days may be incomplete</span>
                    </div>` : ''}
                    ${offDayRows || '<div class="px-4 py-3 text-xs text-zinc-600">No common off days found in schedule data.</div>'}
                </div>
            </div>`;
        }

        let _overlapData = []; // stores all primary overlaps for detail modal
        let _overlapTab = 'crossings'; // 'crossings' | 'offdays'
        let _offDayYear     = null;  // null = current month
        let _offDayMonth    = null;
        let _offDaySelected = null;  // tapped date string
        let _offDayView     = 'list'; // 'list' | 'calendar'

        function switchOverlapTab(tab) {
            _overlapTab = tab;
            document.getElementById('overlap-content')?.classList.toggle('hidden', tab !== 'crossings');
            document.getElementById('offdays-content')?.classList.toggle('hidden', tab !== 'offdays');
            document.getElementById('tab-crossings')?.classList.toggle('overlap-tab-active', tab === 'crossings');
            document.getElementById('tab-offdays')?.classList.toggle('overlap-tab-active', tab === 'offdays');
            const filterBar = document.getElementById('offday-filter-bar');
            if (filterBar) {
                filterBar.style.display = tab === 'offdays' ? 'block' : 'none';
                if (tab === 'offdays' && !filterBar._wheelWired) {
                    filterBar._wheelWired = true;
                    const chipsEl = document.getElementById('offday-filter-chips');
                    if (chipsEl) {
                        chipsEl.addEventListener('wheel', e => {
                            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
                            e.preventDefault();
                            chipsEl.scrollLeft += e.deltaY;
                        }, { passive: false });
                        let _dragX = null, _dragScroll = 0, _dragging = false;
                        chipsEl.addEventListener('mousedown', e => {
                            _dragX = e.clientX; _dragScroll = chipsEl.scrollLeft; _dragging = false;
                            chipsEl.style.cursor = 'grabbing';
                        });
                        chipsEl.addEventListener('mousemove', e => {
                            if (_dragX === null) return;
                            const dx = e.clientX - _dragX;
                            if (Math.abs(dx) > 3) _dragging = true;
                            if (_dragging) { chipsEl.scrollLeft = _dragScroll - dx; e.preventDefault(); }
                        });
                        const endDrag = () => { _dragX = null; chipsEl.style.cursor = ''; };
                        chipsEl.addEventListener('mouseup', e => {
                            if (_dragging) e.stopPropagation();
                            endDrag();
                        });
                        chipsEl.addEventListener('mouseleave', endDrag);
                    }
                }
            }
            const refreshBtn = document.getElementById('overlap-refresh-btn');
            if (refreshBtn) {
                refreshBtn.onclick = tab === 'offdays' ? computeOffDays : computeOverlap;
            }
            if (tab === 'offdays') computeOffDays();
        }

        async function computeOffDays() {
            const container = document.getElementById('offdays-content');
            if (!container) return;
            container.innerHTML = '<div class="flex items-center justify-center gap-2.5 py-10 text-zinc-500 text-sm"><div class="spinner"></div><span>Loading schedules…</span></div>';
            // See computeOverlap() — yields so the spinner paints even when every
            // pilot is already cached and the fetch step below has nothing to await.
            await new Promise(r => setTimeout(r, 0));
            // Only fetch pilots we're actually allowed to see -- looping all PILOT_KEYS here
            // used to work because every pilot saw everyone; now it would just collect 403s.
            await Promise.all(visiblePilotKeys().map(async key => {
                if (!pilotsCache[key]) {
                    try { await _loadPilotOnce(key); }
                    catch(_) {}
                }
            }));
            _renderOffDayView();
        }

        function _renderOffDayView() {
            const container = document.getElementById('offdays-content');
            if (_offDayView === 'calendar') {
                if (container) { container.classList.remove('px-6'); container.classList.add('px-2'); }
                renderOffDayCalendar();
            } else {
                if (container) { container.classList.remove('px-2'); container.classList.add('px-6'); }
                if (container) {
                    container.innerHTML = '<div id="common-off-section"></div>';
                    renderCommonOffSection(false, true);
                }
            }
            const btn = document.getElementById('offday-view-toggle');
            if (btn) {
                const active = _offDayView === 'calendar';
                btn.style.background    = active ? '#1e3a5f'    : '#18181b';
                btn.style.color         = active ? '#3b82f6'    : '#a1a1aa';
                btn.style.borderColor   = active ? '#3b82f655'  : '#27272a';
            }
        }

        function toggleOffDayView() {
            _offDayView     = _offDayView === 'list' ? 'calendar' : 'list';
            _offDaySelected = null;
            _renderOffDayView();
        }

        function prevOffMonth() {
            const n = new Date();
            let y = _offDayYear ?? n.getFullYear(), m = _offDayMonth ?? n.getMonth();
            if (--m < 0) { m = 11; y--; }
            _offDayYear = y; _offDayMonth = m;
            renderOffDayCalendar();
        }

        function nextOffMonth() {
            const n = new Date();
            let y = _offDayYear ?? n.getFullYear(), m = _offDayMonth ?? n.getMonth();
            if (++m > 11) { m = 0; y++; }
            _offDayYear = y; _offDayMonth = m;
            renderOffDayCalendar();
        }

        let _offDaySheetSwipeSetup = false;
        function dismissOffDayDetail() {
            _offDaySelected = null;
            // Mobile sheet
            const sheet = document.getElementById('offday-detail-sheet');
            const panel = document.getElementById('offday-detail-panel');
            if (panel && sheet && !sheet.classList.contains('hidden')) {
                panel.style.transform = 'translateY(100%)'; panel.style.transition = 'transform 0.22s ease';
                setTimeout(() => sheet.classList.add('hidden'), 220);
            }
            // Desktop inline
            const inlineEl = document.getElementById('offday-day-detail-inline');
            if (inlineEl) inlineEl.innerHTML = '';
            document.querySelectorAll('[data-offday-date]').forEach(c => c.style.boxShadow = '');
        }

        function showOffDayDetail(dateStr) {
            if (_offDaySelected === dateStr) { dismissOffDayDetail(); return; }
            _offDaySelected = dateStr;

            const visibleCrew = getCrewVisible();
            if (!_offDayFilter) _offDayFilter = new Set(visibleCrew);
            const activeKeys = visibleCrew.filter(k => _offDayFilter.has(k));

            const _pad = n => String(n).padStart(2, '0');
            const localDateStr = d => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;
            const date = new Date(dateStr + 'T12:00:00');
            const label = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

            const pilotFlyingDates = {};
            PILOT_KEYS.forEach(k => {
                const flying = new Set();
                (pilotsCache[k]?.segments || []).forEach(s => {
                    if (s.auto_leg_cancelled) return;
                    if (k === 'kyle' && s.type === 'hard') return;
                    if (s.type !== 'flight' && s.type !== 'reserve' && s.type !== 'ground' && s.type !== 'training') return;
                    if (s.type === 'flight' && s.trip === 'PERSONAL') return;
                    if (s.type === 'reserve' && s.departure_time && s.arrival_time) {
                        const rdStr = flightLocalDate(s.departure_time, s.departure_airport) || s.departure_time.slice(0, 10);
                        const reStr = flightLocalDate(s.arrival_time,   s.departure_airport) || s.arrival_time.slice(0, 10);
                        const rd = new Date(rdStr + 'T12:00:00'), re = new Date(reStr + 'T12:00:00');
                        for (let dd = new Date(rd); dd <= re; dd.setDate(dd.getDate() + 1)) flying.add(localDateStr(dd));
                    } else {
                        const t = s.departure_time;
                        if (t) flying.add(flightLocalDate(t, s.departure_airport) || t.slice(0, 10));
                    }
                });
                pilotFlyingDates[k] = flying;
            });

            const kyleHardOff = new Set();
            const kyleVac     = new Set();
            const kyleSoft    = new Set();
            (pilotsCache['kyle']?.segments || []).forEach(s => {
                if (s.type === 'hard'     && s.departure_time) kyleHardOff.add(s.departure_time.slice(0, 10));
                if (s.type === 'vacation' && s.departure_time) kyleVac.add(s.departure_time.slice(0, 10));
                if (s.type === 'soft'     && s.departure_time) kyleSoft.add(s.departure_time.slice(0, 10));
            });

            const rows = activeKeys.map(k => {
                const soft  = k === 'kyle' && kyleSoft.has(dateStr) && !kyleHardOff.has(dateStr);
                const off   = k === 'kyle' ? (kyleHardOff.has(dateStr) || kyleVac.has(dateStr) || soft) : _isOffDutyGeneric(k, dateStr, pilotFlyingDates);
                const pc    = PILOT_COLORS[k];
                const statusLabel = soft ? 'Soft Day' : off ? 'Off' : 'Working';
                const statusColor = soft ? '#fda4af' : off ? '#22c55e' : '#52525b';
                return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #1c1c21">
                    <span style="width:8px;height:8px;border-radius:50%;background:${pc};flex-shrink:0"></span>
                    <span style="font-size:14px;font-weight:700;color:#e4e4e7;flex:1">${(PILOT_NAMES[k]||k).split(' ')[0]}</span>
                    <span style="font-size:12px;font-weight:800;color:${statusColor}">${statusLabel}</span>
                </div>`;
            }).join('');

            const detailInner = `
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                    <div style="font-size:11px;font-weight:900;color:#71717a;text-transform:uppercase;letter-spacing:0.07em">${label}</div>
                    <button onclick="dismissOffDayDetail()" style="width:26px;height:26px;border-radius:7px;background:transparent;border:1px solid #3f3f46;color:#71717a;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent">✕</button>
                </div>
                <div style="border-top:1px solid #1c1c21">${rows}</div>`;

            const isMobile = window.innerWidth < 768;

            if (isMobile) {
                // Mobile: slide-up bottom sheet
                const content = document.getElementById('offday-detail-content');
                if (content) content.innerHTML = detailInner;
                const sheet = document.getElementById('offday-detail-sheet');
                const panel = document.getElementById('offday-detail-panel');
                if (!sheet || !panel) return;
                panel.style.transform = 'translateY(100%)';
                panel.style.transition = 'none';
                sheet.classList.remove('hidden');
                requestAnimationFrame(() => {
                    panel.style.transition = 'transform 0.25s cubic-bezier(0.32,0.72,0,1)';
                    panel.style.transform  = 'translateY(0)';
                });
                if (!_offDaySheetSwipeSetup) {
                    _offDaySheetSwipeSetup = true;
                    setupSheetSwipe(panel, dismissOffDayDetail);
                }
            } else {
                // Desktop: inline card below the calendar
                const inlineEl = document.getElementById('offday-day-detail-inline');
                if (inlineEl) {
                    inlineEl.innerHTML = `<div style="background:#111;border:1px solid #27272a;border-radius:12px;padding:14px 16px;margin-top:12px;animation:fadeIn 0.15s ease">${detailInner}</div>`;
                    inlineEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }

            // Highlight selected cell
            document.querySelectorAll('[data-offday-date]').forEach(c => {
                c.style.boxShadow = c.dataset.offdayDate === dateStr ? '0 0 0 2px #a1a1aa88' : '';
            });
        }

        function renderOffDayCalendar() {
            const container = document.getElementById('offdays-content');
            if (!container) return;

            const visibleCrew = getCrewVisible();
            if (!_offDayFilter) _offDayFilter = new Set(visibleCrew);
            const activeKeys = visibleCrew.filter(k => _offDayFilter.has(k));

            const now  = new Date();
            const _pad = n => String(n).padStart(2, '0');
            const localDateStr = d => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;
            const todayStr = localDateStr(now);
            const year  = _offDayYear  ?? now.getFullYear();
            const month = _offDayMonth ?? now.getMonth();

            // Build flying-date sets for each pilot
            const pilotFlyingDates = {};
            const kyleHardOffDates = new Set();
            const kyleSoftDates = new Set();
            const kyleVacDates     = new Set();
            PILOT_KEYS.forEach(k => {
                const flying = new Set();
                (pilotsCache[k]?.segments || []).forEach(s => {
                    if (s.auto_leg_cancelled) return;
                    if (k === 'kyle' && s.type === 'hard' && s.departure_time) {
                        kyleHardOffDates.add(s.departure_time.slice(0, 10)); return;
                    }
                    if (k === 'kyle' && s.type === 'vacation' && s.departure_time) {
                        kyleVacDates.add(s.departure_time.slice(0, 10)); return;
                    }
                    if (k === 'kyle' && s.type === 'soft' && s.departure_time) {
                        kyleSoftDates.add(s.departure_time.slice(0, 10)); return;
                    }
                    if (s.type !== 'flight' && s.type !== 'reserve' && s.type !== 'ground' && s.type !== 'training') return;
                    if (s.type === 'flight' && s.trip === 'PERSONAL') return;
                    if (s.type === 'reserve' && s.departure_time && s.arrival_time) {
                        const rdStr = flightLocalDate(s.departure_time, s.departure_airport) || s.departure_time.slice(0, 10);
                        const reStr = flightLocalDate(s.arrival_time,   s.departure_airport) || s.arrival_time.slice(0, 10);
                        const rd = new Date(rdStr + 'T12:00:00'), re = new Date(reStr + 'T12:00:00');
                        for (let dd = new Date(rd); dd <= re; dd.setDate(dd.getDate() + 1)) flying.add(localDateStr(dd));
                    } else {
                        const t = s.departure_time;
                        if (t) flying.add(flightLocalDate(t, s.departure_airport) || t.slice(0, 10));
                    }
                });
                pilotFlyingDates[k] = flying;
            });

            const isOff = (k, ds) => k === 'kyle' ? (kyleHardOffDates.has(ds) || kyleVacDates.has(ds) || kyleSoftDates.has(ds)) : _isOffDutyGeneric(k, ds, pilotFlyingDates);

            // Responsive sizing
            const mob = window.innerWidth < 600;
            const cellPad    = mob ? '4px 3px'  : '7px 6px';
            const cellMinH   = mob ? '58px'     : '72px';
            const gridGap    = mob ? '3px'      : '4px';
            const pillFs     = mob ? '7px'      : '8px';
            const pillPad    = mob ? '1px 3px'  : '2px 5px';
            const pillRadius = mob ? '3px'      : '4px';
            const dateFs     = mob ? '10px'     : '11px';

            // Calendar grid
            const firstDay = new Date(year, month, 1);
            const lastDay  = new Date(year, month + 1, 0);
            const startDow = firstDay.getDay();
            const monthLabel = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

            const cells = [];
            for (let i = 0; i < startDow; i++) cells.push(null);
            for (let d = 1; d <= lastDay.getDate(); d++) {
                const dateStr   = `${year}-${_pad(month + 1)}-${_pad(d)}`;
                const offPilots = activeKeys.filter(k => isOff(k, dateStr));
                cells.push({ d, dateStr, offPilots });
            }
            while (cells.length % 7 !== 0) cells.push(null);

            const nActive = activeKeys.length;
            const dowRow = ['S','M','T','W','T','F','S'].map(l =>
                `<div style="text-align:center;font-size:${mob?'8px':'9px'};font-weight:900;text-transform:uppercase;letter-spacing:0.07em;color:#3f3f46;padding:${mob?'3px':'4px'} 0">${l}</div>`
            ).join('');

            const cellsHtml = cells.map(cell => {
                if (!cell) return `<div style="border-radius:${mob?'6px':'9px'};background:#0a0a0a;min-height:${cellMinH}"></div>`;
                const { d, dateStr, offPilots } = cell;
                const isToday    = dateStr === todayStr;
                const isSelected = dateStr === _offDaySelected;
                const allOff  = nActive > 0 && offPilots.length === nActive;
                const mostOff = nActive > 2 && offPilots.length >= nActive - 1;

                let bg     = '#0f172a';
                let border = isToday ? '1.5px solid rgba(59,130,246,0.5)' : '1px solid #1e1e24';
                if (isSelected) border = '1.5px solid rgba(161,161,170,0.55)';
                if (allOff)       { bg = 'rgba(251,191,36,0.09)';  border = '1px solid rgba(251,191,36,' + (isToday ? '0.7' : '0.32') + ')'; }
                else if (mostOff) { bg = 'rgba(34,197,94,0.06)';   border = '1px solid rgba(34,197,94,0.22)'; }

                const dateColor = allOff ? '#fbbf24' : isToday ? '#60a5fa' : '#52525b';
                const chips = offPilots.map(k => {
                    const name = (PILOT_NAMES[k]||k).split(' ')[0];
                    const pc   = PILOT_COLORS[k];
                    return `<span style="background:${pc}22;color:${pc};border:1px solid ${pc}44;border-radius:${pillRadius};font-size:${pillFs};font-weight:900;padding:${pillPad};line-height:1.4;flex-shrink:0">${name}${k === 'kyle' && kyleSoftDates.has(dateStr) && !kyleHardOffDates.has(dateStr) ? ' · soft' : ''}</span>`;
                }).join('');
                const allBadge = allOff ? `<span style="font-size:7px;font-weight:900;color:#fbbf24;line-height:1;margin-left:auto;margin-top:1px">ALL</span>` : '';

                return `<div data-offday-date="${dateStr}" onclick="showOffDayDetail('${dateStr}')"
                    style="border-radius:${mob?'6px':'9px'};background:${bg};border:${border};min-height:${cellMinH};padding:${cellPad};cursor:pointer;transition:opacity 0.12s;display:flex;flex-direction:column;gap:3px"
                    onmouseenter="this.style.opacity='0.72'" onmouseleave="this.style.opacity='1'">
                    <div style="display:flex;align-items:flex-start;gap:2px">
                        <span style="font-size:${dateFs};font-weight:${isToday ? '900' : '700'};color:${dateColor}">${d}</span>
                        ${allBadge}
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:2px;flex:1;align-content:flex-start">${chips}</div>
                </div>`;
            }).join('');

            const pilotLegend = activeKeys.map(k => {
                const name = (PILOT_NAMES[k]||k).split(' ')[0];
                const pc = PILOT_COLORS[k];
                return `<span style="background:${pc}22;color:${pc};border:1px solid ${pc}44;border-radius:4px;font-size:8px;font-weight:900;padding:2px 5px;line-height:1.4">${name}</span>`;
            }).join('');

            const cellLegend = `
                <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#a1a1aa">
                    <span style="width:12px;height:12px;border-radius:3px;background:rgba(251,191,36,0.09);border:1px solid rgba(251,191,36,0.32);display:inline-block"></span>All off
                </span>
                ${nActive > 2 ? `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#a1a1aa">
                    <span style="width:12px;height:12px;border-radius:3px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.22);display:inline-block"></span>Most off
                </span>` : ''}`;

            // Update filter chips
            const filterChips = visibleCrew.map(k => {
                const active = _offDayFilter.has(k);
                const color  = PILOT_COLORS[k];
                const name   = (PILOT_NAMES[k]||k).split(' ')[0];
                return `<button onclick="toggleOffDayPilot('${k}')" style="flex:none;background:${active ? color+'22' : 'transparent'};color:${active ? color : '#52525b'};border:1px solid ${active ? color+'55' : '#3f3f46'};border-radius:9999px;padding:6px 14px;font-size:11px;font-weight:800;white-space:nowrap;cursor:pointer;transition:all 0.15s;-webkit-tap-highlight-color:transparent;min-height:36px;display:inline-flex;align-items:center">${name}</button>`;
            }).join('');
            const chipsEl = document.getElementById('offday-filter-chips');
            if (chipsEl) chipsEl.innerHTML = filterChips;

            container.innerHTML = `<div style="padding:0 2px;padding-bottom:calc(80px + env(safe-area-inset-bottom))">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 2px 8px">
                    <button onclick="prevOffMonth()" style="width:34px;height:34px;border-radius:8px;background:#18181b;border:1px solid #27272a;color:#a1a1aa;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent">‹</button>
                    <span style="font-size:13px;font-weight:900;color:#e4e4e7;letter-spacing:0.05em;text-transform:uppercase">${monthLabel}</span>
                    <button onclick="nextOffMonth()" style="width:34px;height:34px;border-radius:8px;background:#18181b;border:1px solid #27272a;color:#a1a1aa;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent">›</button>
                </div>
                <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:${gridGap};margin-bottom:${gridGap}">${dowRow}</div>
                <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:${gridGap}">${cellsHtml}</div>
                <div style="margin-top:14px;border-top:1px solid #1c1c21;padding-top:12px;display:flex;flex-direction:column;gap:8px">
                    <div style="display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:center">${pilotLegend}</div>
                    <div style="display:flex;flex-wrap:wrap;gap:8px 14px;justify-content:center">${cellLegend}</div>
                </div>
                <div id="offday-day-detail-inline"></div>
            </div>`;

            if (_offDaySelected) {
                document.querySelectorAll('[data-offday-date]').forEach(c => {
                    c.style.boxShadow = c.dataset.offdayDate === _offDaySelected ? '0 0 0 2px #a1a1aa88' : '';
                });
            }
        }

