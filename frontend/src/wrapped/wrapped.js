        // ── Year in Review (Wrapped) ─────────────────────────────────────────────
        // Stats come from the server (GET /api/wrapped, wrapped-stats.js): one engine for every pilot, so
        // the numbers and percentiles agree. This file only draws them: ~18 slides in three themes
        // (Aurora, Cockpit, Boarding Pass), with charts and maps as animated SVG. Opens for everyone on
        // WRAPPED_OPENS; before that only admin and the preview pilots (server.js WRAPPED_PREVIEW).

        const WRAPPED_OPENS = '2026-12-15';
        const WRAPPED_PREVIEW_PILOTS = ['kyle'];
        const WRAPPED_THEMES = [
            { id: 'aurora', name: 'Aurora' },
            { id: 'cockpit', name: 'Cockpit' },
            { id: 'pass', name: 'Boarding Pass' },
        ];
        let _wrappedData = null;       // { stats, ranks, places, crewSize, preview }
        let _wrappedSlides = [];
        let _wrappedIdx = 0;
        let _wrappedPilotKey = null;
        let _wrappedBgAnim = null;
        let _wrappedAudio = null;
        let _wrappedMuted = false;
        let _wrappedTheme = (() => { try { return localStorage.getItem('cs_wrapped_theme') || 'aurora'; } catch { return 'aurora'; } })();

        function wrappedAvailable() {
            if (isDemo || myViewer) return false;
            if (!myPilot) return !!myToken; // admin
            return _localToday() >= WRAPPED_OPENS || WRAPPED_PREVIEW_PILOTS.includes(myPilot);
        }

        async function openWrapped() {
            if (!wrappedAvailable()) return;
            _wrappedPilotKey = myPilot || currentPilot;
            switchView('wrapped');
            _applyWrappedTheme();
            const area = document.getElementById('wrapped-slide-area');
            area.innerHTML = `<div class="ws"><div class="ws-kicker">Year in Review</div><div class="ws-sub">Crunching your year…</div></div>`;
            _startWrappedBg();
            _startWrappedMusic();
            try {
                const q = new URLSearchParams({ token: myToken || '' });
                if (!myPilot && _wrappedPilotKey) q.set('pilot', _wrappedPilotKey);
                const r = await fetch(`/api/wrapped?${q}`);
                const data = await r.json();
                if (!r.ok) throw new Error(data.error === 'not_open' ? `Opens ${data.opensOn}` : (data.error || 'Could not load'));
                _wrappedData = data;
            } catch (e) {
                area.innerHTML = `<div class="ws"><div class="ws-kicker">Year in Review</div><div class="ws-sub">${escapeHtml(e.message)}</div></div>`;
                return;
            }
            _wrappedSlides = _buildWrappedSlides(_wrappedData);
            _wrappedIdx = 0;
            _renderWrappedSlide();
            _setupWrappedSwipe();
        }

        function closeWrapped() {
            if (_wrappedBgAnim) { cancelAnimationFrame(_wrappedBgAnim); _wrappedBgAnim = null; }
            _stopWrappedMusic();
            switchView('grid');
        }

        function wrappedNext() {
            if (_wrappedIdx < _wrappedSlides.length - 1) { _wrappedIdx++; _renderWrappedSlide(); }
        }
        function wrappedPrev() {
            if (_wrappedIdx > 0) { _wrappedIdx--; _renderWrappedSlide(); }
        }
        function cycleWrappedTheme(ev) {
            ev?.stopPropagation();
            const i = WRAPPED_THEMES.findIndex(t => t.id === _wrappedTheme);
            _wrappedTheme = WRAPPED_THEMES[(i + 1) % WRAPPED_THEMES.length].id;
            try { localStorage.setItem('cs_wrapped_theme', _wrappedTheme); } catch {}
            _applyWrappedTheme();
            if (_wrappedSlides.length) _renderWrappedSlide();
        }
        function _applyWrappedTheme() {
            const view = document.getElementById('view-wrapped');
            if (view) view.dataset.theme = _wrappedTheme;
            const btn = document.getElementById('wrapped-theme-btn');
            if (btn) btn.textContent = WRAPPED_THEMES.find(t => t.id === _wrappedTheme)?.name || 'Theme';
        }

        function _setupWrappedSwipe() {
            const el = document.getElementById('view-wrapped');
            if (!el || el._wrappedSwipe) return;
            el._wrappedSwipe = true;
            let x0 = 0;
            el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
            el.addEventListener('touchend', e => {
                const dx = e.changedTouches[0].clientX - x0;
                if (Math.abs(dx) > 50) (dx < 0 ? wrappedNext : wrappedPrev)();
            }, { passive: true });
        }

        function _renderWrappedSlide() {
            const slide = _wrappedSlides[_wrappedIdx];
            const area = document.getElementById('wrapped-slide-area');
            if (!slide || !area) return;
            const view = document.getElementById('view-wrapped');
            if (view) { view.dataset.slide = slide.id; view.style.setProperty('--wa', slide.hue ?? 220); }
            area.innerHTML = `<div class="ws ws-${slide.id}" key="${_wrappedIdx}">${slide.html()}</div>`;
            requestAnimationFrame(() => {
                area.querySelectorAll('[data-count]').forEach(el => _wCount(el, parseFloat(el.dataset.count), parseInt(el.dataset.dec || '0', 10)));
                area.querySelectorAll('.ws-grow').forEach(el => el.classList.add('ws-go'));
            });
            const prog = document.getElementById('wrapped-progress');
            if (prog) prog.innerHTML = _wrappedSlides.map((_, i) => `<div class="ws-prog ${i < _wrappedIdx ? 'done' : i === _wrappedIdx ? 'now' : ''}"></div>`).join('');
            const dots = document.getElementById('wrapped-dots');
            if (dots) dots.textContent = `${_wrappedIdx + 1} / ${_wrappedSlides.length}`;
        }

        function _wCount(el, target, dec) {
            if (!isFinite(target)) return;
            const t0 = performance.now(), dur = 1100;
            const fmt = v => dec ? v.toFixed(dec) : Math.round(v).toLocaleString();
            const tick = now => {
                const p = Math.min((now - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
                el.textContent = fmt(target * e);
                if (p < 1) requestAnimationFrame(tick);
            };
            el.textContent = fmt(0);
            requestAnimationFrame(tick);
        }

        // ── Slides ──────────────────────────────────────────────────────────────
        const _W_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const _W_DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        function _wFmtDate(ymd, long) {
            const [y, m, d] = ymd.split('-').map(Number);
            return new Date(y, m - 1, d).toLocaleDateString('en-US', long ? { weekday: 'long', month: 'long', day: 'numeric' } : { month: 'short', day: 'numeric' });
        }
        function _wHM(mins) { const h = Math.floor(mins / 60), m = mins % 60; return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`; }
        function _wTime(hhmm) { const [h, m] = hhmm.split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
        // Airport code as the pilot knows it (STL, not KSTL), and its town.
        function _wApt(code) { return escapeHtml(/^K[A-Z]{3}$/.test(code || '') ? code.slice(1) : (code || '')); }
        function _wPlace(code) {
            const p = _wrappedData?.places?.[code] || _wrappedData?.places?.['K' + code];
            return escapeHtml(p ? p.replace(/, [A-Z]{2}$/, '') : _wApt(code));
        }
        function _wPlaceFull(code) { return escapeHtml(_wrappedData?.places?.[code] || _wrappedData?.places?.['K' + code] || _wApt(code)); }
        // Percentile badge, only when it says something good: "More than 80% of CrewSync pilots".
        function _wRank(key, phrase) {
            const r = _wrappedData?.ranks?.[key];
            if (!r) return '';
            const text = r.top ? `#1 in CrewSync${phrase ? ' for ' + phrase : ''}` : r.pct >= 50 ? `More ${phrase || ''} than ${r.pct}% of CrewSync pilots`.replace('More  ', 'More ') : '';
            return text ? `<div class="ws-badge ws-in" style="--d:1.1s">${text}</div>` : '';
        }
        const _wNum = (v, dec = 0) => `<span data-count="${v}" data-dec="${dec}">0</span>`;

        // Equirectangular projection fitted to a set of [lat, lon], for the map slides.
        function _wProjector(points, w, h, pad = 26) {
            const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
            let minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
            if (maxLat - minLat < 4) { minLat -= 2; maxLat += 2; }
            if (maxLon - minLon < 6) { minLon -= 3; maxLon += 3; }
            const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
            const sx = (w - 2 * pad) / ((maxLon - minLon) * k), sy = (h - 2 * pad) / (maxLat - minLat), s = Math.min(sx, sy);
            const ox = (w - (maxLon - minLon) * k * s) / 2, oy = (h - (maxLat - minLat) * s) / 2;
            const f = ([lat, lon]) => [ox + (lon - minLon) * k * s, oy + (maxLat - lat) * s];
            f.grid = () => {
                const out = [];
                for (let la = Math.ceil(minLat / 5) * 5; la <= maxLat; la += 5) { const [x1, y] = f([la, minLon]); const [x2] = f([la, maxLon]); out.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>`); }
                for (let lo = Math.ceil(minLon / 5) * 5; lo <= maxLon; lo += 5) { const [x, y1] = f([maxLat, lo]); const [, y2] = f([minLat, lo]); out.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>`); }
                return out.join('');
            };
            return f;
        }
        function _wRouteMap(s, w = 340, h = 300) {
            const pts = s.airportPoints.map(p => p.c);
            if (pts.length < 2) return '';
            const P = _wProjector(pts, w, h);
            const maxN = Math.max(...s.routeArcs.map(r => r.n), 1);
            const arcs = s.routeArcs.slice().reverse().map((r, i) => {
                const [x1, y1] = P(r.dc), [x2, y2] = P(r.ac);
                const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
                const cx = mx - dy * 0.18, cy = my + dx * 0.18;
                const t = r.n / maxN;
                return `<path class="ws-arc" pathLength="1" style="--d:${(0.2 + i * 0.025).toFixed(2)}s;stroke-width:${(0.8 + 2.2 * t).toFixed(1)};opacity:${(0.35 + 0.65 * t).toFixed(2)}" d="M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}"/>`;
            }).join('');
            const maxL = Math.max(...s.airportPoints.map(p => p.n), 1);
            const dots = s.airportPoints.map(p => { const [x, y] = P(p.c); return `<circle class="ws-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(1.6 + 3 * p.n / maxL).toFixed(1)}"/>`; }).join('');
            const labels = s.topAirports.slice(0, 5).map(([a]) => {
                const p = s.airportPoints.find(q => q.a === a); if (!p) return '';
                const [x, y] = P(p.c);
                return `<text class="ws-maplabel" x="${(x + 6).toFixed(1)}" y="${(y - 5).toFixed(1)}">${_wApt(a)}</text>`;
            }).join('');
            return `<svg class="ws-map" viewBox="0 0 ${w} ${h}" role="img" aria-label="Map of the routes you flew"><g class="ws-grid">${P.grid()}</g>${arcs}${dots}${labels}</svg>`;
        }

        function _buildWrappedSlides(d) {
            const s = d.stats, first = escapeHtml(s.firstName), out = [];
            const add = (id, hue, html) => out.push({ id, hue, html });
            const hours = Math.round(s.blockMins / 60);

            add('intro', 225, () => `
                <div class="ws-kicker ws-in">CrewSync Wrapped</div>
                <div class="ws-hero ws-in" style="--d:.15s">${first}'s</div>
                <div class="ws-year ws-in" style="--d:.35s">${s.year}</div>
                <div class="ws-sub ws-in" style="--d:.7s">${s.legs ? 'Your year in the air.' : 'Not much flying logged yet this year.'}</div>
                <div class="ws-hint ws-in" style="--d:1.2s">Tap to start</div>`);
            if (!s.legs) return out;

            add('hours', 210, () => `
                <div class="ws-kicker ws-in">Block time</div>
                <div class="ws-big ws-in" style="--d:.1s">${_wNum(hours)}</div>
                <div class="ws-unit ws-in" style="--d:.25s">hours in the air</div>
                <div class="ws-sub ws-in" style="--d:.6s">That's ${(s.blockMins / 1440).toFixed(1)} full days of your life at altitude.</div>
                ${_wRank('blockMins', 'block time')}`);

            add('legs', 160, () => `
                <div class="ws-kicker ws-in">Flights</div>
                <div class="ws-big ws-in" style="--d:.1s">${_wNum(s.legs)}</div>
                <div class="ws-unit ws-in" style="--d:.25s">legs flown</div>
                <div class="ws-sub ws-in" style="--d:.6s">Across ${s.flyingDays} flying days. Averaging ${_wHM(Math.round(s.blockMins / s.legs))} each.</div>
                ${_wRank('legs', 'legs')}`);

            const laps = s.earthLaps;
            add('distance', 185, () => `
                <div class="ws-kicker ws-in">Distance</div>
                <div class="ws-big ws-in" style="--d:.1s">${_wNum(s.nm)}</div>
                <div class="ws-unit ws-in" style="--d:.25s">nautical miles</div>
                <svg class="ws-globe ws-in" style="--d:.4s" viewBox="0 0 120 120" aria-hidden="true">
                    <circle cx="60" cy="60" r="46" class="ws-globe-track"/>
                    <circle cx="60" cy="60" r="46" class="ws-globe-fill ws-grow" pathLength="1" style="--p:${Math.min(laps % 1 || (laps >= 1 ? 1 : 0), 1).toFixed(3)}"/>
                    <text x="60" y="66" text-anchor="middle" class="ws-globe-text">${laps >= 1 ? laps.toFixed(1) + '×' : Math.round(laps * 100) + '%'}</text>
                </svg>
                <div class="ws-sub ws-in" style="--d:.9s">${laps >= 1 ? `Enough to circle the Earth ${laps.toFixed(1)} times` : `${Math.round(laps * 100)}% of the way around the Earth`}${s.moonTrips >= 0.1 ? `, or ${Math.round(s.moonTrips * 100)}% of the way to the Moon` : ''}.</div>
                ${_wRank('nm', 'miles')}`);

            add('map', 230, () => `
                <div class="ws-kicker ws-in">Where you went</div>
                ${_wRouteMap(s)}
                <div class="ws-sub ws-in" style="--d:1.6s">${s.routeArcs.length} different routes, drawn in the order you flew them most.</div>`);

            add('airports', 35, () => `
                <div class="ws-kicker ws-in">Airports</div>
                <div class="ws-big ws-in" style="--d:.1s">${_wNum(s.airports)}</div>
                <div class="ws-unit ws-in" style="--d:.25s">airports</div>
                ${s.newAirports?.count ? `<div class="ws-sub ws-in" style="--d:.5s">${s.newAirports.count} of them were brand new to you this year.</div>` : ''}
                <div class="ws-rows">${s.topAirports.map(([a, n], i) => `
                    <div class="ws-row ws-in" style="--d:${(0.7 + i * 0.12).toFixed(2)}s"><span class="ws-row-k">${i + 1}</span><span class="ws-row-name">${_wApt(a)} <em>${_wPlace(a)}</em></span><span class="ws-row-v">${n}</span></div>`).join('')}
                </div>
                ${_wRank('airports', 'airports')}`);

            if (s.topRoutes[0]) {
                const [r, n] = s.topRoutes[0], [dep, arr] = r.split('-');
                add('route', 265, () => `
                    <div class="ws-kicker ws-in">Your route</div>
                    <div class="ws-route">
                        <div class="ws-route-apt ws-in ws-from-left" style="--d:.15s">${_wApt(dep)}<small>${_wPlace(dep)}</small></div>
                        <div class="ws-route-line ws-in" style="--d:.45s"><span></span></div>
                        <div class="ws-route-apt ws-in ws-from-right" style="--d:.15s">${_wApt(arr)}<small>${_wPlace(arr)}</small></div>
                    </div>
                    <div class="ws-sub ws-in" style="--d:.8s">You flew it <b>${n} times</b>. It practically knows you by name.</div>`);
            }

            const maxM = Math.max(...s.months.map(m => m.legs), 1);
            add('months', 330, () => `
                <div class="ws-kicker ws-in">Month by month</div>
                <div class="ws-headline ws-in" style="--d:.1s">${s.busiestMonth ? `${_W_MONTHS[s.busiestMonth.i]} was your busiest` : 'Your year'}</div>
                <div class="ws-bars">${s.months.map((m, i) => `
                    <div class="ws-bar ${s.busiestMonth?.i === i ? 'top' : ''}"><div class="ws-bar-fill ws-grow" style="--h:${(m.legs / maxM).toFixed(3)};--d:${(0.3 + i * 0.06).toFixed(2)}s"></div><span>${_W_MONTHS[i][0]}</span></div>`).join('')}
                </div>
                <div class="ws-sub ws-in" style="--d:1.2s">${s.busiestMonth ? `${s.busiestMonth.legs} legs and ${_wHM(s.busiestMonth.block)} of block in ${_W_MONTHS[s.busiestMonth.i]}.` : ''}</div>`);

            const maxH = Math.max(...s.hours, 1), peakH = s.hours.indexOf(maxH);
            add('clock', 260, () => `
                <div class="ws-kicker ws-in">When you fly</div>
                <svg class="ws-clock" viewBox="0 0 240 240" role="img" aria-label="Departures by hour of the day">
                    <circle cx="120" cy="120" r="44" class="ws-clock-face"/>
                    ${s.hours.map((n, h) => {
                        const a = (h / 24) * Math.PI * 2 - Math.PI / 2, len = 8 + 62 * n / maxH;
                        const x1 = 120 + Math.cos(a) * 50, y1 = 120 + Math.sin(a) * 50, x2 = 120 + Math.cos(a) * (50 + len), y2 = 120 + Math.sin(a) * (50 + len);
                        return `<line class="ws-clock-bar ws-grow ${h === peakH ? 'top' : ''}" pathLength="1" style="--d:${(0.2 + h * 0.04).toFixed(2)}s" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
                    }).join('')}
                    <text x="120" y="22" text-anchor="middle" class="ws-clock-l">MIDNIGHT</text><text x="226" y="124" text-anchor="end" class="ws-clock-l">6A</text>
                    <text x="120" y="232" text-anchor="middle" class="ws-clock-l">NOON</text><text x="14" y="124" class="ws-clock-l">6P</text>
                    <text x="120" y="116" text-anchor="middle" class="ws-clock-peak">${_wTime(String(peakH).padStart(2, '0') + ':00').replace(':00', '')}</text>
                    <text x="120" y="134" text-anchor="middle" class="ws-clock-l">MOST DEPARTURES</text>
                </svg>
                <div class="ws-sub ws-in" style="--d:1.3s">${s.earliest ? `Earliest takeoff ${_wTime(s.earliest.time)} out of ${_wApt(s.earliest.leg.dep)}.` : ''} ${s.latest ? `Latest landing ${_wTime(s.latest.time)} into ${_wApt(s.latest.leg.arr)}.` : ''}</div>`);

            const maxW = Math.max(...s.weekdays, 1), favDay = s.weekdays.indexOf(maxW);
            add('weekdays', 290, () => `
                <div class="ws-kicker ws-in">Favorite day</div>
                <div class="ws-headline ws-in" style="--d:.1s">${_W_DAYS[favDay]}s</div>
                <div class="ws-hbars">${s.weekdays.map((n, i) => `
                    <div class="ws-hbar ${i === favDay ? 'top' : ''}"><span>${_W_DAYS[i].slice(0, 3)}</span><div><i class="ws-grow" style="--w:${(n / maxW).toFixed(3)};--d:${(0.3 + i * 0.08).toFixed(2)}s"></i></div><b>${n}</b></div>`).join('')}
                </div>
                <div class="ws-sub ws-in" style="--d:1.2s">You took off on a ${_W_DAYS[favDay]} ${maxW} times this year.</div>`);

            if (s.earlyStarts || s.lateNights) {
                add('early', 45, () => `
                    <div class="ws-kicker ws-in">Early birds &amp; night owls</div>
                    <div class="ws-split">
                        <div class="ws-in" style="--d:.15s"><div class="ws-mid">${_wNum(s.earlyStarts)}</div><div class="ws-unit">takeoffs before 6 AM</div></div>
                        <div class="ws-in" style="--d:.35s"><div class="ws-mid">${_wNum(s.lateNights)}</div><div class="ws-unit">landings after 11 PM</div></div>
                    </div>
                    ${s.redEyes ? `<div class="ws-sub ws-in" style="--d:.8s">Plus ${s.redEyes} red-eye${s.redEyes === 1 ? '' : 's'} through the night.</div>` : ''}
                    ${_wRank('earlyStarts', 'early starts') || _wRank('lateNights', 'late nights')}`);
            }

            if (s.busiestDay && s.busiestDay.legs >= 3) {
                const b = s.busiestDay;
                add('busyday', 12, () => `
                    <div class="ws-kicker ws-in">Your busiest day</div>
                    <div class="ws-headline ws-in" style="--d:.1s">${_wFmtDate(b.date, true)}</div>
                    <div class="ws-chain">${b.stops.map((a, i) => `<div class="ws-stop ws-in" style="--d:${(0.4 + i * 0.22).toFixed(2)}s"><b>${_wApt(a)}</b><span>${_wPlace(a)}</span></div>`).join('<div class="ws-chain-link ws-in" style="--d:.3s"></div>')}</div>
                    <div class="ws-sub ws-in" style="--d:${(0.6 + b.stops.length * 0.22).toFixed(2)}s">${b.legs} legs and ${_wHM(b.block)} of block in one day.</div>`);
            }

            if (s.streak.days >= 3) {
                add('streak', 140, () => `
                    <div class="ws-kicker ws-in">Longest streak</div>
                    <div class="ws-big ws-in" style="--d:.1s">${_wNum(s.streak.days)}</div>
                    <div class="ws-unit ws-in" style="--d:.25s">days in a row with a flight</div>
                    <div class="ws-days ws-in" style="--d:.5s">${Array.from({ length: s.streak.days }, (_, i) => `<i style="--d:${(0.6 + i * 0.08).toFixed(2)}s"></i>`).join('')}</div>
                    <div class="ws-sub ws-in" style="--d:1.2s">Ending ${_wFmtDate(s.streak.end)}.</div>
                    ${_wRank('streak', 'streaks')}`);
            }

            if (s.nightsAway) {
                add('nights', 250, () => `
                    <div class="ws-kicker ws-in">On the road</div>
                    <div class="ws-big ws-in" style="--d:.1s">${_wNum(s.nightsAway)}</div>
                    <div class="ws-unit ws-in" style="--d:.25s">nights away from home</div>
                    <div class="ws-sub ws-in" style="--d:.6s">That's ${Math.round(s.nightsAway / 3.65)}% of the year spent in someone else's bed.</div>
                    ${s.crashPad ? `<div class="ws-card ws-in" style="--d:.9s">Home away from home: <b>${_wPlaceFull(s.crashPad.airport)}</b>, ${s.crashPad.nights} nights.</div>` : ''}
                    ${_wRank('nightsAway', 'nights away')}`);
            }

            if (s.topLayoverCities.length) {
                add('layovers', 20, () => `
                    <div class="ws-kicker ws-in">Layover cities</div>
                    <div class="ws-headline ws-in" style="--d:.1s">You slept in ${_wPlace(s.topLayoverCities[0][0])} the most</div>
                    <div class="ws-rows">${s.topLayoverCities.map(([a, n], i) => `
                        <div class="ws-row ws-in" style="--d:${(0.4 + i * 0.14).toFixed(2)}s"><span class="ws-row-k">${i + 1}</span><span class="ws-row-name">${_wPlaceFull(a)}</span><span class="ws-row-v">${n} night${n === 1 ? '' : 's'}</span></div>`).join('')}
                    </div>`);
            }

            if (s.longestLayover && s.longestLayover.mins >= 12 * 60) {
                const L = s.longestLayover;
                add('layover', 300, () => `
                    <div class="ws-kicker ws-in">Longest layover</div>
                    <div class="ws-headline ws-in" style="--d:.1s">${_wPlaceFull(L.airport)}</div>
                    <div class="ws-big ws-in" style="--d:.3s">${_wNum(Math.round(L.mins / 60))}</div>
                    <div class="ws-unit ws-in" style="--d:.4s">hours on the ground</div>
                    <div class="ws-sub ws-in" style="--d:.8s">${_wFmtDate(L.from)} to ${_wFmtDate(L.to)}. Hope you found a good spot for dinner.</div>
                    ${_wRank('longestLayover', 'layovers')}`);
            }

            if (s.longestLeg) {
                const Lg = s.longestLeg, Sh = s.shortestLeg;
                add('legs2', 200, () => `
                    <div class="ws-kicker ws-in">Longest and shortest</div>
                    <div class="ws-ticket ws-in" style="--d:.15s"><span>Longest</span><b>${_wApt(Lg.dep)} → ${_wApt(Lg.arr)}</b><em>${_wHM(Lg.block)} · ${Lg.nm.toLocaleString()} nm · ${_wFmtDate(Lg.date)}</em></div>
                    ${Sh ? `<div class="ws-ticket ws-in" style="--d:.45s"><span>Shortest</span><b>${_wApt(Sh.dep)} → ${_wApt(Sh.arr)}</b><em>${_wHM(Sh.block)} · ${Sh.nm.toLocaleString()} nm · ${_wFmtDate(Sh.date)}</em></div>` : ''}
                    ${s.avgSpeedKts ? `<div class="ws-sub ws-in" style="--d:.8s">Average speed over the ground, gate to gate: ${s.avgSpeedKts} knots.</div>` : ''}`);
            }

            const c = s.compass;
            if (c.north && c.south && c.east && c.west) {
                add('compass', 175, () => {
                    const pts = [c.north, c.south, c.east, c.west].map(p => [p.lat, p.lon]);
                    const P = _wProjector([...pts, ...s.airportPoints.map(p => p.c)], 300, 230);
                    const mark = (p, k, i) => { const [x, y] = P([p.lat, p.lon]); return `<g class="ws-cmark ws-in" style="--d:${(0.4 + i * 0.25).toFixed(2)}s"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5"/><text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}">${k} ${_wApt(p.airport)}</text></g>`; };
                    return `
                    <div class="ws-kicker ws-in">The edges of your map</div>
                    <svg class="ws-map ws-map-sm" viewBox="0 0 300 230" role="img" aria-label="Your farthest airports in each direction">
                        <g class="ws-grid">${P.grid()}</g>
                        ${s.airportPoints.map(p => { const [x, y] = P(p.c); return `<circle class="ws-dot dim" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6"/>`; }).join('')}
                        ${mark(c.north, 'N', 0)}${mark(c.east, 'E', 1)}${mark(c.south, 'S', 2)}${mark(c.west, 'W', 3)}
                    </svg>
                    <div class="ws-sub ws-in" style="--d:1.5s">Farthest north ${_wPlace(c.north.airport)}, south ${_wPlace(c.south.airport)}, east ${_wPlace(c.east.airport)} and west ${_wPlace(c.west.airport)}.</div>`;
                });
            }

            if (s.tails.count || s.aircraftTypes.length) {
                add('fleet', 210, () => s.tails.count ? `
                    <div class="ws-kicker ws-in">Your fleet</div>
                    <div class="ws-big ws-in" style="--d:.1s">${_wNum(s.tails.count)}</div>
                    <div class="ws-unit ws-in" style="--d:.25s">different aircraft</div>
                    ${s.tails.top[0] ? `<div class="ws-card ws-in" style="--d:.6s">Your favorite: <b>${escapeHtml(displayTail(s.tails.top[0][0], _wrappedPilotKey))}</b>, ${s.tails.top[0][1]} legs together.</div>` : ''}` : `
                    <div class="ws-kicker ws-in">Your fleet</div>
                    <div class="ws-rows">${s.aircraftTypes.map(([t, n], i) => `<div class="ws-row ws-in" style="--d:${(0.3 + i * 0.14).toFixed(2)}s"><span class="ws-row-k">${i + 1}</span><span class="ws-row-name">${escapeHtml(t)}</span><span class="ws-row-v">${n} legs</span></div>`).join('')}</div>`);
            }

            if (s.rides.legs) {
                add('rides', 0, () => `
                    <div class="ws-kicker ws-in">In the back</div>
                    <div class="ws-big ws-in" style="--d:.1s">${_wNum(s.rides.legs)}</div>
                    <div class="ws-unit ws-in" style="--d:.25s">deadheads and commutes</div>
                    <div class="ws-sub ws-in" style="--d:.6s">${s.rides.nm.toLocaleString()} more nautical miles as a passenger. Window or aisle?</div>`);
            }

            add('summary', 225, () => `
                <div class="ws-share ws-in">
                    <div class="ws-share-top"><span>CrewSync Wrapped</span><span>${s.year}</span></div>
                    <div class="ws-share-name">${first}</div>
                    <div class="ws-share-grid">
                        <div><b>${hours.toLocaleString()}</b><span>hours</span></div>
                        <div><b>${s.legs.toLocaleString()}</b><span>legs</span></div>
                        <div><b>${s.nm.toLocaleString()}</b><span>nm</span></div>
                        <div><b>${s.airports}</b><span>airports</span></div>
                        <div><b>${s.nightsAway}</b><span>nights away</span></div>
                        <div><b>${s.earthLaps.toFixed(1)}×</b><span>around Earth</span></div>
                    </div>
                    ${s.topRoutes[0] ? `<div class="ws-share-foot">Top route ${s.topRoutes[0][0].split('-').map(_wApt).join(' → ')}</div>` : ''}
                </div>
                <div class="ws-actions ws-in" style="--d:.5s">
                    <button type="button" onclick="event.stopPropagation();_wrappedIdx=0;_renderWrappedSlide()">Replay</button>
                    <button type="button" onclick="event.stopPropagation();shareWrapped()">Share</button>
                </div>`);
            return out;
        }

        async function shareWrapped() {
            const s = _wrappedData?.stats; if (!s) return;
            const text = `My ${s.year} on CrewSync: ${Math.round(s.blockMins / 60)} hours, ${s.legs} legs, ${s.nm.toLocaleString()} nm, ${s.airports} airports, ${s.nightsAway} nights on the road.`;
            try { if (navigator.share) { await navigator.share({ text }); return; } } catch { return; }
            const ok = await copyText(text);
            showToast(ok ? 'Copied. Paste it anywhere.' : 'Take a screenshot to share', ok ? 'success' : 'info', 2500);
        }

        // ── Music: a real recorded track, public/audio/wrapped.mp3 ──────────────
        // Free, app-licensed music (Pixabay Music: no credit required), looped with a fade in and out. Played
        // through Web Audio so the fades work on iPhone too (iOS ignores an <audio> element's volume). No file
        // means no music, never the old synth. Browsers only start sound after a tap, so a Wrapped opened by
        // link starts its music on the first tap instead.
        const WRAPPED_TRACK = '/audio/wrapped.mp3';
        const _WM_VOL = 0.55;
        function _startWrappedMusic() {
            if (_wrappedAudio) { _wrappedAudio.ctx.resume?.(); return; }
            try {
                const el = new Audio(WRAPPED_TRACK);
                el.loop = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const gain = ctx.createGain();
                gain.gain.value = 0;
                ctx.createMediaElementSource(el).connect(gain);
                gain.connect(ctx.destination);
                _wrappedAudio = { ctx, gain, el };
                el.addEventListener('error', () => { const b = document.getElementById('wrapped-mute-btn'); if (b) b.style.display = 'none'; });
                const go = () => {
                    if (!_wrappedAudio || _wrappedAudio.el !== el) return;
                    ctx.resume?.();
                    el.play().then(() => {
                        const now = ctx.currentTime;
                        gain.gain.cancelScheduledValues(now);
                        gain.gain.setValueAtTime(gain.gain.value, now);
                        gain.gain.linearRampToValueAtTime(_wrappedMuted ? 0 : _WM_VOL, now + 2.5);
                    }).catch(() => {
                        // No tap yet (opened from a link): start on the first one.
                        document.getElementById('view-wrapped')?.addEventListener('click', go, { once: true });
                    });
                };
                go();
                _updateMuteBtn();
            } catch (e) { console.warn('Wrapped music:', e); }
        }

        function _stopWrappedMusic() {
            if (!_wrappedAudio) return;
            const { ctx, gain, el } = _wrappedAudio; _wrappedAudio = null;
            try {
                const now = ctx.currentTime;
                gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(gain.gain.value, now);
                gain.gain.linearRampToValueAtTime(0, now + 0.8);
                setTimeout(() => { try { el.pause(); ctx.close(); } catch {} }, 1000);
            } catch {}
        }

        function toggleWrappedMute(ev) {
            ev?.stopPropagation();
            _wrappedMuted = !_wrappedMuted;
            if (_wrappedAudio) {
                const { ctx, gain, el } = _wrappedAudio, now = ctx.currentTime;
                if (!_wrappedMuted && el.paused) { ctx.resume?.(); el.play().catch(() => {}); }
                gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(gain.gain.value, now);
                gain.gain.linearRampToValueAtTime(_wrappedMuted ? 0 : _WM_VOL, now + 0.4);
            }
            _updateMuteBtn();
        }

        function _updateMuteBtn() {
            const btn = document.getElementById('wrapped-mute-btn');
            if (btn) btn.textContent = _wrappedMuted ? '🔇' : '🔊';
        }

        function _startWrappedBg() {
            const canvas = document.getElementById('wrapped-bg-canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            let W, H, stars;
            function resize() {
                W = canvas.width  = canvas.offsetWidth;
                H = canvas.height = canvas.offsetHeight;
                stars = Array.from({ length: 130 }, () => ({
                    x: Math.random() * W, y: Math.random() * H,
                    r: Math.random() * 1.3 + 0.2,
                    a: Math.random(),
                    da: (Math.random() - 0.5) * 0.007,
                }));
            }
            resize();
            const ro = new ResizeObserver(resize);
            ro.observe(canvas);
            if (_wrappedBgAnim) cancelAnimationFrame(_wrappedBgAnim);
            function draw() {
                ctx.clearRect(0, 0, W, H);
                for (const s of stars) {
                    s.a += s.da;
                    if (s.a <= 0.04 || s.a >= 0.95) s.da *= -1;
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(148,180,255,${Math.max(0.04, s.a) * 0.55})`;
                    ctx.fill();
                }
                if (document.getElementById('view-wrapped')?.classList.contains('view-active')) {
                    _wrappedBgAnim = requestAnimationFrame(draw);
                } else {
                    ro.disconnect();
                }
            }
            _wrappedBgAnim = requestAnimationFrame(draw);
        }

