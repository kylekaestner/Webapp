        // ── Identity system ───────────────────────────────────────────────
        // Execution order at startup:
        //   initIdentity() -> _syncPilotRoster() -> loadPilot(defaultPilot)
        // initIdentity() sets myPilot / myToken / isDemo, calls _syncPilotRoster() to load the
        // entire pilot roster (including the signed-in pilot) from the DB, and applies all
        // identity-driven UI (avatar, upload locks, add-flight gate).
        let myPilot      = null;  // who you ARE (null = admin or viewer)
        let myToken      = null;  // token from URL -- kept for personal link copy
        let isDemo       = false; // read-only demo mode (/demo route)
        let myViewer     = false; // true when authenticated as a view-only guest
        let myViewerKey  = null;  // pilot_key in DB for the viewer (used as localStorage key)
        let myViewerName = null;  // display name for the viewer
        let myViewerOwner = null; // the pilot whose share link this viewer is (can't be unfriended)

        async function initIdentity() {
            const params   = new URLSearchParams(window.location.search);
            const urlToken = params.get('u');

            isDemo = window.location.pathname === '/demo';

            // iOS PWA strips query params from the home screen shortcut URL.
            // Fall back to a token saved in localStorage on the pilot's last real visit.
            const token = urlToken || (!isDemo && localStorage.getItem('crewsync_token')) || null;

            if (token) {
                // A network blip resolving the token used to silently fall through with
                // myPilot/myToken left at their initial null values -- which is exactly the
                // state this app treats as ADMIN everywhere else (visiblePilotKeys(),
                // _applyIdentityUI(), the admin-panel visibility check, all branch on plain
                // `myPilot === null`). Confirmed live: a lagged connection on a real pilot's own
                // login showed the admin UI (sees-everyone pill bar, Admin Panel button) instead
                // of their own identity, with no actual admin token ever presented. Retry a
                // couple of times first (this is specifically a transient-lag scenario, not
                // necessarily a dead token), and if it still can't be resolved, stop and show an
                // explicit error instead of ever proceeding with an unresolved identity.
                let data = null, ok = false, networkFailed = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
                    try {
                        const resp = await fetch(`/api/pilots/by-token/${encodeURIComponent(token)}`);
                        if (resp.ok) { data = await resp.json(); ok = true; networkFailed = false; break; }
                        if (resp.status >= 400 && resp.status < 500) { ok = false; networkFailed = false; break; } // invalid token -- retrying won't help
                        networkFailed = true; // 5xx -- worth retrying
                    } catch { networkFailed = true; }
                }
                if (ok) {
                    myToken = token;
                    // Persist so home-screen PWA launches work without the ?u= param
                    localStorage.setItem('crewsync_token', token);
                    if (data.pilotKey === 'admin') {
                        // Admin token → full access, no crew identity
                        myPilot = null;
                    } else if (data.isViewer) {
                        myPilot      = null;
                        myViewer     = true;
                        myViewerKey  = data.pilotKey;
                        myViewerName = data.name || 'Viewer';
                        myViewerOwner = data.sharedBy || null;
                        PILOT_NAMES[myViewerKey] = myViewerName;
                    } else {
                        myPilot = data.pilotKey;
                    }
                    // Pilot registration into PILOT_KEYS/NAMES/HOME/ROLES/COLORS (and the
                    // matching pill-bar/sidebar DOM buttons) happens uniformly for every
                    // pilot, including this one, via _syncPilotRoster() right below --
                    // there's no separate hardcoded-vs-dynamic distinction anymore.
                } else if (networkFailed) {
                    _showIdentityError();
                    return false; // tells the DOMContentLoaded handler to stop the rest of startup too
                } else {
                    // Invalid token (4xx, not a network issue) — clear stored token so we don't loop
                    localStorage.removeItem('crewsync_token');
                    window.location.replace('/');
                    return;
                }
            } else if (!isDemo) {
                // No token anywhere — redirect to landing
                window.location.replace('/');
                return;
            }

            // Demo banner
            const banner = document.getElementById('demo-banner');
            if (banner) banner.classList.toggle('hidden', !isDemo);

            // Roster must be synced BEFORE building any friend-based UI below: PILOT_KEYS/
            // PILOT_NAMES start empty, and a friend's name isn't registered until this runs.
            // _buildCrewVisibilityUI() indexes PILOT_NAMES[friendKey] directly with a fallback to
            // the raw key now (see its own comment) -- but historically had no fallback at all,
            // so calling this out of order once threw and aborted the rest of this function (and
            // the whole DOMContentLoaded handler after it), which silently broke both schedule
            // auto-select and the profile sheet for the affected pilot. Keep this ordering.
            if (!isDemo) await _syncPilotRoster();

            // Friends must be loaded (and, for a first-time pilot, seeded from their existing
            // "Your Crew" toggle) before _applyIdentityUI() builds the crew-visibility UI below
            // it, since that UI is now bounded by friendship.
            await loadFriends();
            updateFriendRequestBadge();
            await _maybeSeedFriends();
            await loadCrewVisibility();

            _applyIdentityUI();
            _applyPilotPillVisibility();
            _reorderPilotPills();
            _applyEditPermissions();
        }

        // Move myPilot's pill to the front of both pill bars
        function _reorderPilotPills() {
            if (!myPilot) return;
            const mobileBar = document.getElementById('mobile-pilot-bar');
            const myMobile  = document.getElementById(`mpilot-${myPilot}`);
            if (mobileBar && myMobile) mobileBar.prepend(myMobile);

            const sidebarList = document.getElementById('sidebar-pilot-list');
            const myDesk      = document.getElementById(`pilot-${myPilot}`);
            // prepend after the label (first child is the <p> label)
            if (sidebarList && myDesk) {
                const label = sidebarList.querySelector('p');
                if (label) label.after(myDesk);
                else sidebarList.prepend(myDesk);
            }
        }

