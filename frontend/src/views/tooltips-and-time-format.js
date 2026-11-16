        function positionTooltip(x, y) {
            const tw = tooltip.offsetWidth;
            const th = tooltip.offsetHeight;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const offset = 14;
            let tx = x + offset;
            let ty = y + offset;
            if (tx + tw > vw - 8) tx = x - tw - offset;
            if (ty + th > vh - 8) ty = y - th - offset;
            if (tx < 8) tx = 8;
            if (ty < 8) ty = 8;
            tooltip.style.left = tx + 'px';
            tooltip.style.top = ty + 'px';
        }
        function showTooltip(html, x, y) {
            tooltip.innerHTML = html;
            tooltip.style.display = 'block';
            positionTooltip(x, y);
        }
        function moveTooltip(x, y) { positionTooltip(x, y); }
        function hideTooltip() { tooltip.style.display = 'none'; }

        const _tzCache = {}; // populated on demand by airportTz() via tz-lookup + coordinates
        function airportTz(code) {
            if (!code) return null;
            const c = code.toUpperCase().trim();
            if (_tzCache[c]) return _tzCache[c];
            // Derive from coordinates if tz-lookup is available
            const coords = AIRPORTS[c] || (typeof AIRPORT_DB !== 'undefined' && (AIRPORT_DB.byIcao[c] || AIRPORT_DB.byIata[c]));
            if (coords && typeof tzlookup === 'function') {
                try {
                    const tz = tzlookup(coords[0], coords[1]);
                    if (tz) { _tzCache[c] = tz; return tz; }
                } catch (e) { /* ignore */ }
            }
            return null;
        }
        const _TZ_SHORT = { 'EST':'ET','EDT':'ET','CST':'CT','CDT':'CT','MST':'MT','MDT':'MT','PST':'PT','PDT':'PT','AKST':'AKT','AKDT':'AKT','HST':'HT','HDT':'HT','AST':'AT','ADT':'AT' };
        function tzAbbr(airportCode, iso) {
            const tz = airportTz(airportCode);
            if (!tz) return '';
            try {
                const d = new Date(iso || Date.now());
                const raw = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
                    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value || '';
                return _TZ_SHORT[raw] || raw;
            } catch (e) { return ''; }
        }
        function formatTimeISO(iso, airportCode) {
            if (!iso) return '—';
            try {
                const d = new Date(iso);
                if (isNaN(d.getTime())) return '—';
                const isUtc = iso.endsWith('Z') || iso.endsWith('z');
                if (isUtc && airportCode) {
                    const tz = airportTz(airportCode);
                    if (tz) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz });
                }
                return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            } catch (e) {
                return '—';
            }
        }
        function formatDurationMinutes(mins) {
            if (mins <= 0 || !isFinite(mins)) return '—';
            const h = Math.floor(mins / 60); const m = Math.round(mins % 60);
            if (h > 0) return `${h}h ${m}m`;
            return `${m}m`;
        }
        // The pilot's very next leg, only if it leaves this airport. A later departure from here with
        // other flying in between isn't a layover: Sam's 11/1 LGA arrival used to pair with 11/24.
        function getNextLegFrom(airport, afterTimeStr) {
            let next = null, nextMs = Infinity;
            for (const s of segments) {
                if ((s.type !== 'flight' && s.type !== 'ground') || s.cancelled || !(s.departureTime > afterTimeStr)) continue;
                const ms = (flightUTCTime(s.departureTime, s.departureAirport) || new Date(s.departureTime)).getTime();
                if (ms < nextMs) { next = s; nextMs = ms; }
            }
            return next?.departureAirport === airport ? next : null;
        }
        function layoverLabel(groundMins, atHome, sameDay) {
            if (groundMins <= 0) return '';
            if (atHome) return sameDay ? `Turn ${formatDurationMinutes(groundMins)}` : '';
            return (groundMins < 240 || sameDay) ? `Turn ${formatDurationMinutes(groundMins)}` : `Overnight ${formatDurationMinutes(groundMins)}`;
        }
        function attachTooltips() {
            if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
            document.querySelectorAll('.flight-item').forEach(el => {
                function onEnter(e) {
                    const dep = el.dataset.depTime; const arr = el.dataset.arrTime; const tail = el.dataset.tail || '—'; const trip = el.dataset.trip || ''; const flightNum = el.dataset.flight || '';
                    const depApt = el.dataset.depApt || '';
                    const arrApt = el.dataset.arrApt || '';
                    const depDate = dep ? new Date(dep) : null;
                    const arrDate = arr ? new Date(arr) : null;
                    const blockStored = el.dataset.block !== '' ? parseInt(el.dataset.block, 10) : NaN;
                    const blockMins = !isNaN(blockStored) ? blockStored : ((depDate && arrDate && !isNaN(depDate.getTime()) && !isNaN(arrDate.getTime())) ? (arrDate - depDate) / 60000 : null);

                    let layoverText = '';
                    try {
                        if (arr && arrApt) {
                            const nextLeg = getNextLegFrom(arrApt, arr);
                            if (nextLeg) {
                                const groundMins = (new Date(nextLeg.departureTime) - new Date(arr)) / 60000;
                                const atHome = isHomeOrBaseAt(arrApt, currentPilot, arr);
                                const sameDay = flightLocalDate(arr, arrApt) === flightLocalDate(nextLeg.departureTime, arrApt);
                                layoverText = layoverLabel(groundMins, atHome, sameDay);
                            }
                        }
                    } catch (er) { layoverText = ''; }

                    const dhLabel = el.dataset.dh === 'true' ? `<div style="font-size:11px;color:#f9a8d4;font-weight:700;margin-bottom:4px">DH Flight</div>` : '';
                    const redeyeLabel = el.dataset.redeye === 'arr'
                        ? `<div style="font-size:11px;color:#93c5fd;font-weight:700;margin-bottom:4px">🌙 Overnight — departed the previous day</div>`
                        : el.dataset.redeye === 'dep'
                        ? `<div style="font-size:11px;color:#93c5fd;font-weight:700;margin-bottom:4px">🌙 Overnight — arrives the next day</div>`
                        : '';
                    const flightLabel = deriveCallsign({ flightNumber: flightNum, tail }, currentPilot) || '';
                    const html = `<div style="font-weight:800;margin-bottom:6px">${aptLabel(depApt, currentPilot)} → ${aptLabel(arrApt, currentPilot)} ${flightLabel ? `<span style=\"font-weight:600;color:#9fb8ff;margin-left:6px\">${flightLabel}</span>` : ''}</div>` +
                        dhLabel +
                        redeyeLabel +
                        `<div style="font-size:12px;color:#cbd5e1">Dep: ${formatTimeISO(dep, depApt)}<span style="font-size:9px;color:#52525b;font-weight:700;margin-left:3px">${tzAbbr(depApt, dep)}</span> • Arr: ${formatTimeISO(arr, arrApt)}<span style="font-size:9px;color:#52525b;font-weight:700;margin-left:3px">${tzAbbr(arrApt, arr)}</span></div>` +
                        `<div style="font-size:12px;color:#cbd5e1">Block: ${formatDurationMinutes(blockMins)}</div>` +
                        `<div style="font-size:12px;color:#cbd5e1">Tail: ${tail}</div>` +
                        (layoverText ? `<div style="margin-top:6px;color:#ffd57a;font-weight:700">${layoverText}</div>` : '');

                    showTooltip(html, e.clientX, e.clientY);
                }
                function onMove(e) { moveTooltip(e.clientX, e.clientY); }
                function onLeave() { hideTooltip(); }
                el.removeEventListener('mouseenter', el._enter);
                el.removeEventListener('mousemove', el._move);
                el.removeEventListener('mouseleave', el._leave);
                el._enter = onEnter; el._move = onMove; el._leave = onLeave;
                el.addEventListener('mouseenter', onEnter);
                el.addEventListener('mousemove', onMove);
                el.addEventListener('mouseleave', onLeave);
            });

            // Reserve slot tooltips
            document.querySelectorAll('.reserve-item').forEach(el => {
                function onEnter(e) {
                    const depTime = el.dataset.depTime;
                    const arrTime = el.dataset.arrTime;
                    const depApt  = el.dataset.depApt || '';
                    const arrApt  = el.dataset.arrApt || '';
                    const resType = el.dataset.resType || 'RES';
                    const typeLabels = { RESR: 'Red-Eye Reserve', RESP: 'PM Reserve', RESA: 'AM Reserve' };
                    const typeLabel  = typeLabels[resType] || 'On-Call Reserve';
                    const depFmt = depTime ? formatTimeISO(depTime, depApt) : '—';
                    const arrFmt = arrTime ? formatTimeISO(arrTime, arrApt) : '—';
                    const depTz  = depApt  ? tzAbbr(depApt, depTime)  : '';
                    const arrTz  = arrApt  ? tzAbbr(arrApt, arrTime)  : '';
                    const tzTag  = (lbl) => lbl ? `<span style="font-size:9px;color:#52525b;font-weight:700;margin-left:3px">${lbl}</span>` : '';
                    const durMs  = (depTime && arrTime) ? new Date(arrTime) - new Date(depTime) : 0;
                    const resRedeyeLabel = el.dataset.redeye === 'arr'
                        ? `<div style="font-size:11px;color:#93c5fd;font-weight:700;margin-bottom:4px">🌙 Overnight — started the previous day</div>`
                        : el.dataset.redeye === 'dep'
                        ? `<div style="font-size:11px;color:#93c5fd;font-weight:700;margin-bottom:4px">🌙 Overnight — continues into the next day</div>`
                        : el.dataset.redeye === 'mid'
                        ? `<div style="font-size:11px;color:#93c5fd;font-weight:700;margin-bottom:4px">🌙 Multi-day on-call — in effect all day</div>`
                        : '';
                    const html   = `<div style="font-weight:800;margin-bottom:6px;color:#fbbf24">ON CALL — ${typeLabel}</div>` +
                        resRedeyeLabel +
                        (depApt ? `<div style="font-size:12px;color:#fbbf24;margin-bottom:4px">Base: ${depApt}</div>` : '') +
                        `<div style="font-size:12px;color:#cbd5e1">Start: ${depFmt}${tzTag(depTz)}</div>` +
                        `<div style="font-size:12px;color:#cbd5e1">End: &nbsp;&nbsp;${arrFmt}${tzTag(arrTz)}</div>` +
                        (durMs > 0 ? `<div style="font-size:12px;color:#cbd5e1;margin-top:4px">Duration: ${formatDurationMinutes(durMs / 60000)}</div>` : '');
                    showTooltip(html, e.clientX, e.clientY);
                }
                function onMove(e) { moveTooltip(e.clientX, e.clientY); }
                function onLeave() { hideTooltip(); }
                el.removeEventListener('mouseenter', el._enter);
                el.removeEventListener('mousemove', el._move);
                el.removeEventListener('mouseleave', el._leave);
                el._enter = onEnter; el._move = onMove; el._leave = onLeave;
                el.addEventListener('mouseenter', onEnter);
                el.addEventListener('mousemove', onMove);
                el.addEventListener('mouseleave', onLeave);
            });

            // Ground transfer tooltips
            document.querySelectorAll('.ground-item').forEach(el => {
                function onEnter(e) {
                    const depApt   = el.dataset.depApt || '';
                    const arrApt   = el.dataset.arrApt || '';
                    const depTime  = el.dataset.depTime || '';
                    const arrTime  = el.dataset.arrTime || '';
                    const code     = el.dataset.flight || '';
                    let layoverText = '';
                    try {
                        if (arrApt && arrTime) {
                            const nextLeg = getNextLegFrom(arrApt, arrTime);
                            if (nextLeg) {
                                const gm = (new Date(nextLeg.departureTime) - new Date(arrTime)) / 60000;
                                const atHome = isHomeOrBaseAt(arrApt, currentPilot, arrTime);
                                const sameDay = flightLocalDate(arrTime, arrApt) === flightLocalDate(nextLeg.departureTime, arrApt);
                                layoverText = layoverLabel(gm, atHome, sameDay);
                            }
                        }
                    } catch (_) {}
                    const depFmt = depTime ? formatTimeISO(depTime, depApt) : '';
                    const arrFmt = arrTime ? formatTimeISO(arrTime, arrApt) : '';
                    const depTz  = depApt && depTime ? tzAbbr(depApt, depTime) : '';
                    const arrTz  = arrApt && arrTime ? tzAbbr(arrApt, arrTime) : '';
                    const tzTag  = (lbl) => lbl ? `<span style="font-size:9px;color:#52525b;font-weight:700;margin-left:3px">${lbl}</span>` : '';
                    const html = `<div style="font-weight:800;margin-bottom:6px;color:#71717a">Ground Transfer</div>` +
                        `<div style="font-size:13px;font-weight:700;color:#e4e4e7">${aptLabel(depApt, currentPilot)} → ${aptLabel(arrApt, currentPilot)}</div>` +
                        (code ? `<div style="font-size:11px;color:#52525b;margin-top:3px">${code}</div>` : '') +
                        (depFmt ? `<div style="font-size:12px;color:#cbd5e1;margin-top:6px">${depFmt}${tzTag(depTz)} → ${arrFmt}${tzTag(arrTz)}</div>` : '') +
                        (layoverText ? `<div style="margin-top:8px;color:#ffd57a;font-weight:700">${layoverText} at ${aptLabel(arrApt, currentPilot)}</div>` : '');
                    showTooltip(html, e.clientX, e.clientY);
                }
                function onMove(e) { moveTooltip(e.clientX, e.clientY); }
                function onLeave() { hideTooltip(); }
                el.removeEventListener('mouseenter', el._enter);
                el.removeEventListener('mousemove', el._move);
                el.removeEventListener('mouseleave', el._leave);
                el._enter = onEnter; el._move = onMove; el._leave = onLeave;
                el.addEventListener('mouseenter', onEnter);
                el.addEventListener('mousemove', onMove);
                el.addEventListener('mouseleave', onLeave);
            });
        }

