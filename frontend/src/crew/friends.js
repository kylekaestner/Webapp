        // ── Friends ──────────────────────────────────────────────────────────
        // Replaces "everyone sees everyone": a real pilot can only fetch another pilot's
        // schedule once an accepted friend_requests row exists between them (enforced
        // server-side in GET /api/pilots/:key). Admin and view-only guests are unaffected —
        // they still see every pilot, same as before this system existed.
        let myFriends = [];           // [{pilotKey, name, since}] — accepted only
        let myIncomingRequests = [];  // requests sent TO me, awaiting my accept/decline
        let myOutgoingRequests = [];  // requests I sent, awaiting their accept
        let _viewOnlyFriendsExpanded = false; // collapsed by default in renderFriendsPanel()

        // The set of pilot keys the current identity is actually allowed to fetch. Every
        // place that used to loop over all PILOT_KEYS (crossings, off days, the calendar's
        // background prefetch) needs to loop over this instead, or it'll just collect 403s.
        function visiblePilotKeys() {
            if (myPilot === null && !myViewer) return [...PILOT_KEYS]; // admin only — sees everyone unconditionally
            if (myViewer) return myFriends.map(f => f.pilotKey); // viewer — gated by admin-assigned friends only, no self
            // Excludes friended viewers (isViewer) -- a real pilot's friend list can legitimately
            // include a viewer (friendship is symmetric), but viewers are never registered into
            // PILOT_NAMES/PILOT_COLORS, so including one here would render as a nameless/colorless
            // blank everywhere this feeds (map legend, crew-visibility toggles, pill bar, crossings/
            // off-days prefetch). The Friends panel itself reads myFriends directly, unfiltered, so
            // a friended viewer still shows there -- just labeled, not silently dropped.
            return [myPilot, ...myFriends.filter(f => !f.isViewer).map(f => f.pilotKey)];
        }

        function _pilotFetchUrl(key) {
            return `${API_BASE}/pilots/${key}${myToken ? '?token=' + encodeURIComponent(myToken) : ''}`;
        }

        // One request per pilot at a time. The grid, Crossings, Off Days and the maps all load the same
        // pilots at startup, and each used to download everyone separately. Rejects if the fetch fails.
        function _loadPilotOnce(key) {
            if (pilotsCache[key]) return Promise.resolve(pilotsCache[key]);
            if (_pilotLoads.has(key)) return _pilotLoads.get(key);
            const load = fetch(_pilotFetchUrl(key))
                .then(r => r.json())
                .then(d => { if (!pilotsCache[key]) pilotsCache[key] = d; return pilotsCache[key]; })
                .finally(() => _pilotLoads.delete(key));
            _pilotLoads.set(key, load);
            return load;
        }

        async function loadFriends() {
            if ((!myPilot && !myViewer) || isDemo) { myFriends = []; myIncomingRequests = []; myOutgoingRequests = []; return; }
            try {
                const data = await fetch(`/api/friends?token=${encodeURIComponent(myToken)}`).then(r => r.json());
                myFriends = data.friends || [];
                myIncomingRequests = data.incoming || [];
                myOutgoingRequests = data.outgoing || [];
            } catch { /* leave whatever we had */ }
        }

        // One-time import of this pilot's pre-existing "Your Crew" toggle (below) as their
        // starting friend list — see POST /api/friends/seed. Safe to call on every load; the
        // server only actually seeds once per pilot (pilots.friends_seeded).
        //
        // Reads the RAW localStorage value directly rather than calling getCrewVisible() --
        // that function now filters its result down to visiblePilotKeys() (self + friends),
        // which at seed time is just [self], since there are no friends yet. Calling it here
        // would clamp away the very preference this is supposed to import.
        async function _maybeSeedFriends() {
            if (!myPilot || isDemo) return;
            let current = [];
            try {
                const stored = localStorage.getItem(_visKey());
                if (stored) current = JSON.parse(stored).filter(p => p !== myPilot && VALID_PILOTS.includes(p));
            } catch { /* no stored preference yet -- nothing to seed */ }
            try {
                const result = await fetch('/api/friends/seed', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, keys: current })
                }).then(r => r.json());
                if (result.seeded) await loadFriends();
            } catch { /* not critical — they can always add friends manually */ }
        }

        async function sendFriendRequest(targetKey, btnEl) {
            if (!myToken || isDemo) return;
            if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Sending…'; }
            try {
                const resp = await fetch('/api/friends/request', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, targetKey })
                });
                const result = await resp.json();
                if (result.success) {
                    await loadFriends();
                    if (result.status === 'accepted') {
                        showToast(`You and ${PILOT_NAMES[targetKey] || targetKey} are now friends!`);
                        if (currentPilot === targetKey) loadPilot(targetKey);
                    } else {
                        showToast('Friend request sent');
                        if (btnEl) btnEl.textContent = '✓ Request Sent';
                    }
                    _refreshFriendUI();
                } else {
                    showToast(result.error || 'Failed to send request', 'error');
                    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '+ Send Friend Request'; }
                }
            } catch {
                showToast('Failed to send request', 'error');
                if (btnEl) { btnEl.disabled = false; btnEl.textContent = '+ Send Friend Request'; }
            }
        }

        async function respondFriendRequest(requesterKey, accept) {
            if (!myToken) return;
            try {
                const result = await fetch('/api/friends/respond', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, requesterKey, accept })
                }).then(r => r.json());
                if (result.success) {
                    showToast(accept ? `You and ${PILOT_NAMES[requesterKey] || requesterKey} are now friends!` : 'Request declined');
                    await loadFriends();
                    _refreshFriendUI();
                    _buildCrewVisibilityUI();
                }
            } catch { showToast('Something went wrong', 'error'); }
        }

        async function removeFriend(targetKey) {
            if (!myToken) return;
            try {
                const result = await fetch(`/api/friends/${encodeURIComponent(targetKey)}`, {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken })
                }).then(r => r.json());
                if (result.success) {
                    showToast(`Removed ${PILOT_NAMES[targetKey] || targetKey} as a friend`);
                    await loadFriends();
                    setCrewVisible(targetKey, false);
                    _refreshFriendUI();
                }
            } catch { showToast('Something went wrong', 'error'); }
        }

        // Refreshes both the Profile sheet's friends list and the add-friend search results
        // (if that modal happens to be open) after any state change — request, accept, decline,
        // remove. Cheap to call unconditionally since both checks are no-ops when not rendered.
        function _refreshFriendUI() {
            if (typeof renderFriendsPanel === 'function') renderFriendsPanel();
            const modal = document.getElementById('add-friend-modal');
            if (modal && !modal.classList.contains('hidden')) {
                renderFriendSearchResults(document.getElementById('friend-search-input')?.value || '');
            }
            updateFriendRequestBadge();
        }

        // Small badge on the profile avatar (desktop sidebar + mobile header) showing the count
        // of incoming friend requests awaiting a response -- same visual treatment as the
        // crossings nav badge (updateCrossingAlert), so a pending request is visible without
        // having to open the Profile sheet to discover it.
        function updateFriendRequestBadge() {
            const count = myIncomingRequests.length;
            ['friend-badge-mobile', 'friend-badge-desktop'].forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.classList.toggle('hidden', count === 0);
                el.textContent = count > 9 ? '9+' : (count > 0 ? String(count) : '');
            });
        }

        async function confirmRemoveFriend(targetKey, name) {
            const ok = await showConfirm('Remove Friend?', `You and ${name || targetKey} will no longer be able to see each other's schedules.`, { label: 'Remove', danger: true });
            if (ok) removeFriend(targetKey);
        }

        function _toggleViewOnlyFriends() {
            _viewOnlyFriendsExpanded = !_viewOnlyFriendsExpanded;
            renderFriendsPanel();
        }

        // Renders the friends list + any pending incoming/outgoing requests in the Profile
        // sheet. Called after loadFriends() resolves and after any accept/decline/remove action.
        function renderFriendsPanel() {
            if (_shareLinks === null && myPilot) loadShareLinks();
            const incomingEl = document.getElementById('friends-incoming-section');
            const listEl = document.getElementById('friends-list');
            if (!listEl) return;

            if (incomingEl) {
                if (!myIncomingRequests.length) {
                    incomingEl.classList.add('hidden');
                    incomingEl.innerHTML = '';
                } else {
                    incomingEl.classList.remove('hidden');
                    incomingEl.innerHTML = `<p class="text-[9px] font-black text-amber-400 uppercase tracking-widest mb-1">Requests</p>` +
                        myIncomingRequests.map(r => `
                            <div class="flex items-center justify-between py-2 px-3 rounded-xl bg-amber-950/20 border border-amber-800/40">
                                <span class="text-xs font-black text-white">${escapeHtml(r.name || r.pilotKey)}${r.isViewer ? ` <span class="text-[9px] font-black text-zinc-500 uppercase tracking-widest ml-1">View only</span>` : ''}</span>
                                <div class="flex gap-1.5">
                                    <button onclick="respondFriendRequest('${r.pilotKey}', true)" class="px-2.5 py-1 bg-green-600 hover:bg-green-500 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-colors">Accept</button>
                                    <button onclick="respondFriendRequest('${r.pilotKey}', false)" class="px-2.5 py-1 border border-zinc-600 text-zinc-400 hover:text-red-400 hover:border-red-800 rounded-lg text-[9px] font-black uppercase tracking-widest transition-colors">Decline</button>
                                </div>
                            </div>
                        `).join('');
                }
            }

            if (myViewer && !myFriends.length && !myOutgoingRequests.length) { listEl.innerHTML = ''; return; }
            if (!myFriends.length && !myOutgoingRequests.length) {
                listEl.innerHTML = `<p class="text-xs text-zinc-500 py-1.5">No friends yet — tap + Add to send a request.</p>`;
                return;
            }
            // Visibility (show/hide in calendar/map) folds into this same list instead of a
            // separate "Your Crew" section repeating the same names -- getCrewVisible() only
            // applies to real pilots (viewers have no schedule to show/hide in the first place,
            // see visiblePilotKeys()'s own comment), so the toggle is simply omitted for one.
            const visible = getCrewVisible();
            // Viewers are never registered into PILOT_COLORS (see visiblePilotKeys()'s own
            // comment), so PILOT_COLORS[f.pilotKey] would always fall through to the generic
            // indigo default for one anyway -- use the same 👁 treatment as the crew-roster page's
            // viewer avatars instead of a blank/default initial, plus a clear label so it reads as
            // "this is a guest, not a crewmate" rather than looking unfinished.
            const _friendRowHtml = f => {
                const c = f.isViewer ? '#52525b' : (PILOT_COLORS[f.pilotKey] || '#6366f1');
                const avatarChar = f.isViewer ? '👁' : (f.name || f.pilotKey)[0].toUpperCase();
                const on = visible.includes(f.pilotKey);
                const visToggle = f.isViewer ? '' : `<div onclick="setCrewVisible('${f.pilotKey}', ${!on})" title="${on ? 'Hide from your calendar/map' : 'Show in your calendar/map'}" class="w-9 h-5 rounded-full flex items-center transition-all cursor-pointer px-0.5 shrink-0" style="background:${on ? c+'cc' : '#3f3f46'}">
                        <div class="w-4 h-4 rounded-full bg-white shadow transition-transform" style="transform:translateX(${on ? '16px' : '0px'})"></div>
                    </div>`;
                return `<div class="flex items-center justify-between py-2.5 px-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <div class="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-black shrink-0" style="background:${c}22;color:${c}">${avatarChar}</div>
                        <span class="text-sm font-black text-white truncate">${escapeHtml(f.name || f.pilotKey)}</span>
                    </div>
                    <div class="flex items-center gap-2.5 shrink-0 ml-2">
                        ${visToggle}
                        ${f.pilotKey === myViewerOwner ? '' : `<button onclick="confirmRemoveFriend('${f.pilotKey}', '${escapeHtml(f.name || f.pilotKey)}')" class="text-[9px] font-black text-zinc-600 hover:text-red-400 uppercase tracking-widest">Remove</button>`}
                    </div>
                </div>`;
            };
            // Real-pilot friends render directly; view-only friends collapse under their own
            // header instead of just sorting to the bottom, so a pilot with several admin-granted
            // viewers doesn't have to scroll past all of them to see their actual crew.
            const realFriends = myFriends.filter(f => !f.isViewer);
            // Your own share links have their own section below, with Copy and Revoke.
            const viewerFriends = myFriends.filter(f => f.isViewer && f.sharedBy !== myPilot);
            const friendRows = realFriends.map(_friendRowHtml).join('');
            const viewerSection = viewerFriends.length === 0 ? '' : `
                <button onclick="_toggleViewOnlyFriends()" class="flex items-center gap-1.5 w-full py-2 px-1 text-left">
                    <svg class="w-2.5 h-2.5 text-zinc-500 transition-transform shrink-0" style="transform:rotate(${_viewOnlyFriendsExpanded ? '90deg' : '0deg'})" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>
                    <span class="text-[9px] font-black text-zinc-500 uppercase tracking-widest">View Only · ${viewerFriends.length}</span>
                </button>
                ${_viewOnlyFriendsExpanded ? `<div class="space-y-2 mb-2">${viewerFriends.map(_friendRowHtml).join('')}</div>` : ''}`;
            const outgoingRows = myOutgoingRequests.map(r => `
                <div class="flex items-center justify-between py-2.5 px-3 rounded-xl bg-zinc-900/40 border border-zinc-800">
                    <span class="text-sm font-bold text-zinc-400">${escapeHtml(r.name || r.pilotKey)}</span>
                    <span class="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Pending</span>
                </div>`).join('');
            listEl.innerHTML = friendRows + viewerSection + outgoingRows;
        }

        // ── Share links (Profile → Share My Schedule) ─────────────────────────
        let _shareLinks = null;
        async function loadShareLinks() {
            if (!myPilot || !myToken || isDemo) return;
            try {
                const r = await fetch(`/api/share-links?token=${encodeURIComponent(myToken)}`);
                if (r.ok) _shareLinks = await r.json();
            } catch { /* keep what we had */ }
            renderShareLinks();
        }
        function renderShareLinks() {
            const el = document.getElementById('share-links-list');
            if (!el) return;
            if (_shareLinks === null) { el.innerHTML = ''; return; }
            if (!_shareLinks.length) { el.innerHTML = `<p class="text-xs text-zinc-500 py-1">No share links yet.</p>`; return; }
            el.innerHTML = _shareLinks.map(l => `<div class="flex items-center justify-between py-2 px-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50">
                    <div class="min-w-0">
                        <div class="text-sm font-black text-white truncate">${escapeHtml(l.name)}</div>
                        <div class="text-[10px] text-zinc-500">${l.lastActive ? 'Last opened ' + new Date(l.lastActive).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Not opened yet'}</div>
                    </div>
                    <div class="flex items-center gap-3 shrink-0 ml-2">
                        <button onclick="copyShareLink('${l.pilotKey}')" class="text-[9px] font-black text-blue-400 hover:text-blue-300 uppercase tracking-widest">Copy</button>
                        <button onclick="revokeShareLink('${l.pilotKey}')" class="text-[9px] font-black text-zinc-600 hover:text-red-400 uppercase tracking-widest">Revoke</button>
                    </div>
                </div>`).join('');
        }
        async function createShareLink() {
            const firstEl = document.getElementById('share-link-first'), relEl = document.getElementById('share-link-rel'), btn = document.getElementById('share-link-create-btn');
            const firstName = firstEl.value.trim(), relationship = relEl.value.trim();
            if (!firstName) { firstEl.focus(); return; }
            if (!relationship) { relEl.focus(); return; }
            btn.disabled = true;
            try {
                const r = await fetch('/api/share-links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: myToken, firstName, relationship }) });
                const data = await r.json();
                if (!r.ok) { showToast(data.error || 'Could not create the link', 'error'); return; }
                firstEl.value = ''; relEl.value = '';
                _shareLinks = [...(_shareLinks || []), data].sort((a, b) => a.name.localeCompare(b.name));
                renderShareLinks();
                const ok = await copyText(location.origin + data.link);
                haptic('success');
                showToast(ok ? `Link for ${data.name} copied. Text it to them.` : 'Link created. Tap Copy to copy it.', 'success', 3000);
                await loadFriends();
            } catch { showToast('Something went wrong', 'error'); }
            finally { btn.disabled = false; }
        }
        async function copyShareLink(key) {
            const l = (_shareLinks || []).find(x => x.pilotKey === key);
            if (!l) return;
            const ok = await copyText(location.origin + l.link);
            haptic('success');
            showToast(ok ? `Link for ${l.name} copied` : 'Copy failed', ok ? 'success' : 'error', 2000);
        }
        async function revokeShareLink(key) {
            const l = (_shareLinks || []).find(x => x.pilotKey === key);
            if (!l) return;
            const ok = await showConfirm(`Revoke ${l.name}'s link?`, 'It stops working right away. You can make a new one later.', { label: 'Revoke', danger: true });
            if (!ok) return;
            try {
                const r = await fetch(`/api/share-links/${encodeURIComponent(key)}?token=${encodeURIComponent(myToken)}`, { method: 'DELETE' });
                if (!r.ok) { showToast('Could not revoke it', 'error'); return; }
                _shareLinks = _shareLinks.filter(x => x.pilotKey !== key);
                renderShareLinks();
                showToast(`${l.name}'s link revoked`);
                await loadFriends();
                renderFriendsPanel();
            } catch { showToast('Something went wrong', 'error'); }
        }

        // ── Add Friend modal: search the non-sensitive pilot directory ─────────
        let _friendDirectory = null; // lazy-loaded, [{pilot_key, name, ...}]

        async function openAddFriendModal() {
            document.getElementById('add-friend-modal').classList.remove('hidden');
            document.getElementById('friend-search-input').value = '';
            document.getElementById('friend-search-input').placeholder = myViewer ? 'First and last name…' : 'Search by name…';
            document.getElementById('friend-search-input').focus();
            if (myViewer) { _friendDirectory = []; renderFriendSearchResults(''); return; }
            if (!_friendDirectory) {
                try {
                    _friendDirectory = await fetch(`/api/pilots-directory?token=${encodeURIComponent(myToken)}`).then(r => r.json());
                } catch { _friendDirectory = []; }
            }
            renderFriendSearchResults('');
        }
        function closeAddFriendModal() {
            document.getElementById('add-friend-modal').classList.add('hidden');
        }
        // A viewer can't browse the crew: an exact first and last name is looked up instead.
        let _viewerLookupTimer = null, _viewerLookupQuery = null;
        function _viewerLookup(query) {
            const el = document.getElementById('friend-search-results');
            const q = (query || '').replace(/\s+/g, ' ').trim();
            clearTimeout(_viewerLookupTimer);
            if (q.split(' ').length < 2) {
                _friendDirectory = [];
                el.innerHTML = `<p class="text-xs text-zinc-500 py-3 text-center">Type their first and last name, as it's on CrewSync.</p>`;
                return true;
            }
            if (_viewerLookupQuery === q) return false;
            el.innerHTML = `<p class="text-xs text-zinc-500 py-3 text-center">Looking…</p>`;
            _viewerLookupTimer = setTimeout(async () => {
                try { _friendDirectory = await fetch(`/api/pilots-lookup?token=${encodeURIComponent(myToken)}&name=${encodeURIComponent(q)}`).then(r => r.json()); }
                catch { _friendDirectory = []; }
                _viewerLookupQuery = q;
                renderFriendSearchResults(q);
                _viewerLookupQuery = null;
            }, 400);
            return true;
        }
        function renderFriendSearchResults(query) {
            const el = document.getElementById('friend-search-results');
            if (!el) return;
            if (myViewer && _viewerLookup(query)) return;
            const q = (query || '').trim().toLowerCase();
            const friendKeys = new Set(myFriends.map(f => f.pilotKey));
            const outgoingKeys = new Set(myOutgoingRequests.map(r => r.pilotKey));
            const incomingKeys = new Set(myIncomingRequests.map(r => r.pilotKey));
            const candidates = (_friendDirectory || [])
                .filter(p => p.pilot_key !== myPilot)
                .filter(p => !q || (p.name || '').toLowerCase().includes(q) || p.pilot_key.toLowerCase().includes(q));
            if (!candidates.length) {
                el.innerHTML = `<p class="text-xs text-zinc-500 py-3 text-center">No one matches "${escapeHtml(query)}"</p>`;
                return;
            }
            el.innerHTML = candidates.map(p => {
                const c = PILOT_COLORS[p.pilot_key] || '#6366f1';
                let actionHtml;
                if (friendKeys.has(p.pilot_key)) {
                    actionHtml = `<span class="text-[9px] font-black text-green-400 uppercase tracking-widest">✓ Friends</span>`;
                } else if (outgoingKeys.has(p.pilot_key)) {
                    actionHtml = `<span class="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Pending</span>`;
                } else if (incomingKeys.has(p.pilot_key)) {
                    actionHtml = `<button onclick="respondFriendRequest('${p.pilot_key}', true)" class="px-2.5 py-1 bg-green-600 hover:bg-green-500 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-colors">Accept</button>`;
                } else {
                    actionHtml = `<button onclick="sendFriendRequest('${p.pilot_key}', this)" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-colors">Add</button>`;
                }
                return `<div class="flex items-center justify-between py-2.5 px-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <div class="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-black shrink-0" style="background:${c}22;color:${c}">${(p.name || p.pilot_key)[0].toUpperCase()}</div>
                        <span class="text-sm font-black text-white truncate">${escapeHtml(p.name || p.pilot_key)}</span>
                    </div>
                    <div class="shrink-0 ml-2">${actionHtml}</div>
                </div>`;
            }).join('');
        }

