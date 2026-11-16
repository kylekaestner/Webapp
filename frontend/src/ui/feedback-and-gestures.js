        function showConfirm(title, body, { label = 'Delete', danger = true } = {}) {
            return new Promise(resolve => {
                _confirmCallback = resolve;
                document.getElementById('confirm-title').textContent = title;
                document.getElementById('confirm-body').textContent = body;
                const okBtn = document.getElementById('confirm-ok-btn');
                okBtn.textContent = label;
                okBtn.className = `flex-1 py-3.5 text-[11px] font-black uppercase tracking-wide transition-colors ${danger ? 'text-red-400 hover:text-red-300 hover:bg-red-950/30' : 'text-blue-400 hover:text-blue-300 hover:bg-blue-950/30'}`;
                document.getElementById('confirm-modal').classList.remove('hidden');
            });
        }
        function _confirmAccept() {
            document.getElementById('confirm-modal').classList.add('hidden');
            _confirmCallback?.(true);
            _confirmCallback = null;
        }
        function _confirmReject() {
            document.getElementById('confirm-modal').classList.add('hidden');
            _confirmCallback?.(false);
            _confirmCallback = null;
        }

        function showToast(msg, type = 'success', duration = 3800) {
            const icons = { success: '✓', error: '✕', info: 'ℹ' };
            const hapticMap = { success: 'success', error: 'error', info: 'tap' };
            haptic(hapticMap[type] ?? 'tap');
            const el = document.createElement('div');
            el.className = `toast toast-${type}`;
            el.innerHTML = `<span style="font-size:15px;flex-shrink:0">${icons[type] || icons.info}</span><span>${msg}</span>`;
            const container = document.getElementById('toast-container');
            container.appendChild(el);
            const dismiss = () => {
                el.classList.add('out');
                el.addEventListener('animationend', () => el.remove(), { once: true });
            };
            el.addEventListener('click', dismiss);
            setTimeout(dismiss, duration);
        }

        // ── Haptic feedback ──────────────────────────────────────────────────
        function haptic(type = 'tap') {
            if (!navigator.vibrate) return;
            const p = { tap: 8, success: [10, 40, 10], error: [60, 40, 60], heavy: 22 };
            navigator.vibrate(p[type] ?? 8);
        }

        // ── Swipe to change month + pull-to-refresh ─────────────────────────
        function setupMobileGestures() {
            const scrollEls = ['view-grid', 'view-list'].map(id => document.getElementById(id)).filter(Boolean);
            const ptr = document.getElementById('ptr-indicator');

            scrollEls.forEach(el => {
                let startX = 0, startY = 0, ptrActive = false, ptrTriggered = false;

                el.addEventListener('touchstart', e => {
                    startX = e.touches[0].clientX;
                    startY = e.touches[0].clientY;
                    ptrActive = el.scrollTop === 0;
                    ptrTriggered = false;
                }, { passive: true });

                el.addEventListener('touchmove', e => {
                    if (!ptrActive) return;
                    const dy = e.touches[0].clientY - startY;
                    const dx = e.touches[0].clientX - startX;
                    if (dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.2) {
                        const pull = Math.min(dy, 90);
                        const pct  = pull / 70;
                        ptr.style.opacity  = String(Math.min(pct, 1));
                        ptr.style.transform = `translate(-50%, ${pull - 52}px) rotate(${pct * 180}deg)`;
                        ptr.classList.toggle('ptr-releasing', pull >= 70);
                        ptrTriggered = pull >= 70;
                    }
                }, { passive: true });

                el.addEventListener('touchend', e => {
                    if (!ptrActive) return;
                    const dx = e.changedTouches[0].clientX - startX;
                    const dy = e.changedTouches[0].clientY - startY;

                    // Reset pull indicator
                    ptr.style.opacity = '0';
                    ptr.style.transform = 'translate(-50%, -52px)';
                    ptr.classList.remove('ptr-releasing');

                    if (ptrTriggered) {
                        haptic('success');
                        loadPilot(currentPilot);
                        showToast('Schedule refreshed', 'info', 1800);
                        return;
                    }

                    // Horizontal swipe → change month (only on grid/list)
                    if ((currentView === 'grid' || currentView === 'list') &&
                        Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                        haptic('tap');
                        changeMonth(dx < 0 ? 1 : -1);
                    }
                }, { passive: true });
            });

            // Horizontal swipe on overlap view → switch between Crossings and Off Days tabs
            const overlapEl = document.getElementById('view-overlap');
            if (overlapEl) {
                let oxStart = null, oyStart = 0;
                overlapEl.addEventListener('touchstart', e => {
                    if (e.target.closest('#offday-filter-bar') || e.target.closest('.offday-row-chips')) { oxStart = null; return; }
                    oxStart = e.touches[0].clientX;
                    oyStart = e.touches[0].clientY;
                }, { passive: true });
                overlapEl.addEventListener('touchend', e => {
                    if (oxStart === null) return;
                    const dx = e.changedTouches[0].clientX - oxStart;
                    const dy = e.changedTouches[0].clientY - oyStart;
                    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8) {
                        haptic('tap');
                        switchOverlapTab(dx < 0 ? 'offdays' : 'crossings');
                    }
                }, { passive: true });
            }
        }

        // ── Double-tap to zoom (iOS suppresses dblclick when user-scalable=no) ─
        function setupDoubleTapZoom(leafletMap) {
            let lastTap = 0, lastX = 0, lastY = 0;
            leafletMap.getContainer().addEventListener('touchstart', e => {
                if (e.touches.length > 1) { lastTap = 0; return; } // pinch in progress — reset so lift doesn't look like a double-tap
                const t = e.touches[0];
                const now = Date.now();
                if (now - lastTap < 350 && Math.abs(t.clientX - lastX) < 30 && Math.abs(t.clientY - lastY) < 30) {
                    const rect = leafletMap.getContainer().getBoundingClientRect();
                    const latlng = leafletMap.containerPointToLatLng(L.point(t.clientX - rect.left, t.clientY - rect.top));
                    leafletMap.setZoomAround(latlng, leafletMap.getZoom() + 1);
                    lastTap = 0;
                } else {
                    lastTap = now;
                    lastX = t.clientX;
                    lastY = t.clientY;
                }
            }, { passive: true });
        }

        // ── Swipe-to-dismiss for bottom sheets ──────────────────────────────
        function setupSheetSwipe(panelEl, dismissFn) {
            let startY = 0, dragging = false;
            panelEl.addEventListener('touchstart', e => {
                startY = e.touches[0].clientY;
                dragging = true;
                panelEl.style.transition = 'none';
            }, { passive: true });
            panelEl.addEventListener('touchmove', e => {
                if (!dragging) return;
                const dy = e.touches[0].clientY - startY;
                if (dy > 0) panelEl.style.transform = `translateY(${dy}px)`;
            }, { passive: true });
            panelEl.addEventListener('touchend', e => {
                if (!dragging) return;
                dragging = false;
                const dy = e.changedTouches[0].clientY - startY;
                panelEl.style.transition = 'transform 0.25s ease';
                if (dy > 80) {
                    panelEl.style.transform = `translateY(100%)`;
                    setTimeout(() => { panelEl.style.transform = ''; panelEl.style.transition = ''; dismissFn(); }, 220);
                } else {
                    panelEl.style.transform = '';
                    setTimeout(() => { panelEl.style.transition = ''; }, 250);
                }
            }, { passive: true });
        }

