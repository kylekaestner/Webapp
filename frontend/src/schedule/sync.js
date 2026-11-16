        // ── Schedaero Sync ───────────────────────────────────────────────
        async function openSchedaeroSync(expired = false) {
            document.getElementById('schedaero-error').classList.add('hidden');
            // Set cookie-only mode when session expired
            document.getElementById('schedaero-expired-banner').classList.toggle('hidden', !expired);
            document.getElementById('schedaero-creds-toggle').classList.toggle('hidden', !expired);
            document.getElementById('schedaero-creds-fields').classList.toggle('hidden', expired);
            document.getElementById('schedaero-month-range').classList.toggle('hidden', expired);
            // Populate from localStorage immediately
            document.getElementById('schedaero-url').value      = localStorage.getItem('schedaero_url')      || '';
            document.getElementById('schedaero-apitoken').value = localStorage.getItem('schedaero_apitoken') || '';
            document.getElementById('schedaero-cookie').value   = localStorage.getItem('schedaero_cookie')   || '';
            const lb = localStorage.getItem('schedaero_months_back');
            const la = localStorage.getItem('schedaero_months_ahead');
            if (lb) document.getElementById('schedaero-months-back').value = lb;
            if (la) document.getElementById('schedaero-months').value = la;
            // Overlay with server-stored creds — synced across all devices
            try {
                const c = await fetch(`${API_BASE}/settings/schedaero-creds`).then(r => r.json());
                if (c.url)         document.getElementById('schedaero-url').value         = c.url;
                if (c.apiToken)    document.getElementById('schedaero-apitoken').value    = c.apiToken;
                if (c.cookie)      document.getElementById('schedaero-cookie').value      = c.cookie;
                if (c.monthsBack)  document.getElementById('schedaero-months-back').value = c.monthsBack;
                if (c.monthsAhead) document.getElementById('schedaero-months').value      = c.monthsAhead;
            } catch (_) {}
            document.getElementById('schedaero-modal').classList.remove('hidden');
            if (expired) {
                const cookieEl = document.getElementById('schedaero-cookie');
                cookieEl.focus();
                cookieEl.select();
            }
        }

        function closeSchedaeroModal() {
            document.getElementById('schedaero-modal').classList.add('hidden');
            // Reset to full mode for next open
            document.getElementById('schedaero-expired-banner').classList.add('hidden');
            document.getElementById('schedaero-creds-toggle').classList.add('hidden');
            document.getElementById('schedaero-creds-fields').classList.remove('hidden');
            document.getElementById('schedaero-month-range').classList.remove('hidden');
        }

        async function quickSyncSchedaero() {
            const btn = document.getElementById('mobile-sync-schedaero-btn');
            const orig = btn ? btn.textContent : '';
            if (btn) { btn.textContent = '⟳ Syncing…'; btn.disabled = true; }
            try {
                const resp = await fetch(`${API_BASE}/pilots/kyle/quick-sync-schedaero`, { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    loadPilot('kyle');
                    showToast(`Schedaero synced — ${data.segmentsAdded} segments updated`);
                } else if (data.sessionExpired) {
                    openSchedaeroSync(true);
                } else {
                    // No creds saved or other error — open full form
                    openSchedaeroSync(false);
                }
            } catch (e) {
                openSchedaeroSync(false);
            }
            if (btn) { btn.textContent = orig; btn.disabled = false; }
        }

        async function syncSchedaero() {
            const url      = document.getElementById('schedaero-url').value.trim();
            const apiToken = document.getElementById('schedaero-apitoken').value.trim();
            const cookie   = document.getElementById('schedaero-cookie').value.trim();
            const count    = parseInt(document.getElementById('schedaero-months').value);
            const errEl    = document.getElementById('schedaero-error');
            const btn      = document.getElementById('schedaero-sync-btn');

            errEl.classList.add('hidden');

            if (!url || !apiToken || !cookie) {
                errEl.textContent = 'URL, API token, and cookie are all required.';
                errEl.classList.remove('hidden');
                return;
            }

            const monthsBack  = document.getElementById('schedaero-months-back').value;
            const monthsAhead = document.getElementById('schedaero-months').value;

            btn.textContent = 'Syncing…';
            btn.disabled = true;

            const now = new Date();
            const back = parseInt(monthsBack);
            let totalAdded = 0;
            const errors = [];

            for (let i = -back; i < count; i++) {
                const d     = new Date(now.getFullYear(), now.getMonth() + i, 1);
                const month = d.getMonth() + 1;
                const year  = d.getFullYear();
                try {
                    const resp = await fetch(`${API_BASE}/pilots/kyle/sync-schedaero`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cookie, schedaeroUrl: url, apiToken, month, year })
                    });
                    const result = await resp.json();
                    if (result.success) {
                        totalAdded += result.segmentsAdded;
                    } else {
                        errors.push(`${year}-${String(month).padStart(2,'0')}: ${result.error}`);
                    }
                } catch (err) {
                    errors.push(`${year}-${String(month).padStart(2,'0')}: ${err.message}`);
                }
            }

            btn.textContent = 'Sync';
            btn.disabled = false;

            if (errors.length > 0) {
                errEl.textContent = errors.join(' | ');
                errEl.classList.remove('hidden');
            } else {
                // Persist creds only after a fully successful sync
                localStorage.setItem('schedaero_url',          url);
                localStorage.setItem('schedaero_apitoken',     apiToken);
                localStorage.setItem('schedaero_cookie',       cookie);
                localStorage.setItem('schedaero_months_back',  monthsBack);
                localStorage.setItem('schedaero_months_ahead', monthsAhead);
                fetch(`${API_BASE}/settings/schedaero-creds`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, apiToken, cookie, monthsBack, monthsAhead })
                }).catch(() => {});
                closeSchedaeroModal();
                showToast(`Schedaero synced — ${totalAdded} segments updated`);
                loadPilot('kyle');
            }
        }
        // ─────────────────────────────────────────────────────────────────

        function updateUploadSyncButtons(pilot) {
            const parser      = pilotsCache[pilot]?.parser_type || '';
            const isSchedaero = parser === 'schedaero';
            const isICS       = parser.startsWith('ics');
            const isSyncOnly  = isSchedaero || isICS;
            // Desktop
            document.getElementById('btn-upload-schedule')?.classList.toggle('hidden', isSyncOnly);
            document.getElementById('btn-sync-schedaero')?.classList.toggle('hidden', !isSchedaero);
            document.getElementById('btn-sync-ics')?.classList.toggle('hidden', !isICS);
            // Mobile
            document.getElementById('mobile-upload-file-btn')?.classList.toggle('hidden', isSyncOnly);
            document.getElementById('mobile-sync-schedaero-btn')?.classList.toggle('hidden', !isSchedaero);
            document.getElementById('mobile-sync-ics-btn')?.classList.toggle('hidden', !isICS);
            // Update mobile nav label
            if (pilot === myPilot) {
                const uploadLabel = document.getElementById('mbtn-upload-label');
                if (uploadLabel) uploadLabel.textContent = isSyncOnly ? 'Sync' : 'Upload';
            }
        }

        // ── Generic ICS Sync (any ICS-based pilot) ────────────────────────
        function openGenericICSSync(pilotKey) {
            const modal = document.getElementById('ics-sync-modal');
            modal._pilotKey = pilotKey;
            const name = (pilotsCache[pilotKey]?.name || pilotKey).split(' ')[0];
            document.getElementById('ics-sync-modal-title').textContent = `Sync ${name}'s Schedule`;
            document.getElementById('ics-sync-url').value = '';
            document.getElementById('ics-sync-error').classList.add('hidden');
            fetch(`${API_BASE}/pilots/${pilotKey}/ics-url${myToken ? `?token=${myToken}` : ''}`)
                .then(r => r.ok ? r.json() : null)
                .then(d => { if (d?.url) document.getElementById('ics-sync-url').value = d.url; })
                .catch(() => {});
            modal.classList.remove('hidden');
        }

        function closeGenericICSModal() {
            document.getElementById('ics-sync-modal').classList.add('hidden');
        }

        async function syncGenericICS() {
            const modal    = document.getElementById('ics-sync-modal');
            const pilotKey = modal._pilotKey;
            const url      = document.getElementById('ics-sync-url').value.trim();
            const btn      = document.getElementById('ics-sync-btn');
            const errEl    = document.getElementById('ics-sync-error');
            if (!url) { errEl.textContent = 'URL required'; errEl.classList.remove('hidden'); return; }
            errEl.classList.add('hidden');
            btn.textContent = 'Syncing…';
            btn.disabled = true;
            try {
                const resp = await fetch(`${API_BASE}/pilots/${pilotKey}/sync-ics`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, token: myToken })
                });
                const result = await resp.json();
                if (result.success) {
                    closeGenericICSModal();
                    showToast(`Schedule synced — ${result.segmentsAdded} segments updated`);
                    if (myPilot === null && !myViewer && result.warnings && result.warnings.length) {
                        showToast(`⚠ ${result.warnings.length} unrecognized item${result.warnings.length > 1 ? 's' : ''} in this schedule — see Admin → Manage Users for details.`, 'info', 6000);
                    }
                    loadPilot(pilotKey);
                } else {
                    errEl.textContent = result.error || 'Sync failed';
                    errEl.classList.remove('hidden');
                }
            } catch (err) {
                errEl.textContent = err.message;
                errEl.classList.remove('hidden');
            }
            btn.textContent = 'Sync';
            btn.disabled = false;
        }
        // ─────────────────────────────────────────────────────────────────

