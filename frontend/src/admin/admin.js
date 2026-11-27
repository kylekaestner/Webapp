        // ── Admin Panel ───────────────────────────────────────────────────
        let _adminUsers = [];

async function openAdminPanel(tab = 'users') {
            document.getElementById('admin-panel').classList.remove('hidden');
            await switchAdminTab(tab);
        }

        async function switchAdminTab(tab) {
            const isUsers = tab === 'users';
            const usersBtn = document.getElementById('admin-tab-users');
            const dashBtn  = document.getElementById('admin-tab-dashboard');
            usersBtn.className = `flex-1 md:flex-none md:px-10 py-2.5 rounded-xl font-black uppercase text-xs tracking-widest transition-colors ${isUsers ? 'bg-indigo-600 text-white' : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`;
            dashBtn.className  = `flex-1 md:flex-none md:px-10 py-2.5 rounded-xl font-black uppercase text-xs tracking-widest transition-colors ${!isUsers ? 'bg-indigo-600 text-white' : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'}`;
            document.getElementById('admin-user-list').classList.toggle('hidden', !isUsers);
            document.getElementById('admin-dashboard-pane').classList.toggle('hidden', isUsers);
            document.getElementById('admin-add-user-btn').classList.toggle('hidden', !isUsers);
            if (isUsers) await loadAdminUsers();
            else await loadAdminDashboard();
        }

        function closeAdminPanel() {
            document.getElementById('admin-panel').classList.add('hidden');
        }

        let _adminUserFilter = '';

        async function loadAdminUsers() {
            const grid = document.getElementById('admin-user-grid');
            document.getElementById('admin-user-search').value = '';
            _adminUserFilter = '';
            grid.innerHTML = '<div class="col-span-full flex items-center justify-center gap-2 py-10 text-zinc-500 text-xs font-bold"><div class="spinner"></div><span>Loading…</span></div>';
            try {
                const rows = await fetch(`${API_BASE}/pilots?token=${encodeURIComponent(myToken)}`).then(r => r.json());
                _adminUsers = rows;
                renderAdminUserList(rows);
            } catch (e) {
                grid.innerHTML = '<div class="col-span-full text-red-400 text-xs font-bold py-10 text-center">Failed to load users</div>';
            }
        }

        function filterAdminUsers(query) {
            _adminUserFilter = query || '';
            renderAdminUserList(_adminUsers);
        }

        function renderAdminUserList(rows) {
            const grid  = document.getElementById('admin-user-grid');
            const count = document.getElementById('admin-user-count');
            const q = _adminUserFilter.trim().toLowerCase();
            const filtered = q ? rows.filter(u => (u.name || '').toLowerCase().includes(q) || u.pilot_key.toLowerCase().includes(q)) : rows;
            count.textContent = rows.length ? `${filtered.length} of ${rows.length} user${rows.length !== 1 ? 's' : ''}` : '';

            if (!rows.length) {
                grid.innerHTML = '<div class="col-span-full text-zinc-500 text-xs font-bold py-10 text-center">No users found</div>';
                return;
            }
            if (!filtered.length) {
                grid.innerHTML = `<div class="col-span-full text-zinc-500 text-xs font-bold py-10 text-center">No users match "${escapeHtml(_adminUserFilter)}"</div>`;
                return;
            }

            grid.innerHTML = filtered.map(u => {
                const link = `${location.origin}/app?u=${u.token}`;
                const isViewer = u.role === 'viewer';
                const initials = isViewer ? '👁' : (u.name || u.pilot_key).split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                const color = isViewer ? '#10b981' : (PILOT_COLORS[u.pilot_key] || '#6366f1');
                const subtext = isViewer
                    ? `${u.pilot_key} · View only${u.shared_by ? ` · via ${escapeHtml(PILOT_NAMES[u.shared_by] || u.shared_by)}` : ''}`
                    : `${u.pilot_key} · base ${u.base || '—'}${u.home_airport && !sameApt(u.home_airport, u.base) ? ` · home ${u.home_airport}` : ''} · ${u.parser_type || 'other'}`;
                let warnCount = 0;
                try { warnCount = u.parser_warnings ? JSON.parse(u.parser_warnings).length : 0; } catch { warnCount = 0; }
                return `<div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-4 hover:border-zinc-700 transition-colors" style="${isViewer ? 'border-color:#166534' : ''}">
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-black shrink-0" style="background:${color}22;color:${color}">${initials}</div>
                        <div class="min-w-0">
                            <div class="text-base font-black text-white truncate">${u.name}</div>
                            <div class="text-[11px] text-zinc-500 font-bold truncate">${subtext}</div>
                        </div>
                    </div>
                    ${warnCount ? `<button onclick="showParserWarnings('${u.pilot_key}')" class="w-full flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-950/40 border border-amber-800/50 text-amber-400 text-[11px] font-bold text-left hover:bg-amber-950/60 transition-colors">
                        <span>⚠</span><span>Schedule has ${warnCount} unrecognized item${warnCount > 1 ? 's' : ''} — tap to view</span>
                    </button>` : ''}
                    <div class="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800">
                        <div class="flex-1 text-[11px] font-mono text-zinc-400 overflow-hidden text-ellipsis whitespace-nowrap">${link}</div>
                        <button onclick="copyText('${link}').then(ok=>showToast(ok?'Link copied':'Copy failed','info',2000))" class="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 transition-colors shrink-0" title="Copy link">⧉</button>
                        <button onclick="confirmRegenerateToken('${u.pilot_key}','${u.name}')" class="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-amber-400 hover:bg-zinc-800 transition-colors shrink-0" title="Generate new link">↺</button>
                    </div>
                    <div class="flex gap-2 pt-1">
                        <button onclick="openEditUserModal('${u.pilot_key}')" class="flex-1 py-2.5 bg-zinc-800 hover:bg-blue-600 text-zinc-200 hover:text-white rounded-xl font-black uppercase text-[11px] tracking-wide transition-colors">✎ Edit</button>
                        <button onclick="confirmDeleteUser('${u.pilot_key}','${u.name}')" class="flex-1 py-2.5 bg-zinc-800 hover:bg-red-600 text-zinc-400 hover:text-white rounded-xl font-black uppercase text-[11px] tracking-wide transition-colors">🗑 Delete</button>
                    </div>
                </div>`;
            }).join('');
        }

        // Shows the raw list of unrecognized schedule items flagged by a pilot's last
        // upload/sync (American/Southwest parsers so far -- see pilots.parser_warnings).
        function showParserWarnings(pilotKey) {
            const u = _adminUsers.find(x => x.pilot_key === pilotKey);
            if (!u || !u.parser_warnings) return;
            let list = [];
            try { list = JSON.parse(u.parser_warnings); } catch { list = []; }
            if (!list.length) return;
            alert(`${u.name} — unrecognized schedule items:\n\n${list.map((w, i) => `${i + 1}. ${w}`).join('\n\n')}`);
        }

        // ── Admin Dashboard ───────────────────────────────────────────────
        async function loadAdminDashboard() {
            const pane = document.getElementById('admin-dashboard-pane');
            pane.innerHTML = '<div class="flex items-center justify-center gap-2 py-8 text-zinc-500 text-xs font-bold"><div class="spinner"></div><span>Loading…</span></div>';
            try {
                const s = await fetch(`${API_BASE}/admin/stats?token=${encodeURIComponent(myToken)}`).then(r => r.json());
                renderAdminDashboard(s);
            } catch (e) {
                pane.innerHTML = '<div class="text-red-400 text-xs font-bold py-6 text-center">Failed to load stats</div>';
            }
        }

        function renderAdminDashboard(s) {
            const pane = document.getElementById('admin-dashboard-pane');
            const totalPilots = s.pilots.total;
            const totalFlights = (s.segments.byType.find(t => t.type === 'flight')?.count) || 0;

            // Feature adoption rows
            const features = [
                { label: 'Schedule loaded', active: s.pilots.withFutureSchedule, total: totalPilots, icon: '📅', note: 'pilots with upcoming flights' },
                { label: 'Uploaded recently', active: s.pilots.recentUploaders, total: totalPilots, icon: '⬆', note: 'uploads in last 30 days' },
                { label: 'Crew Intel', active: s.intel.contributors, total: totalPilots, icon: '📖', note: `of ${totalPilots} pilots contributed` },
                { label: 'Push notifications', active: s.push.pilots, total: totalPilots, icon: '🔔', note: 'pilots subscribed' },
            ];

            const featureRows = features.map(f => {
                const pct = totalPilots ? Math.round((f.active / totalPilots) * 100) : 0;
                const barColor = pct >= 60 ? '#22c55e' : pct >= 30 ? '#f59e0b' : '#ef4444';
                return `<div>
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="text-[11px] font-black text-zinc-300">${f.icon} ${f.label}</span>
                        <span class="text-[11px] font-black" style="color:${barColor}">${f.active} / ${totalPilots}</span>
                    </div>
                    <div class="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div class="h-full rounded-full transition-all" style="width:${pct}%;background:${barColor}"></div>
                    </div>
                    <div class="text-[9px] text-zinc-600 mt-1">${f.note}</div>
                </div>`;
            }).join('');

            // Segment type breakdown
            const typeColors = { flight: '#3b82f6', reserve: '#f59e0b', off: '#22c55e', layover: '#a78bfa', duty: '#fb923c' };
            const segRows = s.segments.byType.map(t => {
                const pct = s.segments.total ? Math.round((t.count / s.segments.total) * 100) : 0;
                const color = typeColors[t.type] || '#52525b';
                return `<div class="flex items-center gap-3">
                    <span class="w-16 text-[10px] font-black text-zinc-400 uppercase">${t.type}</span>
                    <div class="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div class="h-full rounded-full" style="width:${pct}%;background:${color}"></div>
                    </div>
                    <span class="text-[10px] font-black text-zinc-500 w-8 text-right">${t.count}</span>
                </div>`;
            }).join('');

            // Crew intel category
            const intelColors = { hotel: '#3b82f6', food: '#f59e0b', activity: '#22c55e', tip: '#a78bfa' };
            const intelRows = s.intel.byCategory.length
                ? s.intel.byCategory.map(c => {
                    const pct = s.intel.total ? Math.round((c.count / s.intel.total) * 100) : 0;
                    const color = intelColors[c.category] || '#52525b';
                    return `<div class="flex items-center gap-2">
                        <span class="w-16 text-[10px] font-black capitalize" style="color:${color}">${c.category}</span>
                        <div class="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                            <div class="h-full rounded-full" style="width:${pct}%;background:${color}"></div>
                        </div>
                        <span class="text-[10px] font-black text-zinc-500 w-6 text-right">${c.count}</span>
                    </div>`;
                }).join('')
                : '<div class="text-[10px] text-zinc-600">No entries yet</div>';

            // Top airports
            const maxAptCount = s.topAirports[0]?.count || 1;
            const airportRows = s.topAirports.map((a, i) => {
                const pct = Math.round((a.count / maxAptCount) * 100);
                return `<div class="flex items-center gap-3">
                    <span class="text-[10px] font-black text-zinc-500 w-4 text-right">${i + 1}</span>
                    <span class="text-[11px] font-black text-white w-10">${a.airport}</span>
                    <div class="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div class="h-full rounded-full bg-blue-600" style="width:${pct}%"></div>
                    </div>
                    <span class="text-[10px] text-zinc-500 w-6 text-right">${a.count}</span>
                </div>`;
            }).join('');

            // Schedule range display
            const fmtD = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
            const schedStr = s.schedule.earliest && s.schedule.latest
                ? `${fmtD(s.schedule.earliest)} → ${fmtD(s.schedule.latest)}`
                : 'No schedule data';

            // Weekly upload activity (sparkline-style text)
            const uploadBar = s.weeklyUploads.map(w => {
                const n = Math.min(w.uploads, 5);
                const blocks = ['▁','▂','▃','▄','▅'];
                return `<span title="Week ${w.week}: ${w.uploads} upload${w.uploads !== 1 ? 's' : ''}" style="color:${n > 2 ? '#3b82f6' : n > 0 ? '#1d4ed8' : '#27272a'};font-size:14px;line-height:1">${blocks[n - 1] || '▁'}</span>`;
            }).join('');

            pane.innerHTML = `
                <!-- Stat cards -->
                <div class="grid grid-cols-2 gap-2.5">
                    ${[
                        { label: 'Total Flights', val: totalFlights.toLocaleString(), sub: `${s.segments.manual} manual`, color: '#3b82f6' },
                        { label: 'Airports Covered', val: s.schedule.uniqueAirports, sub: 'across all schedules', color: '#a78bfa' },
                        { label: 'Crossings Found', val: s.crossings.total, sub: 'crossing alerts generated', color: '#f59e0b' },
                        { label: 'Crew Intel Tips', val: s.intel.total, sub: `across ${s.topAirports.length ? s.intel.byCategory.length : 0} categories`, color: '#22c55e' },
                    ].map(c => `<div class="rounded-xl p-3.5" style="background:#111113;border:1px solid #1c1c1f">
                        <div class="text-[9px] font-black uppercase tracking-widest mb-1" style="color:${c.color}">${c.label}</div>
                        <div class="text-2xl font-black text-white leading-none">${c.val}</div>
                        <div class="text-[9px] text-zinc-600 mt-1">${c.sub}</div>
                    </div>`).join('')}
                </div>

                <!-- Feature adoption -->
                <div class="rounded-xl p-4 space-y-4" style="background:#111113;border:1px solid #1c1c1f">
                    <div class="text-[9px] font-black uppercase tracking-widest text-zinc-500">Feature Adoption</div>
                    ${featureRows}
                </div>

                <!-- Upload activity -->
                <div class="rounded-xl p-4" style="background:#111113;border:1px solid #1c1c1f">
                    <div class="text-[9px] font-black uppercase tracking-widest text-zinc-500 mb-3">Upload Activity · Last 8 Weeks</div>
                    <div class="flex items-end gap-1 h-6">${uploadBar || '<span class="text-[10px] text-zinc-600">No data</span>'}</div>
                    <div class="text-[9px] text-zinc-600 mt-2">Schedule coverage: ${schedStr}</div>
                </div>

                <!-- Two-column: segments + crew intel -->
                <div class="grid grid-cols-2 gap-2.5">
                    <div class="rounded-xl p-4 space-y-2.5" style="background:#111113;border:1px solid #1c1c1f">
                        <div class="text-[9px] font-black uppercase tracking-widest text-zinc-500 mb-1">Segments by Type</div>
                        ${segRows || '<div class="text-[10px] text-zinc-600">No data</div>'}
                    </div>
                    <div class="rounded-xl p-4 space-y-2.5" style="background:#111113;border:1px solid #1c1c1f">
                        <div class="text-[9px] font-black uppercase tracking-widest text-zinc-500 mb-1">Crew Intel</div>
                        ${intelRows}
                    </div>
                </div>

                <!-- Top airports -->
                ${s.topAirports.length ? `<div class="rounded-xl p-4 space-y-2.5" style="background:#111113;border:1px solid #1c1c1f">
                    <div class="text-[9px] font-black uppercase tracking-widest text-zinc-500 mb-1">Top Departure Airports</div>
                    ${airportRows}
                </div>` : ''}

                <!-- View usage -->
                ${renderUsageSection(s)}
            `;
        }

        function renderUsageSection(s) {
            const u = s.usage;
            if (!u) return '';

            const viewLabels = { 'view:grid': 'Grid', 'view:list': 'List', 'view:map': 'Map', 'view:overlap': 'Crossings', 'view:intel': 'Crew Intel' };
            const viewColors = { 'view:grid': '#3b82f6', 'view:list': '#a78bfa', 'view:map': '#22c55e', 'view:overlap': '#f59e0b', 'view:intel': '#f472b6' };
            const maxViewCount = u.viewCounts[0]?.count || 1;

            const viewRows = Object.keys(viewLabels).map(key => {
                const row = u.viewCounts.find(r => r.event === key);
                const count = row?.count || 0;
                const pct = Math.round((count / maxViewCount) * 100);
                const color = viewColors[key] || '#52525b';
                return `<div class="flex items-center gap-3">
                    <span class="text-[10px] font-black w-16" style="color:${color}">${viewLabels[key]}</span>
                    <div class="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div class="h-full rounded-full transition-all" style="width:${pct}%;background:${color}"></div>
                    </div>
                    <span class="text-[10px] font-black text-zinc-500 w-8 text-right">${count}</span>
                </div>`;
            }).join('');

            // Daily active sparkline — last 30 days
            const days30 = [];
            const today = new Date();
            for (let i = 29; i >= 0; i--) {
                const d = new Date(today); d.setDate(today.getDate() - i);
                const key = d.toISOString().slice(0, 10);
                const row = u.dailyActive.find(r => r.day === key);
                days30.push(row?.pilots || 0);
            }
            const maxDay = Math.max(...days30, 1);
            const sparkBars = days30.map(v => {
                const h = Math.max(2, Math.round((v / maxDay) * 20));
                const color = v > 0 ? '#3b82f6' : '#1c1c1f';
                return `<div style="width:6px;height:${h}px;background:${color};border-radius:2px;flex-shrink:0" title="${v} pilot${v !== 1 ? 's' : ''}"></div>`;
            }).join('');

            const hasData = u.viewCounts.length > 0 || u.totalOpens > 0;
            if (!hasData) return `<div class="rounded-xl p-4" style="background:#111113;border:1px solid #1c1c1f">
                <div class="text-[9px] font-black uppercase tracking-widest text-zinc-500 mb-2">Feature Usage</div>
                <div class="text-[10px] text-zinc-600">No usage data yet — pilots will start appearing here once they open the app.</div>
            </div>`;

            return `<div class="rounded-xl p-4 space-y-4" style="background:#111113;border:1px solid #1c1c1f">
                <div class="flex items-center justify-between">
                    <div class="text-[9px] font-black uppercase tracking-widest text-zinc-500">Feature Usage · Last 90 Days</div>
                    <div class="text-[9px] text-zinc-600">${s.pilots.activeLast7} active last 7d · ${u.totalOpens} total opens</div>
                </div>
                <div class="space-y-2.5">${viewRows}</div>
                <div>
                    <div class="text-[9px] font-black uppercase tracking-widest text-zinc-600 mb-2">Daily Active Pilots · Last 30 Days</div>
                    <div class="flex items-end gap-0.5 h-5">${sparkBars}</div>
                </div>
            </div>`;
        }

        let _editUserIsViewer = false;

        // Kept in sync with the company list in join.html's join flow. GoJet is one
        // company with one method (RosterBuster ICS) here now -- it used to be split
        // into a separate "GoJet Services" (csv) and "RosterBuster (subscription)"
        // pseudo-airline entry, which was really just the same airline shown twice.
        // Kept alphabetical by the name shown in the dropdown (matches the <option> order in
        // both the admin edit-user modal and the self-service My Info modal) -- Other stays last
        // as the catch-all, per usual convention.
        const AIRLINE_OPTIONS = [
            { icao: 'AAL',   dbCode: 'AAL', parser: 'ics_american', needsIcs: true,
              icsLabel: 'MobileCCI ICS URL', icsHint: 'The published calendar subscription link from MobileCCI.' },
            { icao: 'GTI',   dbCode: 'GTI', parser: 'ics_ecrew',   needsIcs: true,
              icsLabel: 'eCrew ICS URL', icsHint: 'The calendar subscription link from eCrew.' },
            { icao: 'DAL',   dbCode: 'DAL', parser: 'ics_delta_micrew', needsIcs: true,
              icsLabel: 'MiCrew ICS URL', icsHint: 'The published calendar subscription link from MiCrew.' },
            { icao: 'GJS',   dbCode: 'GJS', parser: 'ics_rosterbuster', needsIcs: true,
              icsLabel: 'RosterBuster ICS URL',
              icsHint: 'From RosterBuster: Settings → Calendar Sync → copy the subscription link.' },
            { icao: 'RPA',   dbCode: 'RPA', parser: 'csv_republic', needsIcs: false },
            { icao: 'SKW',   dbCode: 'SKW', parser: 'vcs_skywest', needsIcs: false },
            { icao: 'SWA',   dbCode: 'SWA', parser: 'ics_southwest', needsIcs: true,
              icsLabel: 'CrewHub ICS URL', icsHint: 'The published calendar subscription link from CrewHub.' },
            // Kyle's private corporate operator -- not a public airline, so there's no ICS URL
            // field for it (sync happens via the separate Schedaero modal/quick-sync buttons,
            // gated elsewhere purely on parser_type === 'schedaero'). This option exists so his
            // profile has a real, selectable match instead of silently falling through to
            // "Other" -- which, now that parser_type/airline_code are plain DB columns with no
            // hardcoded override protecting them, would have actually broken his Schedaero sync
            // if anyone ever saved his profile without it.
            { icao: 'SJJ',   dbCode: 'SJJ', parser: 'schedaero', needsIcs: false },
            { icao: 'SCX',   dbCode: 'SCX', parser: 'ics_scx',     needsIcs: true,
              icsLabel: 'eCrew ICS URL', icsHint: 'The calendar subscription link from eCrew.' },
            // NetJets has no schedule feed, so no upload or sync (needsIcs: false; see
            // updateUploadSyncButtons(), isSyncPilot only matches 'schedaero'/'ics*'). Legs come from
            // the saved tail, tour days from the rotation. Public on /join, labelled Beta.
            { icao: 'EJA',   dbCode: 'EJA', parser: 'manual_netjets', needsIcs: false },
            { icao: 'OTHER', dbCode: '',    parser: 'other', needsIcs: false },
        ];

        let _editUserOriginalBase = '';
        function _onEditUserBaseChange() {
            const changed = document.getElementById('edit-user-base').value.trim() !== _editUserOriginalBase;
            document.getElementById('edit-user-base-effective-row').classList.toggle('hidden', !changed);
        }

        function _onAirlineChange() {
            const val = document.getElementById('edit-user-airline-sel').value;
            const opt = AIRLINE_OPTIONS.find(o => o.icao === val);
            document.getElementById('edit-user-ics-row').classList.toggle('hidden', !opt?.needsIcs);
            document.getElementById('edit-user-ics-label').textContent = opt?.icsLabel || 'ICS Calendar URL';
            document.getElementById('edit-user-ics-hint').textContent  = opt?.icsHint
                || "Paste the private subscription link from your airline's scheduling app.";
            // Role/Description is cosmetic-only (never parsed/enforced -- see CLAUDE.md), but
            // NetJets has no feed at all to otherwise signal "this account works differently," so
            // default it in when picking NetJets specifically -- only if nothing's been typed yet,
            // so this never clobbers an existing pilot's own wording.
            const roleEl = document.getElementById('edit-user-role');
            if (val === 'EJA' && roleEl && !roleEl.value.trim()) roleEl.value = 'NetJets · Home-based';
        }

        function _airlineSelectValue(airlineCode, parserType) {
            const byParser = AIRLINE_OPTIONS.find(o => o.parser === parserType && o.parser !== 'other');
            if (byParser) return byParser.icao;
            const opt = AIRLINE_OPTIONS.find(o => o.icao === airlineCode);
            return opt ? opt.icao : 'OTHER';
        }

        function _toggleViewerMode(forceTo) {
            _editUserIsViewer = (forceTo !== undefined) ? forceTo : !_editUserIsViewer;
            const knob   = document.getElementById('edit-user-viewer-knob');
            const toggle = document.getElementById('edit-user-viewer-toggle');
            const fields = document.getElementById('edit-user-pilot-fields');
            const row    = document.getElementById('edit-user-viewer-row');
            const friendsSection = document.getElementById('edit-user-friends-section');
            const editingKey = document.getElementById('edit-user-key').value;
            if (_editUserIsViewer) {
                knob.style.transform    = 'translateX(20px)';
                toggle.style.background = '#16a34a';
                row.style.borderColor   = '#16a34a';
                fields.classList.add('hidden');
                // Viewers are friend-gated now too (admin-assigned only, no self-service) --
                // still show the toggle list so admin can actually grant them access to someone.
                if (editingKey && editingKey !== 'admin') friendsSection.classList.remove('hidden');
                else friendsSection.classList.add('hidden');
            } else {
                knob.style.transform    = 'translateX(0px)';
                toggle.style.background = '#3f3f46';
                row.style.borderColor   = '#166534';
                fields.classList.remove('hidden');
                if (editingKey && editingKey !== 'admin') friendsSection.classList.remove('hidden');
            }
        }

        // Admin-only friend management inside the edit-user modal — bypasses the request/accept
        // flow (POST/DELETE /api/admin/friends create or remove an already-accepted row directly).
        let _editUserFriendKeys = new Set(); // accepted friends of the pilot currently being edited

        // Read-only admin view into a NetJets pilot's self-service rotation/tour data (set by the
        // pilot themselves in My Info -- admin has no edit UI for this, just visibility, same
        // reasoning as "Known, deliberately out-of-scope remainders" elsewhere in this app: build
        // the thing that's actually needed, not speculative admin-editing for a one-pilot beta).
        async function _loadEditUserNetjetsStatus(pilotKey) {
            const el = document.getElementById('edit-user-netjets-summary');
            try {
                const data = await fetch(`${API_BASE}/pilots/${pilotKey}?token=${encodeURIComponent(myToken)}`).then(r => r.json());
                pilotsCache[pilotKey] = data;
                const todayStr = _todayLocalDateStr();
                const ccDays = data.cc_schedule_days || [];
                if (ccDays.length) {
                    // CC overrides any Line-based rotation whenever it has data (same precedence
                    // _isNetJetsOnDuty() uses) -- report that, not a possibly-stale rotation row.
                    const todays = ccDays.find(d => d.date === todayStr);
                    const variantLabel = data.cc_variant ? `CC${data.cc_variant}` : 'CC schedule';
                    el.innerHTML = [
                        `${variantLabel} — ${ccDays.length} day${ccDays.length === 1 ? '' : 's'} on file.`,
                        todays ? `Today (${todayStr}): ${todays.status} · ${ccCodeInfo(todays.status).desc}` : `No CC day on file for today (${todayStr}).`,
                    ].map(l => `<span class="block">${l}</span>`).join('');
                    return;
                }
                const rotation = _resolveRotationAt(data.rotation_history, todayStr);
                if (!rotation) { el.textContent = 'No rotation saved yet.'; return; }
                const tourStart = _tourStartDateFor(pilotKey, todayStr);
                const lines = [`Rotation: ${rotation.days_on} on / ${rotation.days_off} off (since ${rotation.effective_from}).`];
                if (tourStart) {
                    const tail = _tourTailFor(pilotKey, tourStart);
                    const startApt = _tourStartAirportFor(pilotKey, tourStart);
                    lines.push(`On duty — tour started ${tourStart}.`);
                    lines.push(tail ? `Tail: ${tail} (${ejaCallsignFor(tail)})` : 'No tail saved for this tour yet.');
                    if (startApt) lines.push(`Starting airport: ${startApt}`);
                } else {
                    lines.push('Currently off-duty.');
                }
                el.innerHTML = lines.map(l => `<span class="block">${l}</span>`).join('');
            } catch {
                el.textContent = 'Failed to load.';
            }
        }
        function ejaCallsignFor(tail) {
            const digits = (tail || '').replace(/\D/g, '');
            return digits ? `EJA${digits}` : '—';
        }

        async function _loadEditUserFriends(pilotKey) {
            const listEl = document.getElementById('edit-user-friends-list');
            listEl.innerHTML = `<p class="text-xs text-zinc-600 py-1">Loading…</p>`;
            try {
                const data = await fetch(`${API_BASE}/admin/friends/${pilotKey}?token=${encodeURIComponent(myToken)}`).then(r => r.json());
                _editUserFriendKeys = new Set((data.friends || []).map(f => f.pilotKey));
            } catch {
                _editUserFriendKeys = new Set();
            }
            _renderEditUserFriendsList(pilotKey);
        }

        function _renderEditUserFriendsList(pilotKey) {
            const listEl = document.getElementById('edit-user-friends-list');
            const candidates = _adminUsers.filter(u => u.pilot_key !== pilotKey && u.pilot_key !== 'admin' && u.role !== 'viewer');
            if (!candidates.length) {
                listEl.innerHTML = `<p class="text-xs text-zinc-600 py-1">No other pilots to friend yet.</p>`;
                return;
            }
            listEl.innerHTML = candidates.map(u => {
                const c  = PILOT_COLORS[u.pilot_key] || '#6366f1';
                const on = _editUserFriendKeys.has(u.pilot_key);
                return `<label class="flex items-center justify-between py-2 px-3 rounded-xl cursor-pointer transition-colors ${on ? '' : 'opacity-50'}" style="background:${on ? c+'14' : 'transparent'};border:1px solid ${on ? c+'50' : '#3f3f46'}">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <div class="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black shrink-0" style="background:${c}22;color:${c}">${(u.name || u.pilot_key)[0].toUpperCase()}</div>
                        <span class="text-sm font-black text-white truncate">${escapeHtml(u.name || u.pilot_key)}</span>
                    </div>
                    <div onclick="_toggleAdminFriend('${pilotKey}', '${u.pilot_key}', ${!on})" class="w-11 h-6 rounded-full flex items-center transition-all cursor-pointer px-0.5 shrink-0" style="background:${on ? c+'cc' : '#3f3f46'}">
                        <div class="w-5 h-5 rounded-full bg-white shadow transition-transform" style="transform:translateX(${on ? '20px' : '0px'})"></div>
                    </div>
                </label>`;
            }).join('');
        }

        async function _toggleAdminFriend(pilotKey, otherKey, makeFriend) {
            try {
                const r = await fetch(`${API_BASE}/admin/friends`, {
                    method: makeFriend ? 'POST' : 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, pilotA: pilotKey, pilotB: otherKey })
                });
                if (!r.ok) { showToast('Could not update friendship', 'error'); return; }
                if (makeFriend) _editUserFriendKeys.add(otherKey); else _editUserFriendKeys.delete(otherKey);
                _renderEditUserFriendsList(pilotKey);
            } catch { showToast('Network error', 'error'); }
        }

        function openEditUserModal(pilotKey) {
            const errEl = document.getElementById('edit-user-error');
            errEl.classList.add('hidden');
            document.getElementById('edit-user-key').value = pilotKey || '';
            document.getElementById('edit-user-title').textContent = pilotKey ? 'Edit User' : 'Add User';
            document.getElementById('edit-user-save-btn').textContent = pilotKey ? 'Save' : 'Add User';

            const friendsSection = document.getElementById('edit-user-friends-section');
            if (pilotKey) {
                const u = _adminUsers.find(x => x.pilot_key === pilotKey);
                if (u) {
                    const isViewer = u.role === 'viewer';
                    _toggleViewerMode(isViewer);
                    const nameParts = (u.name || '').split(' ');
                    document.getElementById('edit-user-first').value = nameParts[0] || '';
                    document.getElementById('edit-user-last').value = nameParts.slice(1).join(' ') || '';
                    document.getElementById('edit-user-base').value = u.base || '';
                    _editUserOriginalBase = (u.base || '').toUpperCase().trim();
                    document.getElementById('edit-user-base-effective-row').classList.add('hidden');
                    document.getElementById('edit-user-base-effective').value = new Date().toISOString().slice(0, 10);
                    document.getElementById('edit-user-home').value = u.home_airport || '';
                    const asel = _airlineSelectValue(u.airline_code || '', u.parser_type || '');
                    document.getElementById('edit-user-airline-sel').value = asel;
                    document.getElementById('edit-user-role').value = isViewer ? '' : (u.role || '');
                    _onAirlineChange();
                    document.getElementById('edit-user-ics-url').value = '';
                    const aopt = AIRLINE_OPTIONS.find(o => o.icao === asel);
                    if (aopt?.needsIcs) {
                        fetch(`${API_BASE}/pilots/${u.pilot_key}/ics-url${myToken ? `?token=${myToken}` : ''}`)
                            .then(r => r.ok ? r.json() : null)
                            .then(d => { if (d?.url) document.getElementById('edit-user-ics-url').value = d.url; })
                            .catch(() => {});
                    }
                    const netjetsSection = document.getElementById('edit-user-netjets-section');
                    if (asel === 'EJA') {
                        netjetsSection.classList.remove('hidden');
                        document.getElementById('edit-user-netjets-summary').textContent = 'Loading…';
                        _loadEditUserNetjetsStatus(u.pilot_key);
                    } else {
                        netjetsSection.classList.add('hidden');
                    }
                    if (pilotKey === 'admin') {
                        friendsSection.classList.add('hidden');
                    } else {
                        friendsSection.classList.remove('hidden');
                        _loadEditUserFriends(pilotKey);
                    }
                }
            } else {
                _toggleViewerMode(false);
                ['edit-user-first','edit-user-last','edit-user-base','edit-user-home','edit-user-role'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('edit-user-airline-sel').value = '';
                document.getElementById('edit-user-ics-url').value = '';
                document.getElementById('edit-user-ics-row').classList.add('hidden');
                document.getElementById('edit-user-netjets-section').classList.add('hidden');
                // A brand-new pilot has no prior base to protect -- nothing to date.
                _editUserOriginalBase = '';
                document.getElementById('edit-user-base-effective-row').classList.add('hidden');
                friendsSection.classList.add('hidden');
            }
            document.getElementById('edit-user-modal').classList.remove('hidden');
        }

        function closeEditUserModal() {
            document.getElementById('edit-user-modal').classList.add('hidden');
        }

        async function saveUser() {
            const pilotKey = document.getElementById('edit-user-key').value;
            const firstName = document.getElementById('edit-user-first').value.trim();
            const lastName  = document.getElementById('edit-user-last').value.trim();
            const base        = _editUserIsViewer ? '' : document.getElementById('edit-user-base').value.trim();
            const baseChanged  = !_editUserIsViewer && pilotKey && base !== _editUserOriginalBase;
            const baseEffectiveFrom = baseChanged ? (document.getElementById('edit-user-base-effective').value || null) : null;
            const homeAirport = _editUserIsViewer ? '' : document.getElementById('edit-user-home').value.trim();
            const airlineSel  = document.getElementById('edit-user-airline-sel').value;
            const airlineOpt  = AIRLINE_OPTIONS.find(o => o.icao === airlineSel) || { dbCode: '', parser: 'other', needsIcs: false };
            const airline     = _editUserIsViewer ? '' : (airlineOpt.dbCode || '');
            const role        = _editUserIsViewer ? 'viewer' : document.getElementById('edit-user-role').value.trim();
            const parser      = _editUserIsViewer ? 'none' : airlineOpt.parser;
            const icsUrl      = (!_editUserIsViewer && airlineOpt.needsIcs) ? document.getElementById('edit-user-ics-url').value.trim() : '';
            const errEl       = document.getElementById('edit-user-error');
            const saveBtn     = document.getElementById('edit-user-save-btn');

            if (!firstName) { errEl.textContent = 'First name required'; errEl.classList.remove('hidden'); return; }

            errEl.classList.add('hidden');
            saveBtn.textContent = 'Saving…';
            saveBtn.disabled = true;

            try {
                let finalPilotKey = pilotKey;
                if (pilotKey) {
                    const r = await fetch(`${API_BASE}/pilots/${pilotKey}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: myToken, name: `${firstName} ${lastName}`.trim(), base, homeAirport, role, parserType: parser, airlineCode: airline, baseEffectiveFrom })
                    });
                    if (!r.ok) { errEl.textContent = 'Save failed — try again'; errEl.classList.remove('hidden'); return; }
                } else {
                    const r = await fetch(`${API_BASE}/join`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ firstName, lastName, base, homeAirport, role, parserType: parser, airlineCode: airline })
                    });
                    if (!r.ok) { errEl.textContent = 'Save failed — try again'; errEl.classList.remove('hidden'); return; }
                    const data = await r.json();
                    finalPilotKey = data.pilotKey;
                }
                if (icsUrl && finalPilotKey) {
                    saveBtn.textContent = 'Syncing…';
                    const syncR = await fetch(`${API_BASE}/pilots/${finalPilotKey}/sync-ics`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: icsUrl, token: myToken })
                    });
                    if (!syncR.ok) {
                        const syncErr = await syncR.json().catch(() => ({}));
                        errEl.textContent = `Saved, but ICS sync failed: ${syncErr.error || 'Unknown'}`;
                        errEl.classList.remove('hidden');
                    }
                }
                closeEditUserModal();
                await loadAdminUsers();
                showToast(pilotKey ? 'User updated' : 'User added');
            } catch { errEl.textContent = 'Network error'; errEl.classList.remove('hidden'); }
            finally { saveBtn.textContent = pilotKey ? 'Save' : 'Add User'; saveBtn.disabled = false; }
        }

