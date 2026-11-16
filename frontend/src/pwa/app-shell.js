        // Initialize on page load
        // ── Offline indicator ───────────────────────────────────────────
        (function setupOfflineIndicator() {
            const banner = document.getElementById('offline-banner');
            const show = () => { banner.classList.add('offline-visible'); haptic('error'); };
            const hide = () => {
                banner.classList.remove('offline-visible');
                showToast('Back online', 'success', 2500);
            };
            window.addEventListener('offline', show);
            window.addEventListener('online', hide);
            if (!navigator.onLine) banner.classList.add('offline-visible');
        })();

        // ── PWA install prompt ──────────────────────────────────────────
        let _pwaDeferred = null;

        function _pwaCanShow() {
            if (window.navigator.standalone) return false; // already installed
            const ts = parseInt(localStorage.getItem('pwa-dismissed') || '0');
            return Date.now() - ts > 7 * 24 * 60 * 60 * 1000;
        }

        function _pwaShow(platform) {
            if (!_pwaCanShow()) return;
            const prompt = document.getElementById('pwa-prompt');
            if (!prompt) return;
            if (platform === 'ios') {
                document.getElementById('pwa-prompt-sub').textContent = 'Tap the Share button ↑ then "Add to Home Screen"';
            } else {
                document.getElementById('pwa-install-btn').style.display = '';
            }
            setTimeout(() => prompt.classList.add('pwa-visible'), 2000);
        }

        async function pwaInstall() {
            if (!_pwaDeferred) return;
            _pwaDeferred.prompt();
            await _pwaDeferred.userChoice;
            _pwaDeferred = null;
            pwaDismiss();
        }

        function pwaDismiss() {
            localStorage.setItem('pwa-dismissed', String(Date.now()));
            const prompt = document.getElementById('pwa-prompt');
            if (prompt) prompt.classList.remove('pwa-visible');
        }

        // Android/Chrome: capture native prompt
        window.addEventListener('beforeinstallprompt', e => {
            e.preventDefault();
            _pwaDeferred = e;
            _pwaShow('android');
        });

        // iOS Safari: show manual instructions if not already installed
        (function() {
            const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
            const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
            if (isIOS && isSafari && !window.navigator.standalone) _pwaShow('ios');
        })();

        // ── App version ─────────────────────────────────────────────────
        fetch('/api/version').then(r => r.json()).then(({ version }) => {
            const label = `v${version.replace(/-beta(?:\.(\d+))?$/i, (_, n) => n ? ` Beta ${n}` : ' Beta')}`;
            const splash = document.getElementById('splash-version');
            const sidebar = document.getElementById('sidebar-version');
            if (splash) splash.textContent = label;
            if (sidebar) sidebar.textContent = label;
        }).catch(() => {});

        // ── Schedule upload reminder ─────────────────────────────────────
        function checkScheduleUploadReminder(pilot) {
            if (!myPilot || pilot !== myPilot || isDemo) return;
            // Only remind pilots who manually upload files (Schedaero and ICS pilots auto-sync).
            // A NetJets pilot's legs come from the tail, so a 7&7 or 8&6 pilot has nothing to upload.
            // A CC pilot does: their tour days only exist for months they've uploaded. Old CC days
            // left behind by a switch to a rotation don't count, hence the rotation check.
            const pilotData = pilotsCache[pilot];
            const parser = pilotData?.parser_type || '';
            const ccDays = pilotData?.cc_schedule_days || [];
            const isCc = parser === 'manual_netjets' && !!(pilotData?.cc_variant || (ccDays.length && !(pilotData?.rotation_history || []).length));
            if (parser === 'schedaero' || parser === 'ics_rosterbuster' || parser.startsWith('ics') || (parser === 'manual_netjets' && !isCc)) return;

            const now = new Date();
            const day = now.getDate();
            const month = now.getMonth(); // 0-indexed
            const year  = now.getFullYear();
            const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

            // Determine which month we're checking for
            let targetMonth, targetYear, isUrgent;
            if (day >= 23) {
                targetMonth = (month + 1) % 12;
                targetYear  = month === 11 ? year + 1 : year;
                isUrgent    = day >= 28;
            } else {
                // Already in new month — check if THIS month has fresh data
                targetMonth = month;
                targetYear  = year;
                isUrgent    = true;
            }

            const targetStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`;
            const prevMonth = targetMonth === 0 ? 11 : targetMonth - 1;
            const prevYear  = targetMonth === 0 ? targetYear - 1 : targetYear;
            const prevStr   = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`;

            const workFlights = (pilotsCache[pilot]?.segments || [])
                .filter(s => s.type === 'flight' && s.trip !== 'PERSONAL');

            // Trips whose first leg departed in the previous month — these are carry-overs
            const carryOverTrips = new Set(
                workFlights
                    .filter(s => s.trip && (s.departure_time || s.departureTime || '').startsWith(prevStr))
                    .map(s => s.trip)
            );

            // "Real" target-month data: a work flight departing in the target month
            // that does NOT belong to a carry-over trip from the previous month
            const hasData = isCc ? ccDays.some(d => d.date.startsWith(targetStr)) : workFlights.some(s =>
                (s.departure_time || s.departureTime || '').startsWith(targetStr) &&
                (!s.trip || !carryOverTrips.has(s.trip))
            );

            if (hasData) return;

            // Days 23–27: show once per login cycle (localStorage key per pilot/month)
            if (!isUrgent) {
                const seenKey = `upload_reminder_${pilot}_${year}_${month}`;
                if (localStorage.getItem(seenKey)) return;
                localStorage.setItem(seenKey, '1');
            }

            const monthLabel = MONTHS[targetMonth] + (targetYear !== year ? ` ${targetYear}` : '');
            const isCurrent  = targetMonth === month && targetYear === year;
            const msg = isCc
                ? (isCurrent
                    ? `No CC schedule for ${monthLabel}. Your tour days won't show until you upload it.`
                    : `No ${monthLabel} CC schedule yet. Upload your monthly schedule when you have it.`)
                : isCurrent
                ? `No flights found for ${monthLabel}. Upload or sync your schedule to stay current.`
                : `No ${monthLabel} flights yet. If bid results are out, add your schedule when you're ready.`;

            const el = document.getElementById('upload-reminder');
            if (!el) return;
            document.getElementById('upload-reminder-msg').textContent = msg;
            el.classList.remove('hidden');
        }

        function dismissUploadReminder() {
            document.getElementById('upload-reminder')?.classList.add('hidden');
        }

        function uploadReminderUpload() {
            dismissUploadReminder();
            openMobileUpload();
        }

        // ── Splash screen ───────────────────────────────────────────────
        // Shown when initIdentity() can't resolve the login token after retrying (see its own
        // comment) -- deliberately leaves the splash screen up rather than dismissing it, since
        // an unresolved identity must never fall through into the rest of the app (myPilot/
        // myToken staying at their initial null values is indistinguishable from admin there).
        function _showIdentityError() {
            const subEl = document.getElementById('splash-sub-text');
            const dotsEl = document.getElementById('splash-dots');
            const retryBtn = document.getElementById('splash-retry-btn');
            if (subEl) { subEl.textContent = 'Connection problem — couldn\'t sign you in'; subEl.style.color = '#f87171'; }
            if (dotsEl) dotsEl.style.display = 'none';
            if (retryBtn) retryBtn.classList.remove('hidden');
        }

        function dismissSplash() {
            const s = document.getElementById('splash-screen');
            if (!s || s.classList.contains('splash-hide')) return;
            s.classList.add('splash-hide');
            s.addEventListener('transitionend', () => s.classList.add('splash-gone'), { once: true });
        }
        // Safety fallback — dismiss after 4s no matter what
        setTimeout(dismissSplash, 4000);

