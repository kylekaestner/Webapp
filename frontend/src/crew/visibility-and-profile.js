        // ── Crew visibility ─────────────────────────────────────────────────
        // A display preference layered ON TOP of friendship (who you've chosen to declutter
        // in/out of the map, pill bar, etc), bounded by visiblePilotKeys() — you can only hide
        // someone you're actually friends with (or, for admin/viewer, anyone).
        //
        // Persisted server-side (pilots.hidden_crew) as the set of EXPLICITLY HIDDEN keys,
        // not the set of visible ones — default is "visible", matching the friends model
        // (befriending someone shows them immediately, no second manual toggle needed). This
        // used to be a localStorage-only preference (crewVisible_<pilot>), which was per-browser
        // and caused the same person to show as visible on one device and hidden on another for
        // the same pilot. _hiddenCrew is loaded once via loadCrewVisibility() in initIdentity()
        // and kept in sync with the server on every toggle.
        let _hiddenCrew = new Set();

        // Legacy localStorage key format — only still read by _maybeSeedFriends()'s one-time
        // import of a pilot's pre-friends-system crew toggle. Not used for current visibility
        // state anymore (see _hiddenCrew above).
        function _visKey() {
            if (myPilot) return `crewVisible_${myPilot}`;
            if (myViewer) return `crewVisible_${myViewerKey}`;
            return 'crewVisible_admin';
        }

        async function loadCrewVisibility() {
            if (isDemo || !myToken) { _hiddenCrew = new Set(); return; }
            try {
                const data = await fetch(`/api/crew-visibility?token=${encodeURIComponent(myToken)}`).then(r => r.json());
                _hiddenCrew = new Set(Array.isArray(data.hidden) ? data.hidden : []);
            } catch { _hiddenCrew = new Set(); }
        }

        async function _saveCrewVisibility() {
            if (isDemo || !myToken) return;
            try {
                await fetch('/api/crew-visibility', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, hidden: [..._hiddenCrew] })
                });
            } catch { /* best-effort — local state already applied, will retry to persist next toggle */ }
        }

        function getCrewVisible() {
            // Self is always visible; everyone else allowed (friends, or everyone for
            // admin/viewer) is visible by default unless explicitly hidden.
            return visiblePilotKeys().filter(p => p === myPilot || !_hiddenCrew.has(p));
        }

        function setCrewVisible(pilot, visible) {
            if (visible) _hiddenCrew.delete(pilot); else if (pilot !== myPilot) _hiddenCrew.add(pilot);
            _saveCrewVisibility();
            _applyPilotPillVisibility();
            _buildCrewVisibilityUI();
            // For a real pilot, the actual visible toggle lives inline in the Friends list now
            // (renderFriendsPanel()), not the hidden #crew-visibility-section -- without this, the
            // row's onclick keeps whatever "next state" value was baked in at the last real
            // render, so a second click just re-sent the same value instead of flipping it again.
            renderFriendsPanel();
            _updateCrewLegend();
            if (currentView === 'map' && (mapDayMode || mapAllMode)) renderMap();
            // Keep _offDayFilter in sync — remove any pilot no longer in crew visible
            if (_offDayFilter) {
                const nextSet = new Set(getCrewVisible());
                _offDayFilter.forEach(k => { if (!nextSet.has(k)) _offDayFilter.delete(k); });
                // If newly visible, add to filter by default
                if (visible) _offDayFilter.add(pilot);
                renderCommonOffSection(true);
            }
        }

        function _applyIdentityUI() {
            const color    = myPilot ? PILOT_COLORS[myPilot] : myViewer ? '#10b981' : isDemo ? '#6366f1' : '#6366f1';
            const initials = myPilot ? PILOT_NAMES[myPilot].split(' ').map(w => w[0]).join('')
                           : myViewer ? myViewerName.split(' ').map(w => w[0]).join('') : isDemo ? 'D' : '★';
            const name     = myPilot ? PILOT_NAMES[myPilot] : myViewer ? myViewerName : isDemo ? 'Demo' : 'Admin';
            const role     = myPilot ? PILOT_ROLES[myPilot] : myViewer ? 'View only' : isDemo ? 'Demo preview' : 'All access · no identity set';

            // Mobile header avatar
            const av = document.getElementById('identity-avatar');
            const avInitials = document.getElementById('identity-avatar-initials');
            if (av) {
                av.style.background = color + '22';
                av.style.borderColor = color + '88';
                av.style.color = color;
            }
            if (avInitials) avInitials.textContent = initials;

            // Desktop sidebar
            const sidebarEl = document.getElementById('sidebar-identity');
            const sidebarAv = document.getElementById('sidebar-identity-avatar');
            const sidebarNm = document.getElementById('sidebar-identity-name');
            if (sidebarEl) sidebarEl.classList.remove('hidden');
            if (sidebarAv) { sidebarAv.textContent = initials; sidebarAv.style.background = color + '22'; sidebarAv.style.color = color; }
            if (sidebarNm) sidebarNm.textContent = myPilot ? PILOT_NAMES[myPilot].split(' ')[0] : myViewer ? myViewerName.split(' ')[0] : isDemo ? 'Demo' : 'Admin';

            // Profile sheet
            const pAv = document.getElementById('profile-avatar');
            if (pAv) { pAv.textContent = initials; pAv.style.background = color + '18'; pAv.style.borderColor = color + '66'; pAv.style.color = color; }
            const pNm = document.getElementById('profile-name');
            if (pNm) pNm.textContent = name;
            const pRl = document.getElementById('profile-role');
            if (pRl) pRl.textContent = role;

            const linkDisplay = document.getElementById('profile-link-display');
            const linkSection = document.getElementById('profile-link-section');
            if (myPilot || myViewer) {
                const _myLink = myToken ? `${location.origin}/app?u=${encodeURIComponent(myToken)}` : location.href;
                if (linkDisplay) linkDisplay.textContent = _myLink;
                if (linkSection) linkSection.classList.remove('hidden');
            } else {
                if (linkSection) linkSection.classList.add('hidden');
            }

            // A real pilot's crew-visibility control now lives inline in the Friends list instead
            // (see renderFriendsPanel()) -- this standalone section is only for admin/viewer/demo,
            // who have no Friends panel of their own to fold it into.
            const cvSection = document.getElementById('crew-visibility-section');
            if (cvSection) cvSection.classList.toggle('hidden', !!myPilot);

            // Self-service base/home/airline -- real pilots only. Admin edits anyone through the
            // admin panel; viewers and demo have no schedule-source profile to maintain.
            const myInfoSection = document.getElementById('my-info-section');
            if (myInfoSection) {
                myInfoSection.classList.toggle('hidden', !myPilot || isDemo);
                if (myPilot && !isDemo) _renderMyInfoSummary();
            }

            // Self-service Friends panel is real-pilots-only. Admin bypasses the friend
            // requirement entirely and sees everyone; viewers are friend-gated too now but
            // admin-assigned only, with no self-service UI of their own to manage it.
            const friendsSection = document.getElementById('friends-section');
            if (friendsSection) friendsSection.classList.toggle('hidden', !myPilot || isDemo);
            const signOutBtn = document.getElementById('sign-out-btn');
            if (signOutBtn) signOutBtn.classList.toggle('hidden', !myPilot && !myViewer);

            // Show manage-users button only for admin with a token (not viewer)
            const adminSection = document.getElementById('admin-manage-section');
            if (adminSection) adminSection.classList.toggle('hidden', !!myPilot || myViewer || !myToken);

            // Year in Review — hidden until year-end
            const wrappedSection = document.getElementById('wrapped-profile-section');
            if (wrappedSection) wrappedSection.classList.add('hidden');

            // Hide mobile upload nav button for viewers and demo
            const uploadNav = document.getElementById('btn-upload-nav');
            if (uploadNav) uploadNav.classList.toggle('hidden', myViewer || isDemo);
            if (isDemo) document.getElementById('sidebar-upload-section')?.classList.add('hidden');

            // Upload nav label: sync pilots get "Sync", others get "Upload"
            // (updateUploadSyncButtons re-evaluates this once pilotsCache is warm)
            const myParser    = pilotsCache[myPilot]?.parser_type || '';
            const isSyncPilot = myParser === 'schedaero' || myParser.startsWith('ics');
            const uploadLabel = document.getElementById('mbtn-upload-label');
            if (uploadLabel) uploadLabel.textContent = isSyncPilot ? 'Sync' : 'Upload';

            // Desktop sidebar: hide pilot selector row for identified pilots
            const uploadForRow = document.getElementById('upload-for-row');
            if (uploadForRow) uploadForRow.classList.toggle('hidden', !!myPilot);

            _buildCrewVisibilityUI();
            renderFriendsPanel();
        }

        // Renders into #crew-visibility-section, which is only visible for admin/viewer/demo now
        // (see _applyIdentityUI()'s own comment) -- a real pilot's equivalent toggle lives inline
        // in renderFriendsPanel() instead, since for them this candidate list and the friends list
        // are the exact same set of people. Still called unconditionally alongside
        // renderFriendsPanel() for simplicity; it just renders into a hidden section for a pilot.
        function _buildCrewVisibilityUI() {
            const el = document.getElementById('crew-visibility-btns');
            if (!el) return;
            const visible = getCrewVisible();
            const candidates = visiblePilotKeys().filter(p => p !== myPilot);
            if (candidates.length === 0 && (myPilot || myViewer)) {
                // Viewers have no self-service Friends section (admin-assigned only), so point
                // them at the right place instead of the pilot-facing "add some" copy below.
                const msg = myViewer
                    ? 'No pilots shared with you yet — ask your admin to grant access.'
                    : 'No friends yet — add some from the Friends section above to see them here.';
                el.innerHTML = `<p class="text-xs text-zinc-500 px-1 py-2">${msg}</p>`;
                return;
            }
            el.innerHTML = candidates.map(p => {
                const c    = PILOT_COLORS[p] || '#6366f1';
                const on   = visible.includes(p);
                const name = PILOT_NAMES[p] || p; // defensive: a friend not yet roster-synced shouldn't crash the whole profile sheet
                return `<label class="flex items-center justify-between py-2.5 px-3 rounded-xl cursor-pointer transition-colors ${on ? '' : 'opacity-50'}" style="background:${on ? c+'14' : 'transparent'};border:1px solid ${on ? c+'50' : '#3f3f46'}">
                    <div class="flex items-center gap-2.5">
                        <div class="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black" style="background:${c}22;color:${c}">${name[0]}</div>
                        <span class="text-sm font-black text-white">${shortName(name)}</span>
                    </div>
                    <div onclick="setCrewVisible('${p}', ${!on})" class="w-11 h-6 rounded-full flex items-center transition-all cursor-pointer px-0.5 ${on ? '' : ''}" style="background:${on ? c+'cc' : '#3f3f46'}">
                        <div class="w-5 h-5 rounded-full bg-white shadow transition-transform" style="transform:translateX(${on ? '20px' : '0px'})"></div>
                    </div>
                </label>`;
            }).join('');
        }

        function _updateMyRoutesLabel() {
            const firstName = (PILOT_NAMES[currentPilot] || currentPilot).split(' ')[0];
            const label = (currentPilot === myPilot) ? 'My Routes' : `${firstName}'s Routes`;
            const d = document.getElementById('mapmode-mine-label');
            const m = document.getElementById('mapmode-bar-mine-label');
            if (d) d.textContent = label;
            if (m) m.textContent = label;
        }

        function _applyPilotPillVisibility() {
            const visible = getCrewVisible();
            VALID_PILOTS.forEach(p => {
                const pill = document.getElementById(`mpilot-${p}`);
                if (pill) pill.style.display = visible.includes(p) ? '' : 'none';
                // Desktop sidebar pilot buttons
                const deskBtn = document.getElementById(`pilot-${p}`);
                if (deskBtn) deskBtn.style.display = visible.includes(p) ? '' : 'none';
            });
        }

        function _applyPillIdentity() {
            // Mark the "you" pilot pill with a subtle tint (separate from active-viewing style)
            VALID_PILOTS.forEach(p => {
                const pill = document.getElementById(`mpilot-${p}`);
                if (!pill) return;
                if (p === myPilot && p !== currentPilot) {
                    const c = PILOT_COLORS[p];
                    pill.style.borderColor = c + '70';
                    pill.style.color = c;
                    pill.style.background = c + '12';
                }
            });
        }

        let _profileSwipeSetup = false;
        let _dayDetailSwipeSetup = false;
        let _uploadSheetSwipeSetup = false;
        function openProfile() {
            haptic('tap');
            _applyIdentityUI();
            _refreshNotifProfileRow();
            _refreshBlockProfileRow();
            document.getElementById('profile-sheet').classList.remove('hidden');
            if (!_profileSwipeSetup) {
                const panel = document.querySelector('#profile-sheet > div:not(.absolute)');
                if (panel) { setupSheetSwipe(panel, closeProfile); _profileSwipeSetup = true; }
            }
        }

        function _refreshNotifProfileRow() {
            const section = document.getElementById('profile-notif-section');
            const btn = document.getElementById('profile-notif-btn');
            const sub = document.getElementById('profile-notif-sub');
            if (!section || !btn || !myPilot || isDemo || !PUSH_ENABLED) return;
            section.classList.remove('hidden');
            const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
            if (perm === 'granted') {
                btn.textContent = 'On';
                btn.className = 'px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wide transition-colors bg-blue-600/20 text-blue-400 border border-blue-800/50 hover:bg-red-900/30 hover:text-red-400 hover:border-red-800/50';
                sub.textContent = 'Tap to disable on this device';
            } else if (perm === 'denied') {
                btn.textContent = 'Blocked';
                btn.className = 'px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wide bg-zinc-700/40 text-zinc-500 border border-zinc-700 cursor-default';
                sub.textContent = 'Enable in your browser / device settings';
            } else if (perm === 'unsupported') {
                btn.textContent = 'N/A';
                btn.className = 'px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wide bg-zinc-700/40 text-zinc-500 border border-zinc-700 cursor-default';
                sub.textContent = 'Not supported on this browser';
            } else {
                btn.textContent = 'Enable';
                btn.className = 'px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wide transition-colors bg-amber-600/20 text-amber-400 border border-amber-800/50 hover:bg-amber-600/40';
                sub.textContent = 'Get notified when you have a crossing';
            }
        }

        async function toggleNotifSetting() {
            const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
            if (perm === 'denied' || perm === 'unsupported') return;
            if (perm === 'granted') {
                // Unsubscribe
                if (_swRegistration) {
                    const sub = await _swRegistration.pushManager.getSubscription();
                    if (sub) {
                        await fetch('/api/push/subscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
                        await sub.unsubscribe();
                    }
                }
                localStorage.removeItem('notif_prompt_dismissed');
            } else {
                // Enable — re-enable prompt and trigger permission request
                localStorage.removeItem('notif_prompt_dismissed');
                await requestNotifPermission();
            }
            _refreshNotifProfileRow();
        }
        function closeProfile() {
            document.getElementById('profile-sheet').classList.add('hidden');
        }

        function signOut() {
            localStorage.removeItem('crewsync_token');
            window.location.href = '/';
        }

        // Sidebar + mobile strip widget: shows signed-in pilot's next upcoming flight
        let _nextFlightDate = null; // UTC date of next flight — used by _jumpToNextFlight
        let _nextFlightDismissed = false;
        function _updateNextTripWidget(pilot, segs) {
            const el   = document.getElementById('sidebar-next-trip');
            const mob  = document.getElementById('mobile-next-trip');
            const hide = () => { el?.classList.add('hidden'); mob?.classList.add('hidden'); _nextFlightDate = null; };
            // Only show when the signed-in pilot is viewing their own schedule
            if (!myPilot || pilot !== myPilot) { hide(); return; }
            const now = new Date();
            const next = segs
                .filter(s => s.type === 'flight' && s.departureTime && !s.cancelled && new Date(s.departureTime) > now)
                .sort((a, b) => (flightUTCTime(a.departureTime, a.departureAirport) || new Date(a.departureTime)) - (flightUTCTime(b.departureTime, b.departureAirport) || new Date(b.departureTime)))[0];
            if (!next) { hide(); return; }
            _nextFlightDate = new Date(next.departureTime);
            const dep  = _nextFlightDate;
            const isToday    = dep.toDateString() === now.toDateString();
            const isTomorrow = dep.toDateString() === new Date(now.getTime() + 86400000).toDateString();
            const dayLabel   = isToday ? 'Today' : isTomorrow ? 'Tomorrow'
                : dep.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const color = PILOT_COLORS[myPilot] || '#6366f1';
            // Desktop sidebar
            if (el) {
                el.classList.remove('hidden');
                el.innerHTML = `<div class="rounded-xl px-3 py-2.5" style="background:${color}12;border:1px solid ${color}28">
                    <div class="text-[9px] font-black uppercase tracking-widest mb-1" style="color:${color}99">Your Next Flight</div>
                    <div class="flex items-baseline gap-1.5">
                        <span class="text-sm font-black text-white">${aptLabel(next.departureAirport, pilot)} → ${aptLabel(next.arrivalAirport, pilot)}</span>
                    </div>
                    <div class="text-[10px] mt-0.5" style="color:${color}cc">${dayLabel}</div>
                </div>`;
            }
            // Mobile strip
            if (mob) {
                const timeStr = next.departureTime
                    ? formatTimeISO(next.departureTime, next.departureAirport) : '';
                const tzStr = next.departureAirport && next.departureTime
                    ? tzAbbr(next.departureAirport, next.departureTime) : '';
                mob.style.background = `${color}0d`;
                mob.innerHTML = `<div class="flex items-center gap-3 px-4 py-3" style="border-left:3px solid ${color}50">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="color:${color};opacity:0.7;flex-shrink:0"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>
                    <div class="flex flex-col min-w-0">
                        <span class="text-[8px] font-black uppercase tracking-widest leading-tight" style="color:${color};opacity:0.6">Next Flight</span>
                        <span class="text-xs font-black text-white leading-tight">${aptLabel(next.departureAirport, pilot)} → ${aptLabel(next.arrivalAirport, pilot)}</span>
                        <span class="text-[10px] leading-tight" style="color:${color};opacity:0.8">${dayLabel}${timeStr ? ' · ' + timeStr + (tzStr ? ' ' + tzStr : '') : ''}</span>
                    </div>
                </div>`;
                mob.classList.toggle('hidden', currentView !== 'grid' || _nextFlightDismissed);
            }
        }

        function _dismissNextFlight() {
            _nextFlightDismissed = true;
            document.getElementById('mobile-next-trip')?.classList.add('hidden');
        }

        function _jumpToNextFlight() {
            if (!_nextFlightDate || !myPilot) return;
            viewDate = new Date(_nextFlightDate.getFullYear(), _nextFlightDate.getMonth(), 1);
            if (currentPilot !== myPilot) { loadPilot(myPilot); return; } // loadPilot calls render()
            switchView('grid');
            render();
        }

        // canEdit: gates all add/edit/delete/upload UI.
        // Admin (myPilot=null) can edit anyone. Signed-in pilots can only edit
        // their own schedule. Demo always returns false.
        function canEdit() {
            if (isDemo || myViewer) return false;
            return !myPilot || myPilot === currentPilot;
        }

        // Show/hide add-flight controls based on identity vs. currently viewed pilot
        function _applyEditPermissions() {
            const ok = canEdit();
            const btnD = document.getElementById('btn-add-flight-desktop');
            const btnM = document.getElementById('btn-add-flight-mobile');
            if (btnD) btnD.classList.toggle('hidden', !ok);
            if (btnM) btnM.classList.toggle('hidden', !ok);
            // Hide entire desktop sidebar upload section for viewers
            document.getElementById('sidebar-upload-section')?.classList.toggle('hidden', myViewer);
            // Lock desktop upload select to myPilot when identified; hide it for signed-in pilots
            const desktopSelect = document.getElementById('upload-pilot-select');
            document.getElementById('upload-for-row')?.classList.toggle('hidden', !!myPilot || myViewer);
            if (desktopSelect && myPilot) {
                desktopSelect.value = myPilot;
                desktopSelect.disabled = true;
                updateUploadSyncButtons(myPilot);
            } else if (desktopSelect) {
                desktopSelect.disabled = false;
            }
        }

        // Open the upload sheet, restricting pilot select to myPilot when identified
        function openMobileUpload() {
            if (_isDemo || myViewer) return;
            const parser = pilotsCache[myPilot]?.parser_type || '';
            if (parser === 'schedaero')          return quickSyncSchedaero();
            if (parser.startsWith('ics'))        return openGenericICSSync(myPilot);
            openUploadSheet();
        }

        function openUploadSheet() {
            const p = myPilot || currentPilot || 'kyle';
            // Hide pilot selector for identified pilots — they only upload for themselves
            const pilotRow = document.getElementById('mobile-upload-pilot-row');
            if (pilotRow) pilotRow.classList.toggle('hidden', !!myPilot);
            const mobileSelect = document.getElementById('mobile-upload-pilot-select');
            if (mobileSelect) {
                mobileSelect.value = p;
                mobileSelect.disabled = !!myPilot;
            }
            updateUploadSyncButtons(p);
            document.getElementById('mobile-upload-sheet').classList.remove('hidden');
            if (!_uploadSheetSwipeSetup) {
                const panel = document.querySelector('#mobile-upload-sheet > div:not(.absolute)');
                if (panel) { setupSheetSwipe(panel, () => document.getElementById('mobile-upload-sheet').classList.add('hidden')); _uploadSheetSwipeSetup = true; }
            }
        }

        async function copyText(text) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                // Fallback for HTTP (no secure context)
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                return ok;
            }
        }

        async function copyMyLink() {
            if (!myPilot && !myViewer) return;
            const link = myToken ? `${location.origin}/app?u=${encodeURIComponent(myToken)}` : location.href;
            const ok = await copyText(link);
            haptic('success');
            showToast(ok ? 'Link copied!' : 'Copy failed — select the text manually', ok ? 'success' : 'error', 2000);
        }
        let isLoading = false;

        function triggerUpload(selectId, inputId) {
            if (_isDemo) return;
            const pilot = document.getElementById(selectId).value;
            const input = document.getElementById(inputId);
            const parser = pilotsCache[pilot]?.parser_type || '';
            input.accept = (parser === 'csv_skywest' || parser === 'vcs_skywest') ? '.csv,.vcs'
                : parser === 'manual_netjets' ? '.pdf,.txt'
                : '.ics,.csv';
            input.click();
        }
        const overlapRadiusMi = 50;

