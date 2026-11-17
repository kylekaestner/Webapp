        function openViewHelp() {
            const modalId = {
                grid: 'grid-help-modal',
                list: 'list-help-modal',
                map: 'map-help-modal',
                overlap: 'overlap-help-modal',
                intel: 'intel-help-modal',
            }[currentView];
            if (modalId) document.getElementById(modalId).classList.remove('hidden');
        }

        function trackEvent(event) {
            if (!myPilot && !myViewer) return; // skip admin
            const key = myPilot || myViewerKey || 'unknown';
            fetch(`${API_BASE}/analytics`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pilot_key: key, event })
            }).catch(() => {});
        }

        // The page itself never scrolls (every view scrolls inside <main>), but iOS Safari can still be moved
        // by code: then the crew names sit under the fixed header and the map's mode bar under the bottom nav.
        // Put the page and its fixed containers back to 0.
        function _resetPageShift() {
            const col = document.getElementById('mobile-pilot-bar')?.parentElement;
            for (const el of [document.documentElement, document.body, col, document.querySelector('main')]) {
                if (el && el.scrollTop) el.scrollTop = 0;
            }
            if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
        }

        // Phones: how far the fixed bottom nav actually covers <main>, measured, as --nav-overlap. The map view
        // keeps exactly that much room at its bottom so the My Routes / Day / Month bar sits on top of the nav.
        // It used to be a fixed 68px; on some iPhones (a taller nav: text size, Safari vs Home Screen, screen
        // height) the bar ended up behind the nav. Re-measured on resize, nav size changes and every view switch.
        function _syncNavOverlap() {
            const nav = document.querySelector('.mobile-nav'), main = document.querySelector('main');
            if (!nav || !main) return;
            const n = nav.getBoundingClientRect(), m = main.getBoundingClientRect();
            const px = n.height ? Math.max(0, Math.round(m.bottom - n.top)) : 0;
            const root = document.documentElement;
            if (root.style.getPropertyValue('--nav-overlap') === px + 'px') return;
            root.style.setProperty('--nav-overlap', px + 'px');
            if (typeof map !== 'undefined' && map && currentView === 'map') map.invalidateSize({ animate: false });
        }
        (function () {
            const run = () => requestAnimationFrame(_syncNavOverlap);
            window.addEventListener('resize', run);
            window.addEventListener('orientationchange', () => setTimeout(run, 300));
            if (window.visualViewport) window.visualViewport.addEventListener('resize', run);
            const start = () => {
                run();
                const nav = document.querySelector('.mobile-nav');
                if (nav && window.ResizeObserver) new ResizeObserver(run).observe(nav, { box: 'border-box' }); // padding counts too
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
            window.addEventListener('load', run);
        })();

        function switchView(view) {
            haptic('tap');
            trackEvent('view:' + view);
            currentView = view;
            document.querySelectorAll('.view-section').forEach(s => s.classList.remove('view-active'));
            const viewEl = document.getElementById(`view-${view}`);
            viewEl.classList.add('view-active');
            viewEl.scrollTop = 0;
            // Desktop nav
            ['grid','list','map','overlap','intel'].forEach(v => {
                const btn = document.getElementById(`btn-${v}`);
                if (btn) btn.classList.toggle('nav-active', v === view);
            });
            // Mobile bottom nav
            document.querySelectorAll('.mbtn').forEach(b => b.classList.remove('mbtn-active'));
            const mbtn = document.getElementById(`mbtn-${view}`);
            if (mbtn) mbtn.classList.add('mbtn-active');
            const modeNav = document.getElementById('map-mode-nav');
            if (modeNav) { if (view === 'map') modeNav.classList.replace('hidden', 'flex'); else modeNav.classList.replace('flex', 'hidden'); }
            // Next flight strip only on grid
            const nfStrip = document.getElementById('mobile-next-trip');
            if (nfStrip) nfStrip.classList.toggle('hidden', view !== 'grid' || _nextFlightDismissed || nfStrip.innerHTML === '');
            // Mobile header: hide calendar-specific controls on overlap/intel
            const calView = view === 'grid' || view === 'list' || view === 'map';
            ['mobile-header-month-info','mobile-prev-btn','mobile-next-btn','btn-add-flight-mobile'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = calView ? '' : 'none';
            });
            // Hide pilot pill bar on overlap/intel — irrelevant to those views
            const pilotBar = document.getElementById('mobile-pilot-bar');
            if (pilotBar) pilotBar.style.display = calView ? '' : 'none';
            if (view === 'map') {
                // The map may have been created ahead of time off-screen (_prewarmMap): fit it to its real box.
                viewEl.classList.remove('map-prewarm');
                initMap();
                // Sync day nav / pilot controls visibility with the current mode
                const _dn = document.getElementById('day-nav');
                const _mdn = document.getElementById('mobile-day-nav-bar');
                const _pc = document.getElementById('map-pilot-controls');
                if (mapDayMode) {
                    _dn?.classList.replace('hidden', 'flex');
                    _mdn?.classList.replace('hidden', 'flex');
                    if (_pc) _pc.style.display = 'none';
                    updateDayNavLabel();
                } else if (!mapAllMode) {
                    _dn?.classList.replace('flex', 'hidden');
                    _mdn?.classList.replace('flex', 'hidden');
                    if (_pc) _pc.style.display = '';
                }
                // After the date row shows or hides, so the map knows its final height.
                if (map) map.invalidateSize({ animate: false });
            }
            if (view === 'overlap') {
                switchOverlapTab(_overlapTab || 'crossings');
                if (_overlapTab === 'crossings') computeOverlap().then(overlaps => ackMyCrossings(overlaps)).catch(() => {});
                // Clear notification badge when user opens the overlap view
                markAllNotifRead();
            }
            if (view === 'intel') loadIntel();
            render();
            _resetPageShift();
            _syncNavOverlap();
        }

