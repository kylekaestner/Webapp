        // ── End Wrapped ───────────────────────────────────────────────────────

        // Called after a successful schedule upload to notify the other pilot(s) in any new crossings
        // maxAheadMs: only crossings starting within this window (the app-open check passes 48h --
        // NetJets legs are filed ~18h ahead and airline lines can still change further out).
        async function broadcastCrossingNotifications(overlaps, maxAheadMs = Infinity) {
            if (!myPilot || !myToken || isDemo || !Array.isArray(overlaps)) return;
            const now = Date.now();
            const crossings = overlaps
                // Only pairs involving me -- the title below names "the other pilot" relative to me
                .filter(o => (o.kA === myPilot || o.kB === myPilot) && o.isDirect && o.directEnd && o.directEnd.getTime() > now
                    && o.directStart && o.directStart.getTime() - now <= maxAheadMs)
                .map(o => {
                    const otherKey = o.kA === myPilot ? o.kB : o.kA;
                    const otherName = (PILOT_NAMES[otherKey] || otherKey).split(' ')[0];
                    const apt = o.airport || o.airportB;
                    const tz = airportTz(apt) || null;
                    const fmtT = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...(tz ? { timeZone: tz } : {}) });
                    const dateStr = o.directStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) });
                    const tzLbl = tz ? tzAbbr(apt, o.directStart.toISOString()) : '';
                    const timeRange = `${fmtT(o.directStart)} – ${fmtT(o.directEnd)}${tzLbl ? ' ' + tzLbl : ''}`;
                    return {
                        kA: o.kA, kB: o.kB,
                        airport: apt,
                        directStart: o.directStart.toISOString(),
                        title: `Crossing with ${otherName}`,
                        body: `${aptLabel(apt)} · ${timeRange} · ${dateStr}`
                    };
                });
            if (!crossings.length) return;
            await fetch('/api/notifications/crossing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: myToken, crossings })
            }).catch(() => {});
            // Reload our own notification list to show what we just triggered
            await loadNotifications();
        }

        window.addEventListener('DOMContentLoaded', async () => {
            setupMobileGestures();
            if (PUSH_ENABLED) await initServiceWorker();

            // Rebuild pilot pills + sidebar buttons from PILOT_KEYS (handles demo mode)
            if (_isDemo) _rebuildPilotUI();

            // Set initial mobile nav active state
            const mbtn = document.getElementById('mbtn-grid');
            if (mbtn) mbtn.classList.add('mbtn-active');

            // Identity: must run before loadPilot so myPilot/myToken are set. Also syncs the
            // full pilot roster internally now (registers any pilots not in the hardcoded list)
            // before it needs that data to build friend-based UI — see the comment inside it.
            // A `false` return means the login token couldn't be resolved even after retrying
            // (see initIdentity()'s own comment) -- _showIdentityError() already left an error
            // on screen in that case, so the rest of startup (which assumes myPilot/PILOT_KEYS
            // are now valid) must not run at all.
            if ((await initIdentity()) === false) return;

            // Push notifications + badge
            // Background crossing check — populates badge and may show modal
            if (myPilot && !isDemo) {
                // Also pushes any new crossing involving me within 48h. Uploads used to be the only
                // trigger, so legs that appear on their own (NetJets legs filed the evening before,
                // server-side ICS/Schedaero syncs) never alerted anyone. The server dedupes per
                // crossing, so re-opening the app doesn't re-notify.
                computeOverlap().then(overlaps => {
                    updateCrossingAlert(overlaps);
                    if (PUSH_ENABLED) broadcastCrossingNotifications(overlaps, 48 * 3600000);
                }).catch(() => {});
                loadIntelCounts().catch(() => {});
                trackEvent('app:open');
            }

            if (PUSH_ENABLED && myPilot && !isDemo) {
                await initPushNotifications();
                await loadNotifications();
                document.getElementById('notif-bell-btn')?.classList.remove('hidden');
                document.getElementById('notif-bell-btn-mobile')?.classList.remove('hidden');
            }

            // Default view: token identity → first pilot
            const defaultPilot = myPilot || PILOT_KEYS[0];
            updateUploadSyncButtons(defaultPilot);
            const _urlParams = new URLSearchParams(location.search);
            if (_urlParams.has('wrapped') && wrappedAvailable()) {
                loadPilot(defaultPilot);
                openWrapped(); // fetches its own stats, needs nothing loadPilot loads
            } else {
                loadPilot(defaultPilot);
            }
        });

        // _syncPilotRoster -- called once at startup (non-demo only), inside initIdentity()
        // before any pilot-dependent UI builds. The ONLY source of the pilot roster -- PILOT_KEYS
        // starts empty for a real session, so this registers every pilot from the DB
        // (/api/pilots-directory), old and new alike, into:
        //   PILOT_KEYS, PILOT_NAMES, PILOT_ROLES, PILOT_HOME, PILOT_COLORS
        // Also creates each one's pill-bar/sidebar DOM buttons (there are no static ones left in
        // the HTML), then calls _rebuildPilotDropdowns() so add-flight and upload selects include
        // the full current roster. This is how a newly joined pilot (or Kyle, Adam, Sam, Logan,
        // Drew -- no longer special-cased) appears, purely from what's in the pilots table.
        async function _syncPilotRoster() {
            try {
                const pilots = await fetch(`/api/pilots-directory?token=${encodeURIComponent(myToken)}`).then(r => r.json());
                if (!Array.isArray(pilots)) return;
                pilots.forEach(p => {
                    const key = p.pilot_key;
                    if (!key || key === 'admin' || p.role === 'viewer') return;
                    if (!PILOT_KEYS.includes(key)) {
                        PILOT_KEYS.push(key);
                        PILOT_NAMES[key]  = p.name || key;
                        PILOT_HOME[key]   = p.home_airport || p.base || '';
                        PILOT_ROLES[key]  = p.role || p.base || '';
                        PILOT_COLORS[key] = p.color || _assignColor(key);
                        // Add pill buttons to DOM
                        const mobileBar = document.getElementById('mobile-pilot-bar');
                        if (mobileBar && !document.getElementById(`mpilot-${key}`)) {
                            const mb = document.createElement('button');
                            mb.onclick = () => loadPilot(key);
                            mb.id = `mpilot-${key}`;
                            mb.className = 'mpilot-btn flex-none px-4 py-2.5 rounded-full border border-zinc-700 text-sm font-black text-zinc-400 whitespace-nowrap';
                            mb.textContent = PILOT_NAMES[key].split(' ')[0];
                            mobileBar.appendChild(mb);
                        }
                        const sidebarList = document.getElementById('sidebar-pilot-list');
                        if (sidebarList && !document.getElementById(`pilot-${key}`)) {
                            const db = document.createElement('button');
                            db.onclick = () => loadPilot(key);
                            db.id = `pilot-${key}`;
                            db.className = 'pilot-avatar-btn w-full flex items-center gap-3 px-2.5 py-2.5';
                            const fn2 = PILOT_NAMES[key].split(' ')[0];
                            const pc2 = PILOT_COLORS[key] || '#6366f1';
                            db.innerHTML = `<span class="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-black shrink-0" style="background:${pc2}26;border:1px solid ${pc2}50;color:${pc2}">${fn2[0]}</span><span class="text-[13px] font-semibold text-zinc-300 text-left truncate">${PILOT_NAMES[key]}</span>`;
                            sidebarList.appendChild(db);
                        }
                    }
                });
                // Rebuild dropdowns to include all pilots
                _rebuildPilotDropdowns();
                // Re-run pill ordering / visibility now that roster is complete
                _reorderPilotPills();
                _applyPilotPillVisibility();
                _buildCrewVisibilityUI();
            } catch(e) { /* non-fatal — hardcoded list still works */ }
        }

        // Pick the first color from the palette not already used by any other pilot
        function _assignColor(key) {
            const palette = [
                '#6366f1','#ec4899','#14b8a6','#f59e0b','#84cc16','#f97316',
                '#a3e635','#c084fc','#f43f5e','#06b6d4','#ff8c42','#7dd3fc',
                '#4ade80','#e879f9','#38bdf8','#fb923c','#34d399','#a78bfa',
                '#fbbf24','#60a5fa','#f472b6','#4ade80','#22d3ee','#86efac'
            ];
            const used = new Set(Object.values(PILOT_COLORS));
            for (const c of palette) {
                if (!used.has(c)) return c;
            }
            // Fallback if palette exhausted
            let hash = 0;
            for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
            return palette[Math.abs(hash) % palette.length];
        }

        // _rebuildPilotDropdowns -- called after _syncPilotRoster() to keep the
        // add-flight modal and upload selects in sync with PILOT_KEYS.
        // Admin sees all pilots in add-flight; signed-in pilots see only themselves.
        // Upload select is hidden entirely for signed-in pilots (they use sync button).
        function _rebuildPilotDropdowns() {
            // Add flight modal — admin sees all pilots, signed-in user sees only themselves
            const addPilotRow  = document.getElementById('add-pilot-row');
            const addPilotSel  = document.getElementById('add-pilot');
            const addPilotGrid = document.getElementById('add-pilot-date-grid');
            if (addPilotSel) {
                if (myPilot) {
                    // Signed-in: hide pilot dropdown, date takes full width
                    if (addPilotRow)  addPilotRow.style.display = 'none';
                    if (addPilotGrid) addPilotGrid.className = 'grid grid-cols-1 gap-3';
                    addPilotSel.innerHTML = `<option value="${myPilot}">${PILOT_NAMES[myPilot]}</option>`;
                } else {
                    // Admin: show all pilots, restore 2-col grid
                    if (addPilotRow)  addPilotRow.style.display = '';
                    if (addPilotGrid) addPilotGrid.className = 'grid grid-cols-2 gap-3';
                    addPilotSel.innerHTML = PILOT_KEYS.map(k =>
                        `<option value="${k}">${PILOT_NAMES[k]}</option>`
                    ).join('');
                }
            }
            // Upload selects
            ['upload-pilot-select', 'mobile-upload-pilot-select'].forEach(id => {
                const sel = document.getElementById(id);
                if (!sel) return;
                const cur = sel.value;
                sel.innerHTML = PILOT_KEYS.map(k =>
                    `<option value="${k}">${PILOT_NAMES[k]}</option>`
                ).join('');
                if (PILOT_KEYS.includes(cur)) sel.value = cur;
                if (myPilot && PILOT_KEYS.includes(myPilot)) sel.value = myPilot;
            });
        }

        function _rebuildPilotUI() {
            // Replace static HTML pilot pills and sidebar buttons with demo pilots
            const mobileBar = document.getElementById('mobile-pilot-bar');
            if (mobileBar) {
                mobileBar.innerHTML = PILOT_KEYS.map(k =>
                    `<button onclick="loadPilot('${k}')" id="mpilot-${k}" class="mpilot-btn flex-none px-4 py-2.5 rounded-full border border-zinc-700 text-sm font-black text-zinc-400 whitespace-nowrap">${PILOT_NAMES[k].split(' ')[0]}</button>`
                ).join('');
            }
            const sidebarList = document.getElementById('sidebar-pilot-list');
            if (sidebarList) {
                const existing = sidebarList.querySelectorAll('button');
                existing.forEach(b => b.remove());
                PILOT_KEYS.forEach(k => {
                    const btn = document.createElement('button');
                    btn.onclick = () => loadPilot(k);
                    btn.id = `pilot-${k}`;
                    btn.className = 'w-full text-left p-4 rounded-xl border border-zinc-800 hover:border-blue-500 transition-colors';
                    btn.innerHTML = `<span class="text-[9px] block text-zinc-500 font-black uppercase">${PILOT_NAMES[k].split(' ')[0]}</span><span class="font-bold text-sm tracking-tight">${PILOT_NAMES[k]}</span>`;
                    sidebarList.appendChild(btn);
                });
            }
            // Rebuild upload dropdowns with demo names
            _rebuildPilotDropdowns();
            // Hide upload section in demo
            document.getElementById('sidebar-upload-section')?.classList.add('hidden');
            document.getElementById('btn-upload-nav')?.classList.add('hidden');
        }

