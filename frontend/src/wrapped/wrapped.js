        // ── Wrapped / Year in Review ──────────────────────────────────────────

        let _wrappedSlideIdx      = 0;
        let _wrappedSlides        = [];
        let _wrappedStats         = null;
        let _wrappedBgAnim        = null;
        let _wrappedFilter        = 'work';   // 'work' | 'personal' | 'all'
        let _wrappedMapInst       = null;
        let _wrappedAirportCoords = {};       // icao → {lat,lon,name}
        let _wrappedPilotKey      = null;
        let _wrappedMode          = 'slides'; // 'slides' | 'detail'
        let _wrappedNm            = null;     // null=loading, number=ready
        let _wrappedAudio         = null;     // Web Audio context
        let _wrappedMuted         = false;

        function openWrapped() {
            const target = currentPilot || myPilot || PILOT_KEYS[0];
            _wrappedPilotKey = target;
            _wrappedFilter   = 'work';
            _wrappedMode     = 'slides';
            switchView('wrapped');
            renderWrapped(target);
            _startWrappedMusic();
        }

        function closeWrapped() {
            if (_wrappedBgAnim) { cancelAnimationFrame(_wrappedBgAnim); _wrappedBgAnim = null; }
            if (_wrappedMapInst) { _wrappedMapInst.remove(); _wrappedMapInst = null; }
            _stopWrappedMusic();
            switchView('grid');
        }

        // ── Wrapped music: 8-bar C-major melody, ~22s loop, precise Web Audio scheduling ──
        // Melody: [frequency_hz, duration_in_quarter_beats]
        // 0 = rest. Encoded at BPM=88, 4/4 time.
        const _WM_BPM = 88;
        const _WM_BEAT = 60 / _WM_BPM;
        // prettier-ignore
        const _WM_MELODY = [
            // Bar 1 — opening: E5 G5 C6 | E5 D5
            [659.25,0.5],[783.99,0.5],[1046.5,1.0],[659.25,0.5],[587.33,0.5],
            // Bar 2 — answer: C5 G4 A4 B4 C5
            [523.25,1.0],[392.00,0.5],[440.00,0.5],[493.88,0.5],[523.25,0.5],
            // Bar 3 — rise: E5 G5 A5 | G5 E5
            [659.25,0.5],[783.99,0.5],[880.00,1.0],[783.99,0.5],[659.25,0.5],
            // Bar 4 — breathe: D5(hold) rest
            [587.33,2.0],[0,2.0],
            // Bar 5 — second phrase higher: G5 A5 C6 | A5 G5
            [783.99,0.5],[880.00,0.5],[1046.5,1.0],[880.00,0.5],[783.99,0.5],
            // Bar 6 — walking line: E5 F5 G5 A5 | G5 E5
            [659.25,0.5],[698.46,0.5],[783.99,0.5],[880.00,0.5],[783.99,0.5],[659.25,0.5],
            // Bar 7 — climb: D5 E5 F5 G5 A5 B5
            [587.33,0.5],[659.25,0.5],[698.46,0.5],[783.99,0.5],[880.00,0.5],[987.77,0.5],
            // Bar 8 — resolution: C6(hold) rest
            [1046.5,2.0],[0,2.0],
        ];
        const _WM_DUR = _WM_MELODY.reduce((s,[,d]) => s + d * _WM_BEAT, 0);

        function _startWrappedMusic() {
            if (_wrappedAudio) return;
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const master = ctx.createGain();
                master.gain.setValueAtTime(0, ctx.currentTime);
                master.gain.linearRampToValueAtTime(_wrappedMuted ? 0 : 0.2, ctx.currentTime + 2.0);
                master.connect(ctx.destination);

                // Reverb (1.8s decay)
                const revLen = Math.floor(ctx.sampleRate * 1.8);
                const revBuf = ctx.createBuffer(2, revLen, ctx.sampleRate);
                for (let c = 0; c < 2; c++) {
                    const d = revBuf.getChannelData(c);
                    for (let i = 0; i < revLen; i++) d[i] = (Math.random()*2-1) * Math.exp(-i/(ctx.sampleRate*0.7));
                }
                const reverb = ctx.createConvolver(); reverb.buffer = revBuf;
                const revGain = ctx.createGain(); revGain.gain.value = 0.32;
                reverb.connect(revGain); revGain.connect(master);

                // Open low-pass
                const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 5000; lpf.Q.value = 0.6;
                lpf.connect(master); lpf.connect(reverb);

                // Sustained Cmaj7 pads (barely-there background harmony)
                const padOscs = [261.63, 329.63, 392.00, 493.88].flatMap(freq => {
                    const a = ctx.createOscillator(); a.type = 'sine'; a.frequency.value = freq;
                    const b = ctx.createOscillator(); b.type = 'sine'; b.frequency.value = freq * 1.0015;
                    const g = ctx.createGain(); g.gain.value = 0.022;
                    a.connect(g); b.connect(g); g.connect(lpf);
                    a.start(); b.start();
                    return [a, b];
                });

                // Schedule one full pass of the melody + bass starting at `startAt`
                function schedulePass(startAt) {
                    // Bass hits on beats 1 and 3 of each bar
                    const bars = Math.ceil(_WM_DUR / (4 * _WM_BEAT));
                    for (let bar = 0; bar < bars; bar++) {
                        [0, 2].forEach(beat => {
                            const t = startAt + bar * 4 * _WM_BEAT + beat * _WM_BEAT;
                            const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 65.41; // C2
                            const g = ctx.createGain();
                            g.gain.setValueAtTime(0.3, t);
                            g.gain.exponentialRampToValueAtTime(0.03, t + _WM_BEAT * 0.65);
                            g.gain.linearRampToValueAtTime(0, t + _WM_BEAT * 0.92);
                            o.connect(g); g.connect(lpf);
                            o.start(t); o.stop(t + _WM_BEAT);
                        });
                    }
                    // Melody notes
                    let t = startAt;
                    _WM_MELODY.forEach(([freq, beats]) => {
                        const dur = beats * _WM_BEAT;
                        if (freq > 0) {
                            const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = freq;
                            // Blend in a sine an octave down for warmth
                            const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = freq / 2;
                            const env = ctx.createGain();
                            env.gain.setValueAtTime(0, t);
                            env.gain.linearRampToValueAtTime(0.07, t + 0.018);
                            env.gain.setValueAtTime(0.055, t + dur * 0.62);
                            env.gain.linearRampToValueAtTime(0, t + dur * 0.88);
                            const subG = ctx.createGain(); subG.gain.value = 0.3;
                            osc.connect(env); sub.connect(subG); subG.connect(env);
                            env.connect(lpf);
                            osc.start(t); osc.stop(t + dur);
                            sub.start(t); sub.stop(t + dur);
                        }
                        t += dur;
                    });
                    return startAt + _WM_DUR; // next loop's start time
                }

                let nextPassAt = ctx.currentTime + 1.2;
                function loop() {
                    if (!_wrappedAudio) return;
                    if (nextPassAt < ctx.currentTime) nextPassAt = ctx.currentTime + 0.15;
                    nextPassAt = schedulePass(nextPassAt);
                    // Re-schedule ~1s before the current pass ends
                    const msUntilReschedule = Math.max((nextPassAt - ctx.currentTime - 1.0) * 1000, 200);
                    _wrappedAudio._loopTimer = setTimeout(loop, msUntilReschedule);
                }
                loop();

                _wrappedAudio = { ctx, master, padOscs };
                _updateMuteBtn();
            } catch(e) { console.warn('Wrapped music:', e); }
        }

        function _stopWrappedMusic() {
            if (!_wrappedAudio) return;
            try {
                clearTimeout(_wrappedAudio._loopTimer);
                _wrappedAudio.master.gain.linearRampToValueAtTime(0, _wrappedAudio.ctx.currentTime + 1.0);
                const wa = _wrappedAudio; _wrappedAudio = null;
                setTimeout(() => { try { wa.ctx.close(); } catch {} }, 1600);
            } catch {}
        }

        function toggleWrappedMute() {
            _wrappedMuted = !_wrappedMuted;
            if (_wrappedAudio) {
                const now = _wrappedAudio.ctx.currentTime;
                _wrappedAudio.master.gain.cancelScheduledValues(now);
                _wrappedAudio.master.gain.linearRampToValueAtTime(_wrappedMuted ? 0 : 0.18, now + 0.3);
            }
            _updateMuteBtn();
        }

        function _updateMuteBtn() {
            const btn = document.getElementById('wrapped-mute-btn');
            if (btn) btn.textContent = _wrappedMuted ? '🔇' : '🔊';
        }

        function _filterSegs(segments, filter) {
            return segments.filter(s => {
                if (s.type !== 'flight') return false;
                const isPersonal = s.trip === 'PERSONAL' || s.trip === 'COMMUTE';
                if (filter === 'work')     return !isPersonal;
                if (filter === 'personal') return isPersonal;
                return true;
            });
        }

        function computeWrappedStats(pilotKey, filter) {
            filter = filter || _wrappedFilter || 'work';
            const data = pilotsCache[pilotKey];
            if (!data?.segments) return null;

            const year = new Date().getFullYear();
            const segs = data.segments.filter(s => {
                if (s.auto_leg_cancelled) return false;
                const dt = s.departure_time || s.arrival_time || '';
                return dt.startsWith(`${year}-`);
            });

            const work = _filterSegs(segs, filter);

            const blockMins = work.reduce((sum, f) => {
                if (f.block_minutes > 0) return sum + f.block_minutes;
                // Fallback: compute from departure/arrival time diff (Schedaero may omit block_minutes)
                if (f.departure_time && f.arrival_time) {
                    const diff = Math.round((new Date(f.arrival_time) - new Date(f.departure_time)) / 60000);
                    return sum + (diff > 0 ? diff : 0);
                }
                return sum;
            }, 0);

            const airports = new Set();
            work.forEach(f => {
                if (f.departure_airport) airports.add(f.departure_airport.toUpperCase());
                if (f.arrival_airport)   airports.add(f.arrival_airport.toUpperCase());
            });

            // Route frequency
            const routeCount = {};
            work.forEach(f => {
                if (f.departure_airport && f.arrival_airport && f.departure_airport !== f.arrival_airport) {
                    const r = `${f.departure_airport.toUpperCase()}→${f.arrival_airport.toUpperCase()}`;
                    routeCount[r] = (routeCount[r] || 0) + 1;
                }
            });
            const topRoutes = Object.entries(routeCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
            const topRoute  = topRoutes[0];

            // Airport landings
            const airportVisits = {};
            work.forEach(f => {
                if (f.arrival_airport) {
                    const a = f.arrival_airport.toUpperCase();
                    airportVisits[a] = (airportVisits[a] || 0) + 1;
                }
            });
            const topAirports = Object.entries(airportVisits).sort((a, b) => b[1] - a[1]).slice(0, 10);

            // Tail frequency
            const tailCount = {};
            work.forEach(f => { if (f.tail) tailCount[f.tail] = (tailCount[f.tail] || 0) + 1; });
            const topTails = Object.entries(tailCount).sort((a, b) => b[1] - a[1]).slice(0, 8);

            // Monthly
            const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            const MONTH_SHORT  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const monthCount   = {};
            work.forEach(f => {
                const m = (f.departure_time || '').slice(0, 7);
                if (m) monthCount[m] = (monthCount[m] || 0) + 1;
            });
            const busiestEntry = Object.entries(monthCount).sort((a, b) => b[1] - a[1])[0];
            const busiestMonth = busiestEntry
                ? { label: MONTH_NAMES[parseInt(busiestEntry[0].split('-')[1]) - 1], count: busiestEntry[1] }
                : null;
            const monthlyBreakdown = MONTH_SHORT.map((label, i) => {
                const key = `${year}-${String(i + 1).padStart(2, '0')}`;
                return { label, count: monthCount[key] || 0 };
            }).filter(m => m.count > 0);

            const longest = work.reduce((best, f) =>
                (f.block_minutes || 0) > (best?.block_minutes || 0) ? f : best
            , null);
            const withTime = work.filter(f => f.block_minutes > 0);
            const shortest = withTime.length > 0 ? withTime.reduce((b, f) => f.block_minutes < b.block_minutes ? f : b) : null;

            const usesUtc = pilotUsesUtc(pilotKey);

            // Extract local HH:MM at the relevant airport (handles UTC pilots correctly)
            function _localHHMM(isoStr, airportCode) {
                if (!isoStr) return null;
                if (!usesUtc) return isoStr.slice(11, 16);
                try {
                    const tz = airportTz(airportCode);
                    if (tz) {
                        const d = new Date(isoStr);
                        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
                        const h = parts.find(p => p.type === 'hour')?.value   || '00';
                        const m = parts.find(p => p.type === 'minute')?.value || '00';
                        return `${h}:${m}`;
                    }
                } catch {}
                return isoStr.slice(11, 16);
            }

            function _localHour(isoStr, airportCode) {
                const hhmm = _localHHMM(isoStr, airportCode);
                if (!hhmm) return NaN;
                return parseInt(hhmm.slice(0, 2));
            }

            const earlyCount = work.filter(f => {
                const h = _localHour(f.departure_time, f.departure_airport);
                return !isNaN(h) && h < 6;
            }).length;
            const lateCount = work.filter(f => {
                const h = _localHour(f.arrival_time, f.arrival_airport);
                return !isNaN(h) && h >= 22;
            }).length;
            const dhCount = work.filter(f => f.is_dh).length;

            let earliestDep = null;
            work.forEach(f => {
                const t = _localHHMM(f.departure_time, f.departure_airport);
                if (t && (!earliestDep || t < earliestDep)) earliestDep = t;
            });
            let latestArr = null;
            work.forEach(f => {
                const t = _localHHMM(f.arrival_time, f.arrival_airport);
                if (t && (!latestArr || t > latestArr)) latestArr = t;
            });

            const today = new Date();
            const monthThrough = MONTH_NAMES[today.getMonth()];

            return {
                year, monthThrough, filter,
                totalBlockHours: (blockMins / 60).toFixed(1),
                totalBlockMins: blockMins,
                totalLegs: work.length,
                uniqueAirports: airports.size,
                topRoute, topRoutes, topAirports, topTails,
                busiestMonth, monthlyBreakdown,
                longest, shortest, earlyCount, lateCount, dhCount,
                earliestDep, latestArr,
                pilotName: data.name || pilotKey,
                segments: work,
            };
        }

        function _buildWrappedSlides(s) {
            const slides = [];
            slides.push({ id: 'hero' });
            slides.push({ id: 'hours',    value: s.totalBlockHours, label: 'hours aloft' });
            slides.push({ id: 'legs',     value: s.totalLegs,       label: s.totalLegs === 1 ? 'landing' : 'landings' });
            slides.push({ id: 'airports', value: s.uniqueAirports,  label: 'airports visited' });
            slides.push({ id: 'distance' }); // NM loaded async via _wrappedNm
            if (s.topRoute) {
                const [route, count] = s.topRoute;
                const [dep, arr] = route.split('→');
                slides.push({ id: 'route', dep, arr, count });
            }
            if (s.busiestMonth) slides.push({ id: 'month', month: s.busiestMonth.label, count: s.busiestMonth.count });
            if (s.longest) {
                const hrs  = Math.floor(s.longest.block_minutes / 60);
                const mins = s.longest.block_minutes % 60;
                slides.push({ id: 'longest', dep: s.longest.departure_airport, arr: s.longest.arrival_airport, hrs, mins });
            }
            if (s.earlyCount > 0) slides.push({ id: 'early', value: s.earlyCount, label: 'pre-dawn departures' });
            if (s.dhCount > 0)    slides.push({ id: 'dh',    value: s.dhCount,    label: 'deadhead legs' });
            slides.push({ id: 'outro' });
            return slides;
        }

        // Count-up animation for wrapped stat slides
        function _wCountUp(el, target, dur) {
            if (!el) return;
            const isDec = String(target).includes('.');
            const targetN = parseFloat(target);
            if (isNaN(targetN) || targetN === 0) { el.textContent = target; return; }
            const t0 = performance.now();
            const tick = now => {
                const p = Math.min((now - t0) / dur, 1);
                const e = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
                el.textContent = isDec ? (targetN * e).toFixed(1) : Math.round(targetN * e).toLocaleString();
                if (p < 1) requestAnimationFrame(tick);
                else el.textContent = isDec ? target : Math.round(targetN).toLocaleString();
            };
            requestAnimationFrame(tick);
        }

        const _SLIDE_GLOWS = {
            hero:     'radial-gradient(ellipse at 50% 35%, rgba(29,78,216,0.45) 0%, transparent 65%)',
            hours:    'radial-gradient(ellipse at 50% 45%, rgba(59,130,246,0.3) 0%, transparent 62%)',
            legs:     'radial-gradient(ellipse at 50% 45%, rgba(16,185,129,0.28) 0%, transparent 62%)',
            airports: 'radial-gradient(ellipse at 50% 45%, rgba(245,158,11,0.28) 0%, transparent 62%)',
            distance: 'radial-gradient(ellipse at 50% 45%, rgba(20,184,166,0.3) 0%, transparent 62%)',
            route:    'radial-gradient(ellipse at 50% 45%, rgba(139,92,246,0.28) 0%, transparent 62%)',
            month:    'radial-gradient(ellipse at 50% 45%, rgba(244,63,94,0.25) 0%, transparent 62%)',
            longest:  'radial-gradient(ellipse at 50% 45%, rgba(14,165,233,0.28) 0%, transparent 62%)',
            early:    'radial-gradient(ellipse at 50% 45%, rgba(251,191,36,0.25) 0%, transparent 62%)',
            dh:       'radial-gradient(ellipse at 50% 45%, rgba(100,116,139,0.25) 0%, transparent 62%)',
            outro:    'radial-gradient(ellipse at 50% 55%, rgba(29,78,216,0.4) 0%, transparent 65%)',
        };

        function _wrappedSlideHTML(slide, stats) {
            const s = stats;
            if (slide.id === 'hero') return `
                <div class="wslide" style="animation:wrapped-in 0.5s ease forwards">
                    <div class="wslide-eyebrow">CrewSync Wrapped</div>
                    <span class="wslide-icon">✈</span>
                    <div class="wslide-hero-name">${s.pilotName.split(' ')[0]}</div>
                    <div style="font-size:clamp(60px,17vw,92px);font-weight:200;color:#fff;line-height:1;letter-spacing:-0.04em;margin-top:6px;opacity:0;animation:wrapped-in 0.5s ease 0.25s forwards">${s.year}</div>
                    <div class="wslide-hero-range" style="margin-top:14px">${s.monthThrough} YTD</div>
                    <div style="font-size:11px;color:#1d4ed8;margin-top:6px;letter-spacing:0.08em">TAP TO BEGIN</div>
                </div>`;

            if (slide.id === 'hours') {
                const days = (parseFloat(slide.value) / 24).toFixed(1);
                return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Block Time</div>
                    <span class="wslide-icon">⏱</span>
                    <div class="wslide-big" data-countup="${slide.value}" data-countup-dec="1">0.0</div>
                    <div class="wslide-label">hours aloft</div>
                    <div class="wslide-context">≈ ${days} full days in the cockpit</div>
                </div>`;
            }
            if (slide.id === 'legs') return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Landings</div>
                    <span class="wslide-icon">🛬</span>
                    <div class="wslide-big" data-countup="${slide.value}">0</div>
                    <div class="wslide-label">${slide.label}</div>
                    <div class="wslide-context">greased every single one</div>
                </div>`;
            if (slide.id === 'airports') return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Airports</div>
                    <span class="wslide-icon">📍</span>
                    <div class="wslide-big" data-countup="${slide.value}">0</div>
                    <div class="wslide-label">airports visited</div>
                </div>`;
            if (slide.id === 'distance') {
                const nm = _wrappedNm;
                if (nm === null || nm === 0) return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Distance Flown</div>
                    <span class="wslide-icon">🌐</span>
                    <div class="wslide-big" style="font-size:40px;color:#475569">${nm === null ? 'computing…' : '—'}</div>
                    ${nm === null ? '<div class="wslide-context">fetching airport data</div>' : ''}
                </div>`;
                const earthLaps = nm / 21638;
                const earthTxt = earthLaps >= 1 ? `${earthLaps.toFixed(2)}× around Earth` : `${Math.round(earthLaps * 100)}% of the way around Earth`;
                return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Distance Flown</div>
                    <span class="wslide-icon">🌐</span>
                    <div class="wslide-big" data-countup="${Math.round(nm)}">0</div>
                    <div class="wslide-label">nautical miles</div>
                    <div class="wslide-context" style="color:#14b8a6;font-size:13px;margin-top:12px;font-weight:600">${earthTxt}</div>
                </div>`;
            }
            if (slide.id === 'route') return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Most Flown Route</div>
                    <span class="wslide-icon">🗺</span>
                    <div style="display:flex;align-items:center;justify-content:center;margin-top:4px;gap:4px">
                        <span class="wslide-apt" style="opacity:0;animation:wrapped-slide-right 0.4s ease 0.1s forwards">${aptLabel(slide.dep, _wrappedPilotKey)}</span>
                        <span class="wslide-arrow" style="opacity:0;animation:wrapped-in 0.3s ease 0.3s forwards">→</span>
                        <span class="wslide-apt" style="opacity:0;animation:wrapped-slide-left 0.4s ease 0.1s forwards">${aptLabel(slide.arr, _wrappedPilotKey)}</span>
                    </div>
                    <div class="wslide-count" style="margin-top:14px">${slide.count} ${slide.count === 1 ? 'time' : 'times'} this year</div>
                </div>`;
            if (slide.id === 'month') return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Busiest Month</div>
                    <span class="wslide-icon">📅</span>
                    <div class="wslide-month" style="opacity:0;animation:wrapped-in 0.5s ease 0.1s forwards">${slide.month}</div>
                    <div class="wslide-label" style="margin-top:16px"><span data-countup="${slide.count}">0</span> legs</div>
                </div>`;
            if (slide.id === 'longest') return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Longest Leg</div>
                    <span class="wslide-icon">🛫</span>
                    <div style="display:flex;align-items:center;justify-content:center;margin-top:4px;gap:4px">
                        <span class="wslide-apt" style="opacity:0;animation:wrapped-slide-right 0.4s ease 0.1s forwards">${aptLabel(slide.dep, _wrappedPilotKey)}</span>
                        <span class="wslide-arrow" style="opacity:0;animation:wrapped-in 0.3s ease 0.3s forwards">→</span>
                        <span class="wslide-apt" style="opacity:0;animation:wrapped-slide-left 0.4s ease 0.1s forwards">${aptLabel(slide.arr, _wrappedPilotKey)}</span>
                    </div>
                    <div class="wslide-label" style="margin-top:16px;font-size:28px;letter-spacing:-0.01em;color:#e2e8f0;font-weight:300">${slide.hrs}h ${String(slide.mins).padStart(2,'0')}m</div>
                </div>`;
            if (slide.id === 'early') return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Early Mornings</div>
                    <span class="wslide-icon">🌙</span>
                    <div class="wslide-big" data-countup="${slide.value}">0</div>
                    <div class="wslide-label">pre-dawn departures</div>
                    <div class="wslide-context">alarm before sunrise — respect</div>
                </div>`;
            if (slide.id === 'dh') return `
                <div class="wslide" style="animation:wrapped-in 0.4s ease forwards">
                    <div class="wslide-eyebrow">Deadheads</div>
                    <span class="wslide-icon">💺</span>
                    <div class="wslide-big" data-countup="${slide.value}">0</div>
                    <div class="wslide-label">deadhead legs</div>
                    <div class="wslide-context">paid to ride</div>
                </div>`;
            if (slide.id === 'outro') return `
                <div class="wslide" style="animation:wrapped-in 0.45s ease forwards;text-align:center">
                    <div class="wslide-eyebrow">That's a wrap</div>
                    <span class="wslide-icon" style="font-size:56px">✈</span>
                    <div style="color:#94a3b8;font-size:15px;line-height:1.8;margin-top:4px">Keep the shiny side up,<br><span style="color:#fff;font-weight:700">${s.pilotName.split(' ')[0]}.</span></div>
                    <button onclick="openWrappedDetail()" style="margin-top:32px;padding:14px 32px;background:linear-gradient(135deg,#1d4ed8,#3b82f6);border:none;border-radius:14px;color:#fff;font-size:12px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;cursor:pointer;position:relative;z-index:20;box-shadow:0 0 30px rgba(59,130,246,0.4)">View Full Report →</button>
                </div>`;
            return '';
        }

        function _renderWrappedSlide() {
            const slide = _wrappedSlides[_wrappedSlideIdx];
            if (!slide || !_wrappedStats) return;

            const area = document.getElementById('wrapped-slide-area');
            if (area) {
                area.style.background = _SLIDE_GLOWS[slide.id] || 'none';
                area.innerHTML = _wrappedSlideHTML(slide, _wrappedStats);
                // Trigger count-up on all [data-countup] elements after paint
                requestAnimationFrame(() => {
                    area.querySelectorAll('[data-countup]').forEach(el => {
                        _wCountUp(el, el.dataset.countup, 950);
                    });
                });
            }

            const prog = document.getElementById('wrapped-progress');
            if (prog) {
                prog.innerHTML = _wrappedSlides.map((_, i) => {
                    const bg = i < _wrappedSlideIdx ? '#3b82f6' : i === _wrappedSlideIdx ? '#93c5fd' : 'rgba(255,255,255,0.12)';
                    return `<div style="flex:1;height:3px;border-radius:2px;background:${bg};transition:background 0.25s"></div>`;
                }).join('');
            }

            const dots = document.getElementById('wrapped-dots');
            if (dots) {
                dots.innerHTML = _wrappedSlides.map((_, i) => {
                    const a = i === _wrappedSlideIdx;
                    return `<div style="width:${a?'20px':'6px'};height:6px;border-radius:3px;background:${a?'#3b82f6':'rgba(255,255,255,0.18)'};transition:all 0.25s ease"></div>`;
                }).join('');
            }
        }

        function renderWrapped(pilotKey) {
            _wrappedMode = 'slides';
            _wrappedPilotKey = pilotKey;
            // Show slide elements with their correct display values (can't use '' — that drops
            // the original inline display:grid/flex and collapses children to zero height)
            const _showMap = { 'wrapped-progress':'flex', 'wrapped-slide-area':'flex', 'wrapped-dots':'flex', 'wrapped-tap-zones':'grid' };
            Object.entries(_showMap).forEach(([id, disp]) => {
                const el = document.getElementById(id);
                if (el) el.style.display = disp;
            });
            const detail = document.getElementById('wrapped-detail');
            if (detail) detail.style.display = 'none';

            const stats = computeWrappedStats(pilotKey, _wrappedFilter);
            if (!stats) {
                const area = document.getElementById('wrapped-slide-area');
                if (area) area.innerHTML = '<div style="color:#475569;font-size:13px;letter-spacing:0.05em">Loading…</div>';
                loadPilot(pilotKey).then(() => renderWrapped(pilotKey));
                return;
            }
            _wrappedStats    = stats;
            _wrappedSlides   = _buildWrappedSlides(stats);
            _wrappedSlideIdx = 0;
            _wrappedNm       = null; // kick off async distance fetch
            _renderWrappedSlide();
            _startWrappedBg();
            // Restore slide controls if coming back from detail
            ['wrapped-mute-btn','wrapped-close-btn'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = '';
            });
            // Prefetch airport coords for distance slide
            const _distCodes = [...new Set(stats.segments.flatMap(f => [f.departure_airport, f.arrival_airport].filter(Boolean)).map(c => c.toUpperCase()))];
            _fetchWrappedAirportCoords(_distCodes).then(coords => {
                let nm = 0;
                stats.segments.forEach(f => {
                    const dc = coords[f.departure_airport?.toUpperCase()];
                    const ac = coords[f.arrival_airport?.toUpperCase()];
                    if (dc && ac) nm += _haversineNm(dc.lat, dc.lon, ac.lat, ac.lon);
                });
                _wrappedNm = nm;
                if (_wrappedSlides[_wrappedSlideIdx]?.id === 'distance') _renderWrappedSlide();
            });

            // Touch swipe (register once)
            const el = document.getElementById('view-wrapped');
            if (el && !el._wrappedSwipe) {
                el._wrappedSwipe = true;
                let tx0 = 0;
                el.addEventListener('touchstart', e => {
                    if (_wrappedMode === 'detail') return;
                    tx0 = e.touches[0].clientX;
                }, { passive: true });
                el.addEventListener('touchend', e => {
                    if (_wrappedMode === 'detail') return;
                    const dx = e.changedTouches[0].clientX - tx0;
                    if (Math.abs(dx) > 50) { dx < 0 ? wrappedNext() : wrappedPrev(); }
                }, { passive: true });
            }
        }

        function wrappedNext() {
            if (_wrappedSlideIdx < _wrappedSlides.length - 1) {
                _wrappedSlideIdx++;
                _renderWrappedSlide();
            } else {
                openWrappedDetail();
            }
        }

        function wrappedPrev() {
            if (_wrappedSlideIdx > 0) {
                _wrappedSlideIdx--;
                _renderWrappedSlide();
            }
        }

        // ── Detail view ────────────────────────────────────────────────────────

        function openWrappedDetail() {
            _wrappedMode = 'detail';
            ['wrapped-progress','wrapped-dots','wrapped-tap-zones'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });
            const slideArea = document.getElementById('wrapped-slide-area');
            if (slideArea) slideArea.style.display = 'none';
            // Hide slide-only controls so they don't overlap the detail page cards
            ['wrapped-mute-btn','wrapped-close-btn'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });

            let detail = document.getElementById('wrapped-detail');
            if (!detail) {
                detail = document.createElement('div');
                detail.id = 'wrapped-detail';
                detail.style.cssText = 'position:absolute;inset:0;overflow-y:auto;z-index:15;-webkit-overflow-scrolling:touch;padding-top:env(safe-area-inset-top,0px);padding-bottom:max(24px,env(safe-area-inset-bottom,0px))';
                document.getElementById('view-wrapped').appendChild(detail);
            }
            detail.style.display = '';
            renderWrappedDetail();
        }

        async function renderWrappedDetail() {
            const detail = document.getElementById('wrapped-detail');
            if (!detail) return;
            detail.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#475569;font-size:13px;letter-spacing:0.06em">Building report…</div>';

            const s = computeWrappedStats(_wrappedPilotKey, _wrappedFilter);
            if (!s) return;
            _wrappedStats = s;

            // Fetch airport lat/lon for map + distance
            const codes = [...new Set(s.segments.flatMap(f => [f.departure_airport, f.arrival_airport].filter(Boolean)).map(c => c.toUpperCase()))];
            const coords = await _fetchWrappedAirportCoords(codes);

            // Distance
            let totalNm = 0;
            s.segments.forEach(f => {
                const dc = coords[f.departure_airport?.toUpperCase()];
                const ac = coords[f.arrival_airport?.toUpperCase()];
                if (dc && ac) totalNm += _haversineNm(dc.lat, dc.lon, ac.lat, ac.lon);
            });
            const earthCircumNm = 21638;
            const earthLaps     = totalNm / earthCircumNm;

            // Avg block time
            const avgBlock = s.totalLegs > 0 ? Math.round(s.totalBlockMins / s.totalLegs) : 0;
            const avgH = Math.floor(avgBlock / 60), avgM = avgBlock % 60;

            function fmtHM(hhmm) {
                if (!hhmm) return '—';
                const [h, m] = hhmm.split(':').map(Number);
                const ap = h >= 12 ? 'pm' : 'am';
                return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ap}`;
            }

            // Filter chips
            const filterLabels = { work: 'Work', personal: 'Personal', all: 'All' };
            const chipHTML = ['work','personal','all'].map(f => {
                const active = f === _wrappedFilter;
                return `<button onclick="setWrappedFilter('${f}')" style="padding:6px 16px;border-radius:20px;border:1px solid ${active?'#3b82f6':'rgba(255,255,255,0.1)'};background:${active?'rgba(29,78,216,0.6)':'transparent'};color:${active?'#93c5fd':'#64748b'};font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;transition:all 0.15s">${filterLabels[f]}</button>`;
            }).join('');

            // Bar row builders
            function rankRows(entries, maxVal, labelFn) {
                return entries.map(([key, count], i) => {
                    const pct = Math.round((count / maxVal) * 100);
                    const label = labelFn ? labelFn(key) : key;
                    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
                        <span style="width:16px;font-size:10px;color:#334155;font-weight:700;text-align:right;flex-shrink:0">${i+1}</span>
                        <span style="min-width:60px;max-width:120px;font-size:13px;font-weight:700;color:#e2e8f0;letter-spacing:0.04em;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
                        <div style="flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden">
                            <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#1d4ed8,#60a5fa);border-radius:3px"></div>
                        </div>
                        <span style="width:26px;font-size:12px;color:#475569;text-align:right;flex-shrink:0">${count}</span>
                    </div>`;
                }).join('');
            }

            function routeRows(entries, maxVal) {
                return entries.map(([route, count], i) => {
                    const [dep, arr] = route.split('→');
                    const pct = Math.round((count / maxVal) * 100);
                    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
                        <span style="width:16px;font-size:10px;color:#334155;font-weight:700;text-align:right;flex-shrink:0">${i+1}</span>
                        <span style="width:96px;font-size:13px;font-weight:700;color:#e2e8f0;letter-spacing:0.04em;flex-shrink:0">${aptLabel(dep, _wrappedPilotKey)} <span style="color:#3b82f6">→</span> ${aptLabel(arr, _wrappedPilotKey)}</span>
                        <div style="flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden">
                            <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#1d4ed8,#60a5fa);border-radius:3px"></div>
                        </div>
                        <span style="width:26px;font-size:12px;color:#475569;text-align:right;flex-shrink:0">${count}</span>
                    </div>`;
                }).join('');
            }

            // Monthly bars (bars grow from 0 via CSS transition with staggered delay)
            const maxMo = Math.max(...s.monthlyBreakdown.map(m => m.count), 1);
            const monthBars = s.monthlyBreakdown.map((m, idx) => {
                const pct = Math.max(Math.round((m.count / maxMo) * 100), m.count > 0 ? 4 : 0);
                const isBusiest = m.count === maxMo && m.count > 0;
                return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:18px">
                    <span style="font-size:10px;color:${isBusiest?'#60a5fa':'#475569'};font-weight:${isBusiest?'700':'400'}">${m.count || ''}</span>
                    <div style="width:100%;flex:1;background:rgba(255,255,255,0.05);border-radius:3px;display:flex;align-items:flex-end;overflow:hidden">
                        <div class="wr-month-bar" style="width:100%;height:0%;background:${isBusiest?'linear-gradient(0deg,#1d4ed8,#60a5fa)':'linear-gradient(0deg,rgba(29,78,216,0.6),rgba(96,165,250,0.6))'};border-radius:3px;transition:height 0.55s cubic-bezier(.22,.68,0,1.2) ${idx*38}ms" data-ht="${pct}"></div>
                    </div>
                    <span style="font-size:9px;color:${isBusiest?'#60a5fa':'#334155'};font-weight:${isBusiest?'700':'400'}">${m.label}</span>
                </div>`;
            }).join('');

            const maxApt   = s.topAirports[0]?.[1] || 1;
            const maxRoute = s.topRoutes[0]?.[1]   || 1;

            function aptLabel(code) {
                const c = coords[code.toUpperCase()];
                const name = c?.name ? c.name.replace(/\s*(International|Regional|Municipal|Executive|Airport)\s*/gi,'').trim().slice(0,18) : '';
                return code + (name ? `<span style="font-size:10px;color:#334155;font-weight:400;margin-left:5px">${name}</span>` : '');
            }

            // Longest/shortest label helper
            function blockFmt(mins) {
                return `${Math.floor(mins/60)}h ${String(mins%60).padStart(2,'0')}m`;
            }

            const nmRound2 = _wrappedNm != null ? Math.round(_wrappedNm) : (totalNm > 0 ? Math.round(totalNm) : null);
            const nmDisplayStr = nmRound2 != null ? nmRound2.toLocaleString() : '—';
            const earthLaps2   = nmRound2 ? nmRound2 / 21638 : 0;
            const earthLabel   = nmRound2 ? (earthLaps2 >= 1 ? `${earthLaps2.toFixed(2)}× around Earth` : `${Math.round(earthLaps2 * 100)}% around Earth`) : '';

            detail.innerHTML = `
            <!-- ForeFlight-style: hero map with overlaid stat cards -->
            <div style="position:relative;height:65dvh;min-height:260px">
                <div id="wrapped-map-el" style="position:absolute;inset:0;background:#060b14;pointer-events:none"></div>

                <!-- Top gradient + title -->
                <div style="position:absolute;top:0;left:0;right:0;padding:calc(env(safe-area-inset-top,0px) + 12px) 14px 28px;background:linear-gradient(to bottom,rgba(3,8,17,0.9) 0%,transparent 100%);pointer-events:none;z-index:500">
                    <div style="font-size:9px;font-weight:800;letter-spacing:0.2em;text-transform:uppercase;color:#3b82f6">CrewSync Wrapped</div>
                    <div style="font-size:15px;font-weight:700;color:#fff;margin-top:2px;letter-spacing:-0.01em">${s.pilotName.split(' ')[0]}'s ${s.year} <span style="color:#475569;font-weight:400">· ${s.monthThrough}</span></div>
                </div>

                <!-- Stat cards — top right corner, compact 2×2 -->
                <div style="position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);right:10px;display:grid;grid-template-columns:1fr 1fr;gap:5px;width:180px;z-index:500">
                    <div style="background:linear-gradient(135deg,rgba(180,83,9,0.92),rgba(217,119,6,0.92));border-radius:10px;padding:8px 10px;backdrop-filter:blur(6px)">
                        <div style="font-size:8px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,237,200,0.7)">Time</div>
                        <div style="font-size:18px;font-weight:300;color:#fff;line-height:1.1;margin-top:3px" data-countup="${s.totalBlockHours}" data-countup-dec="1">—</div>
                        <div style="font-size:8px;color:rgba(255,237,200,0.55);margin-top:2px;font-weight:600;letter-spacing:0.06em">HRS</div>
                    </div>
                    <div style="background:linear-gradient(135deg,rgba(30,64,175,0.92),rgba(79,70,229,0.92));border-radius:10px;padding:8px 10px;backdrop-filter:blur(6px)">
                        <div style="font-size:8px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(199,210,254,0.7)">Flights</div>
                        <div style="font-size:18px;font-weight:300;color:#fff;line-height:1.1;margin-top:3px" data-countup="${s.totalLegs}">—</div>
                        <div style="font-size:8px;color:rgba(199,210,254,0.55);margin-top:2px;font-weight:600;letter-spacing:0.06em">LEGS</div>
                    </div>
                    <div style="background:linear-gradient(135deg,rgba(13,110,110,0.92),rgba(15,144,144,0.92));border-radius:10px;padding:8px 10px;backdrop-filter:blur(6px)">
                        <div style="font-size:8px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(153,246,228,0.7)">Dist</div>
                        <div style="font-size:${nmDisplayStr.length > 5 ? '14px' : '18px'};font-weight:300;color:#fff;line-height:1.1;margin-top:3px">${nmDisplayStr}</div>
                        <div style="font-size:8px;color:rgba(153,246,228,0.55);margin-top:2px;font-weight:600;letter-spacing:0.06em">NM</div>
                    </div>
                    <div style="background:linear-gradient(135deg,rgba(146,64,14,0.92),rgba(180,83,9,0.92));border-radius:10px;padding:8px 10px;backdrop-filter:blur(6px)">
                        <div style="font-size:8px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(253,230,138,0.7)">Apts</div>
                        <div style="font-size:18px;font-weight:300;color:#fff;line-height:1.1;margin-top:3px" data-countup="${s.uniqueAirports}">—</div>
                        <div style="font-size:8px;color:rgba(253,230,138,0.55);margin-top:2px;font-weight:600;letter-spacing:0.06em">VISITED</div>
                    </div>
                </div>

                <!-- Bottom gradient + back button + earth factoid -->
                <div style="position:absolute;bottom:0;left:0;right:0;padding:28px 14px 10px;background:linear-gradient(to top,rgba(3,8,17,0.95) 0%,transparent 100%);z-index:500">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                        <button onclick="renderWrapped(_wrappedPilotKey)" style="padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(3,8,17,0.75);color:#94a3b8;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer">← Slides</button>
                        <div style="flex:1;text-align:center">
                            ${earthLabel ? `<div style="font-size:10px;color:#14b8a6;font-weight:600;letter-spacing:0.04em">${earthLabel}</div>` : ''}
                            <div style="font-size:9px;color:#64748b;letter-spacing:0.12em;text-transform:uppercase;margin-top:3px">scroll for details ↓</div>
                        </div>
                        <div style="display:flex;gap:6px">
                            <button onclick="toggleWrappedMute()" id="wrapped-detail-mute" style="width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,0.12);background:rgba(3,8,17,0.75);color:#94a3b8;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center">${_wrappedMuted ? '🔇' : '🔊'}</button>
                            <button onclick="closeWrapped()" style="width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,0.12);background:rgba(3,8,17,0.75);color:#94a3b8;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center">✕</button>
                        </div>
                    </div>
                </div>
            </div>

            <div style="padding:14px 14px 56px;max-width:520px;margin:0 auto">

                    <!-- Filter chips -->
                    <div style="display:flex;gap:6px;margin-bottom:18px;flex-wrap:wrap">${chipHTML}</div>

                    <!-- Mini stats row -->
                    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:28px">
                        <div class="wr-mini-card"><div class="wr-mini-val">${avgH}h ${String(avgM).padStart(2,'0')}m</div><div class="wr-mini-lbl">Avg Block</div></div>
                        <div class="wr-mini-card"><div class="wr-mini-val">${fmtHM(s.earliestDep)}</div><div class="wr-mini-lbl">Earliest Dep</div></div>
                        <div class="wr-mini-card"><div class="wr-mini-val">${fmtHM(s.latestArr)}</div><div class="wr-mini-lbl">Latest Arr</div></div>
                    </div>

                    <!-- Monthly breakdown -->
                    <div class="wr-section-head">Legs by Month</div>
                    <div style="display:flex;gap:4px;height:100px;align-items:flex-end;margin-bottom:28px;padding:0 2px">
                        ${monthBars || '<span style="color:#334155;font-size:12px">No data</span>'}
                    </div>

                    <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:28px"></div>

                    <!-- Top airports + Top routes side by side on wide, stacked on narrow -->
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:28px">
                        <div>
                            <div class="wr-section-head">Top Airports</div>
                            ${s.topAirports.slice(0,5).map(([code], i) => `<div style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;align-items:center;gap:7px"><span style="font-size:9px;color:#334155;width:12px;text-align:right">${i+1}</span><span style="font-size:12px;font-weight:700;color:#e2e8f0;letter-spacing:0.05em">${aptLabel(code, _wrappedPilotKey)}</span></div>`).join('') || '<span style="color:#334155;font-size:11px">No data</span>'}
                        </div>
                        <div>
                            <div class="wr-section-head">Aircraft</div>
                            ${s.topTails.slice(0,5).map(([tail], i) => `<div style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;align-items:center;gap:7px"><span style="font-size:9px;color:#334155;width:12px;text-align:right">${i+1}</span><span style="font-size:12px;font-weight:700;color:#e2e8f0;letter-spacing:0.04em">${tail}</span></div>`).join('') || '<span style="color:#334155;font-size:11px">No data</span>'}
                        </div>
                    </div>

                    <!-- Top routes full-width bars -->
                    <div class="wr-section-head">Top Routes</div>
                    <div style="margin-bottom:28px">${s.topRoutes.length ? routeRows(s.topRoutes, maxRoute) : '<span style="color:#334155;font-size:12px">No data</span>'}</div>

                    <!-- Full airport bar chart -->
                    <div class="wr-section-head">All Airports <span style="color:#334155;text-transform:none;letter-spacing:0;font-size:9px;font-weight:400">by landings</span></div>
                    <div style="margin-bottom:28px">${s.topAirports.length ? rankRows(s.topAirports, maxApt, aptLabel) : '<span style="color:#334155;font-size:12px">No data</span>'}</div>

                    <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:28px"></div>

                    <!-- Did you know -->
                    <div class="wr-section-head">Did You Know</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
                        ${s.earlyCount > 0 ? `<div class="wr-mini-card"><div style="font-size:18px;margin-bottom:6px">🌙</div><div class="wr-mini-val">${s.earlyCount}</div><div class="wr-mini-lbl">Pre-Dawn Deps<br><span style="color:#334155">before 6 am</span></div></div>` : ''}
                        ${s.lateCount  > 0 ? `<div class="wr-mini-card"><div style="font-size:18px;margin-bottom:6px">🌃</div><div class="wr-mini-val">${s.lateCount}</div><div class="wr-mini-lbl">Late-Night Arrs<br><span style="color:#334155">after 10 pm</span></div></div>` : ''}
                        ${s.dhCount    > 0 ? `<div class="wr-mini-card"><div style="font-size:18px;margin-bottom:6px">💺</div><div class="wr-mini-val">${s.dhCount}</div><div class="wr-mini-lbl">Deadhead Legs<br><span style="color:#334155">paid to ride</span></div></div>` : ''}
                        ${s.longest    ? `<div class="wr-mini-card"><div style="font-size:18px;margin-bottom:6px">🛫</div><div class="wr-mini-val">${blockFmt(s.longest.block_minutes)}</div><div class="wr-mini-lbl">Longest Leg<br><span style="color:#334155">${aptLabel(s.longest.departure_airport, _wrappedPilotKey)} → ${aptLabel(s.longest.arrival_airport, _wrappedPilotKey)}</span></div></div>` : ''}
                        ${s.shortest   ? `<div class="wr-mini-card"><div style="font-size:18px;margin-bottom:6px">⚡</div><div class="wr-mini-val">${blockFmt(s.shortest.block_minutes)}</div><div class="wr-mini-lbl">Shortest Leg<br><span style="color:#334155">${aptLabel(s.shortest.departure_airport, _wrappedPilotKey)} → ${aptLabel(s.shortest.arrival_airport, _wrappedPilotKey)}</span></div></div>` : ''}
                    </div>

                    <!-- Footer -->
                    <div style="margin-top:36px;padding-top:18px;border-top:1px solid rgba(255,255,255,0.05);text-align:center">
                        <div style="font-size:10px;color:#1e293b;letter-spacing:0.12em;text-transform:uppercase">CrewSync Wrapped · ${s.year}</div>
                    </div>
                </div>
            </div>`;

            requestAnimationFrame(() => {
                detail.querySelectorAll('[data-countup]').forEach(el => {
                    _wCountUp(el, el.dataset.countup, 1100);
                });
                detail.querySelectorAll('.wr-month-bar').forEach(bar => {
                    const ht = bar.dataset.ht;
                    requestAnimationFrame(() => { bar.style.height = ht + '%'; });
                });
            });
            // Delay map init so the container has settled its layout dimensions
            setTimeout(() => _initWrappedRouteMap(s.segments, coords), 80);
        }

        function setWrappedFilter(filter) {
            _wrappedFilter = filter;
            renderWrappedDetail();
        }

        // ── Airport coords ──────────────────────────────────────────────────
        // Resolve airport lat/lon from the embedded AIRPORTS DB first (no network needed),
        // fall back to aviationweather.gov API for anything not found there.
        function _resolveWrappedAptCoords(code) {
            const c = code.toUpperCase();
            if (_wrappedAirportCoords[c]) return _wrappedAirportCoords[c];
            // Try resolveAirport which handles ICAO, IATA, K-prefix etc.
            const a = resolveAirport(c);
            if (a && a[0] != null && a[1] != null) {
                const entry = { lat: a[0], lon: a[1], name: a[2] || '' };
                _wrappedAirportCoords[c] = entry;
                // Also cache under alternate form
                if (c.length === 4 && c.startsWith('K')) _wrappedAirportCoords[c.slice(1)] = entry;
                if (c.length === 3)                       _wrappedAirportCoords['K' + c]    = entry;
                return entry;
            }
            return null;
        }

        async function _fetchWrappedAirportCoords(codes) {
            // First pass: fill from embedded AIRPORTS DB (synchronous, no network)
            codes.forEach(c => _resolveWrappedAptCoords(c));

            // Second pass: fetch from aviationweather.gov for anything still missing
            const apiCodes = [...new Set(codes.flatMap(c => {
                const u = c.toUpperCase();
                return u.length === 3 ? [u, 'K' + u] : [u];
            }))].filter(c => !_wrappedAirportCoords[c]);

            if (apiCodes.length) {
                try {
                    const resp = await fetch(`https://aviationweather.gov/api/data/airport?ids=${apiCodes.join(',')}&format=json`);
                    if (resp.ok) {
                        const data = await resp.json();
                        for (const a of (data || [])) {
                            if (a.icaoId && a.lat != null && a.lon != null) {
                                const icao = a.icaoId.toUpperCase();
                                const entry = { lat: a.lat, lon: a.lon, name: a.name || '' };
                                _wrappedAirportCoords[icao] = entry;
                                if (icao.startsWith('K') && icao.length === 4) _wrappedAirportCoords[icao.slice(1)] = entry;
                            }
                        }
                    }
                } catch(e) { console.warn('Wrapped airport fetch failed:', e); }
            }
            return _wrappedAirportCoords;
        }

        function _haversineNm(lat1, lon1, lat2, lon2) {
            const R = 3440.065;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        }

        // ── Route map ───────────────────────────────────────────────────────
        function _initWrappedRouteMap(segments, coords) {
            // Map libraries load on first use (ensureMapLibs, maps/map-core.js); draw once they're in,
            // if this slide is still showing.
            if (!_mapLibsReady()) { ensureMapLibs().then(() => { if (document.getElementById('wrapped-map-el')) _initWrappedRouteMap(segments, coords); }).catch(() => {}); return; }
            if (_wrappedMapInst) { _wrappedMapInst.remove(); _wrappedMapInst = null; }
            const el = document.getElementById('wrapped-map-el');
            if (!el) return;

            _wrappedMapInst = L.map('wrapped-map-el', {
                zoomControl: false, attributionControl: false,
                scrollWheelZoom: false, doubleClickZoom: false, dragging: false,
                touchZoom: false, boxZoom: false, keyboard: false, tap: false,
                bounceAtZoomLimits: false,
            });
            addBasemap(_wrappedMapInst, { noLabels: true });

            // Route frequency (bidirectional collapse)
            const routeFreq = {};
            segments.forEach(f => {
                const dep = f.departure_airport?.toUpperCase();
                const arr = f.arrival_airport?.toUpperCase();
                if (!dep || !arr || dep === arr) return;
                const key = [dep, arr].sort().join('↔');
                routeFreq[key] = (routeFreq[key] || 0) + 1;
            });
            const maxFreq = Math.max(...Object.values(routeFreq), 1);
            const bounds  = [];

            Object.entries(routeFreq).forEach(([key, freq]) => {
                const [a, b] = key.split('↔');
                const cA = coords[a], cB = coords[b];
                if (!cA || !cB) return;
                const t = freq / maxFreq;
                const opacity = 0.15 + 0.7 * t;
                const weight  = 1 + 2.5 * t;
                const arc = greatCircleArcCoords([cA.lat, cA.lon], [cB.lat, cB.lon], 40);
                L.polyline(arc, { color: '#3b82f6', weight, opacity }).addTo(_wrappedMapInst);
                bounds.push([cA.lat, cA.lon], [cB.lat, cB.lon]);
            });

            // Airport dots + ICAO labels
            const aptFreq = {};
            segments.forEach(f => {
                if (f.departure_airport) { const c = f.departure_airport.toUpperCase(); aptFreq[c] = (aptFreq[c]||0)+1; }
                if (f.arrival_airport)   { const c = f.arrival_airport.toUpperCase();   aptFreq[c] = (aptFreq[c]||0)+1; }
            });
            const maxAptF = Math.max(...Object.values(aptFreq), 1);
            Object.entries(aptFreq).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([code, freq]) => {
                const c = coords[code];
                if (!c) return;
                const t = freq / maxAptF;
                L.circleMarker([c.lat, c.lon], {
                    radius: 2.5 + 2.5 * t, color: '#1d4ed8', fillColor: '#93c5fd', fillOpacity: 1, weight: 1.5
                }).addTo(_wrappedMapInst);
                // Label — show for top airports or if zoomed in enough
                if (freq >= maxAptF * 0.25) {
                    const icon = L.divIcon({
                        className: '', iconAnchor: [-6, 4],
                        html: `<span style="font-size:9px;font-weight:700;color:#93c5fd;letter-spacing:0.06em;text-shadow:0 0 6px #000,0 0 3px #000;white-space:nowrap">${code.replace(/^K/,'')}</span>`
                    });
                    L.marker([c.lat, c.lon], { icon }).addTo(_wrappedMapInst);
                }
            });

            // invalidateSize ensures Leaflet knows the true container dimensions
            // (the detail page may not have laid out fully when _initWrappedRouteMap was called)
            _wrappedMapInst.invalidateSize();

            if (bounds.length) {
                try { _wrappedMapInst.fitBounds(L.latLngBounds(bounds), { padding: [22, 22], maxZoom: 7 }); }
                catch {}
            } else {
                _wrappedMapInst.setView([38, -96], 4);
            }
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

