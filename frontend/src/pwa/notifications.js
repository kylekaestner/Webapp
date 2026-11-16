        // ── Push Notifications ───────────────────────────────────────────────

        const PUSH_ENABLED = false; // requires HTTPS — flip to true once domain+TLS is set up
        let _swRegistration = null;
        let _notifList = [];

        async function initServiceWorker() {
            if (!('serviceWorker' in navigator)) return;
            try {
                _swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
                navigator.serviceWorker.addEventListener('message', e => {
                    if (e.data?.type === 'OPEN_OVERLAP') switchView('overlap');
                });
            } catch (e) { console.warn('[SW] Registration failed:', e); }
        }

        async function initPushNotifications() {
            if (!myPilot || isDemo) return;
            if (!('Notification' in window) || !_swRegistration) return;
            if (localStorage.getItem('notif_prompt_dismissed') === '1') return;
            if (Notification.permission === 'granted') {
                await subscribeToPush();
            } else if (Notification.permission === 'default') {
                // Show prompt — iOS requires a user gesture so we can't auto-call requestPermission
                document.getElementById('notif-prompt-sidebar')?.classList.replace('hidden', 'flex');
            }
            // 'denied' — do nothing
        }

        async function requestNotifPermission() {
            dismissNotifPrompt();
            const permission = await Notification.requestPermission();
            if (permission === 'granted') await subscribeToPush();
        }

        function dismissNotifPrompt() {
            localStorage.setItem('notif_prompt_dismissed', '1');
            document.getElementById('notif-prompt-sidebar')?.classList.replace('flex', 'hidden');
        }

        async function subscribeToPush() {
            if (!_swRegistration || !myToken) return;
            try {
                const keyResp = await fetch('/api/push/vapid-key');
                if (!keyResp.ok) return;
                const { publicKey } = await keyResp.json();
                const existing = await _swRegistration.pushManager.getSubscription();
                const sub = existing || await _swRegistration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(publicKey)
                });
                await fetch('/api/push/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, subscription: sub.toJSON() })
                });
                document.getElementById('notif-bell-btn')?.classList.remove('hidden');
                document.getElementById('notif-bell-btn-mobile')?.classList.remove('hidden');
            } catch (e) { console.warn('[Push] Subscribe failed:', e); }
        }

        function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
            const raw = atob(base64);
            return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
        }

        async function loadNotifications() {
            if (!myPilot || !myToken || isDemo) return;
            try {
                const resp = await fetch(`/api/notifications?token=${encodeURIComponent(myToken)}`);
                if (!resp.ok) return;
                _notifList = await resp.json();
                updateNotifBadge();
            } catch (_) {}
        }

        function updateNotifBadge() {
            const unread = _notifList.filter(n => !n.is_read).length;
            const label = unread > 9 ? '9+' : String(unread);
            // Desktop bell
            const badge = document.getElementById('notif-badge');
            const bell = document.getElementById('notif-bell-btn');
            if (badge) { badge.textContent = label; badge.classList.toggle('hidden', unread === 0); }
            if (bell && PUSH_ENABLED) bell.classList.remove('hidden');
            // Mobile bell
            const badgeMobile = document.getElementById('notif-badge-mobile');
            const bellMobile = document.getElementById('notif-bell-btn-mobile');
            if (badgeMobile) { badgeMobile.textContent = label; badgeMobile.classList.toggle('hidden', unread === 0); }
            if (bellMobile && PUSH_ENABLED) bellMobile.classList.remove('hidden');
            // App badge (home screen icon)
            if ('setAppBadge' in navigator) {
                unread > 0 ? navigator.setAppBadge(unread).catch(() => {}) : navigator.clearAppBadge().catch(() => {});
            }
        }

        function toggleNotifPanel() {
            const panel = document.getElementById('notif-panel');
            if (!panel) return;
            if (panel.classList.contains('hidden')) {
                renderNotifPanel();
                panel.classList.remove('hidden');
            } else {
                closeNotifPanel();
            }
        }

        function closeNotifPanel() {
            document.getElementById('notif-panel')?.classList.add('hidden');
        }

        function renderNotifPanel() {
            const list = document.getElementById('notif-list');
            if (!list) return;
            if (!_notifList.length) {
                list.innerHTML = '<div class="px-4 py-8 text-center text-xs text-zinc-600">No notifications</div>';
                return;
            }
            const _rel = t => {
                const diff = Date.now() - new Date(t).getTime();
                if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))}m ago`;
                if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
                return `${Math.floor(diff / 86400000)}d ago`;
            };
            list.innerHTML = _notifList.map(n => `
                <div class="px-4 py-3 flex gap-3 items-start cursor-pointer hover:bg-zinc-800/40 transition-colors ${n.is_read ? 'opacity-50' : ''}" onclick="notifClick(${n.id})">
                    <div class="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${n.is_read ? 'bg-zinc-700' : 'bg-blue-500'}"></div>
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-black text-white leading-tight">${n.title}</div>
                        <div class="text-[11px] text-zinc-400 mt-0.5 leading-snug">${n.body}</div>
                    </div>
                    <span class="text-[9px] text-zinc-600 shrink-0 mt-0.5">${_rel(n.created_at)}</span>
                </div>
            `).join('');
        }

        function notifClick(id) {
            const n = _notifList.find(x => x.id === id);
            if (n) n.is_read = true;
            updateNotifBadge();
            closeNotifPanel();
            switchView('overlap');
            fetch('/api/notifications/read', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: myToken })
            }).catch(() => {});
        }

        async function markAllNotifRead() {
            _notifList.forEach(n => n.is_read = true);
            updateNotifBadge();
            renderNotifPanel();
            if (!myToken) return;
            await fetch('/api/notifications/read', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: myToken })
            }).catch(() => {});
        }

        // ── In-app crossing alerts (badge + modal) ───────────────────────────
        const XALERT_BADGE_WINDOW = 48 * 3600 * 1000; // show badge up to 48h ahead
        const XALERT_MODAL_WINDOW = 24 * 3600 * 1000; // show modal up to 24h ahead

        function _xKey(o) {
            return [[o.kA, o.kB].sort().join('+'), o.airport || o.airportB || '',
                    (o.directStart || o.directEnd)?.toISOString().slice(0, 10) || ''].join('|');
        }
        function _getAcked() {
            try { return new Set(JSON.parse(localStorage.getItem('cs_xacked') || '[]')); }
            catch { return new Set(); }
        }
        function _saveAcked(set) {
            localStorage.setItem('cs_xacked', JSON.stringify([...set].slice(-300)));
        }

        function updateCrossingAlert(overlaps) {
            if (!myPilot || isDemo || !Array.isArray(overlaps)) return;
            const now = Date.now();
            const acked = _getAcked();
            const mine = overlaps.filter(o =>
                o.isDirect && o.directStart && o.directEnd &&
                (o.kA === myPilot || o.kB === myPilot) &&
                o.directEnd.getTime() > now
            );
            const upcoming  = mine.filter(o => o.directStart.getTime() <= now + XALERT_BADGE_WINDOW);
            const unacked   = upcoming.filter(o => !acked.has(_xKey(o)));
            const count     = unacked.length;
            ['crossing-badge-mobile', 'crossing-badge-desktop'].forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.classList.toggle('hidden', count === 0);
                el.textContent = count > 9 ? '9+' : (count > 0 ? String(count) : '');
            });
            // Modal: only crossings within 24h, only once per session
            const urgent = unacked.filter(o => o.directStart.getTime() <= now + XALERT_MODAL_WINDOW);
            if (urgent.length > 0 && !sessionStorage.getItem('cs_modal_shown')) {
                sessionStorage.setItem('cs_modal_shown', '1');
                _showCrossingModal(urgent);
            }
        }

        function ackMyCrossings(overlaps) {
            if (!myPilot || !Array.isArray(overlaps)) return;
            const now = Date.now();
            const acked = _getAcked();
            overlaps.filter(o =>
                o.isDirect && o.directStart && o.directEnd &&
                (o.kA === myPilot || o.kB === myPilot) &&
                o.directEnd.getTime() > now
            ).forEach(o => acked.add(_xKey(o)));
            _saveAcked(acked);
            ['crossing-badge-mobile', 'crossing-badge-desktop'].forEach(id =>
                document.getElementById(id)?.classList.add('hidden')
            );
        }

        function _showCrossingModal(crossings) {
            const modal   = document.getElementById('crossing-alert-modal');
            const content = document.getElementById('crossing-alert-content');
            if (!modal || !content) return;
            content.innerHTML = crossings.map(o => {
                const otherKey  = o.kA === myPilot ? o.kB : o.kA;
                const otherName = (PILOT_NAMES[otherKey] || otherKey).split(' ')[0];
                const apt       = o.airport || o.airportB || '';
                const tz        = apt ? airportTz(apt) : null;
                const fmtOpts   = { hour: 'numeric', minute: '2-digit', hour12: true, ...(tz ? { timeZone: tz } : {}) };
                const fmtT      = d => d.toLocaleTimeString('en-US', fmtOpts);
                const dateStr   = o.directStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) });
                const tzLbl     = tz ? ' ' + tzAbbr(apt, o.directStart.toISOString()) : '';
                const nowMs     = Date.now();
                const hoursAway = Math.round((o.directStart.getTime() - nowMs) / 3600000);
                const eta       = hoursAway <= 0 ? 'Now' : hoursAway < 24 ? `in ${hoursAway}h` : dateStr;
                return `<div class="rounded-xl bg-zinc-800/50 border border-zinc-700/40 px-4 py-3">
                    <div class="flex items-center justify-between mb-1">
                        <span class="text-sm font-black text-white">${aptLabel(apt)} · with ${otherName}</span>
                        <span class="text-[10px] font-black text-amber-400 uppercase">${eta}</span>
                    </div>
                    <div class="text-xs text-zinc-400 font-mono">${fmtT(o.directStart)} – ${fmtT(o.directEnd)}${tzLbl}</div>
                </div>`;
            }).join('');
            modal.classList.remove('hidden');
            haptic('tap');
        }

        function dismissCrossingAlert() {
            document.getElementById('crossing-alert-modal')?.classList.add('hidden');
        }
        function goToCrossings() {
            dismissCrossingAlert();
            switchView('overlap');
        }

