        // ── Crew Intel ───────────────────────────────────────────────────────────────
        let _intelCounts = {};           // { AIRPORT_CODE: count } — for crossing card badges
        let _intelAll    = null;         // full entry list
        let _intelFilter = { category: 'all' };
        let _intelView   = 'map';         // 'airports' | 'map' | 'detail'
        let _intelPrevView = 'map';      // view to return to when closing detail
        let _intelDetailAirport = null;  // code when in detail view
        let _intelListScrollY = 0;       // saved scroll position for airports list
        let _intelSearch = '';           // search string on airport index
        let _intelEditId  = null;
        let _intelFormCat = 'tip';
        let _intelMap    = null;         // Leaflet map instance for intel map view

        // Hides (never deletes) tips that are just generic "it's a National/State Park,
        // Monument, Historic(al) Site/Park, Seashore, Military Park, or Memorial" trivia a
        // pilot could've googled themselves -- added after Drew's intel entries filled up with
        // exactly that. Persisted per-device, defaults to hidden. Covers plurals ("National
        // Parks") via the trailing `s?` -- a plain \b word-boundary regex doesn't match "park"
        // inside "parks", which an earlier version of this missed.
        let _intelHideGeneric = localStorage.getItem('intel_hide_generic') !== '0';
        const INTEL_GENERIC_RE = /\b(national\s+(park|monument|historic(al)?\s+(site|park)|seashore|military\s+park|memorial)s?|state\s+park|memorial)\b/i;
        const _isGenericParkTip = e => INTEL_GENERIC_RE.test(e.title || '') || INTEL_GENERIC_RE.test(e.body || '');

        // Hides (never deletes) "activity" tips with no description at all -- just a bare
        // landmark name (e.g. "Louvre Museum", "Hollywood Sign", "NASCAR Hall of Fame") with
        // zero personal insight added. Found by auditing the full intel dataset: 70% of all
        // "activity" entries (193 of 275, nearly all from Drew) have an empty body -- a much
        // bigger clutter source than the park/monument wording above (74 entries) and not
        // reliably catchable by keyword matching since these cover every kind of landmark, not
        // just NPS-style sites. Separate toggle from the one above since it's a broader,
        // content-blind rule (would also hide a genuinely useful but terse "activity" entry),
        // not just a wording pattern -- independent control lets either be turned off alone.
        let _intelHideEmptyActivity = localStorage.getItem('intel_hide_empty_activity') !== '0';
        const _isEmptyActivityTip = e => e.category === 'activity' && !(e.body && e.body.trim());

        // Single source of truth for "what's actually shown" -- every render function below
        // reads from this instead of _intelAll directly, so both filters apply everywhere
        // (list, map pins, per-airport detail, counts) from these two toggles.
        function _intelVisible() {
            const all = Array.isArray(_intelAll) ? _intelAll : [];
            return all.filter(x => {
                if (_intelHideGeneric && _isGenericParkTip(x)) return false;
                if (_intelHideEmptyActivity && _isEmptyActivityTip(x)) return false;
                return true;
            });
        }
        function toggleIntelHideGeneric() {
            _intelHideGeneric = !_intelHideGeneric;
            localStorage.setItem('intel_hide_generic', _intelHideGeneric ? '1' : '0');
            _rebuildIntelCounts();
            renderIntel();
        }
        function toggleIntelHideEmptyActivity() {
            _intelHideEmptyActivity = !_intelHideEmptyActivity;
            localStorage.setItem('intel_hide_empty_activity', _intelHideEmptyActivity ? '1' : '0');
            _rebuildIntelCounts();
            renderIntel();
        }

        function _intelFetchUrl() {
            return myToken ? `/api/intel?token=${encodeURIComponent(myToken)}` : '/api/intel';
        }

        // Crew up/down voting on intel entries -- a crowd-sourced quality signal on top of the
        // keyword/blank-body filters above. An entry's score is SUM(vote) across everyone who's
        // voted; voteIntel() flips/clears the current pilot's own vote (one per person, enforced
        // server-side by intel_votes' UNIQUE(intel_id, pilot_key)).
        //
        // Heavily-downvoted entries are "redacted" rather than deleted or fully hidden: past
        // INTEL_REDACT_THRESHOLD they collapse to a one-line "crew downvoted this" placeholder
        // in the detail view, with a tap to reveal for that session (_intelExpandedRedacted,
        // not persisted -- redaction is a display default, not a removal, same philosophy as
        // the park/monument and blank-activity filters).
        const INTEL_REDACT_THRESHOLD = -3;
        let _intelExpandedRedacted = new Set();
        function expandRedactedIntel(id) {
            _intelExpandedRedacted.add(id);
            renderIntel();
        }

        async function voteIntel(id, vote) {
            if (isDemo) { alert('Read-only in demo mode.'); return; }
            if (!myToken) return;
            const entry = Array.isArray(_intelAll) ? _intelAll.find(x => x.id === id) : null;
            if (!entry) return;
            // vote === current vote means "un-vote" (tapping the same arrow again clears it)
            const nextVote = entry.my_vote === vote ? 0 : vote;
            const prevVote = entry.my_vote || 0;
            const prevScore = entry.score || 0;
            // Optimistic update so the UI feels instant -- reconciled with the server's
            // authoritative score below, reverted on failure.
            entry.my_vote = nextVote;
            entry.score = prevScore - prevVote + nextVote;
            renderIntel();
            try {
                const resp = await fetch(`/api/intel/${id}/vote`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken, vote: nextVote })
                });
                const result = await resp.json();
                if (!resp.ok || !result.success) throw new Error(result.error || 'Vote failed');
                entry.score = result.score;
                entry.my_vote = result.my_vote;
                renderIntel();
            } catch {
                entry.my_vote = prevVote;
                entry.score = prevScore;
                renderIntel();
                showToast('Vote failed — try again.', 'error');
            }
        }

        function escapeHtml(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // City names for standalone airports not covered by METRO_GROUPS
        const AIRPORT_CITIES = {
            'APC':'Napa, CA', 'KAPC':'Napa, CA',
            'STS':'Santa Rosa, CA', 'KSTS':'Santa Rosa, CA',
            'SMF':'Sacramento, CA', 'KSMF':'Sacramento, CA',
            'FAT':'Fresno, CA', 'KFAT':'Fresno, CA',
            'SBP':'San Luis Obispo, CA', 'KSBP':'San Luis Obispo, CA',
            'SBA':'Santa Barbara, CA', 'KSBA':'Santa Barbara, CA',
            'SMX':'Santa Maria, CA', 'KSMX':'Santa Maria, CA',
            'MRY':'Monterey, CA', 'KMRY':'Monterey, CA',
            'SNA':'Orange County, CA', 'KSNA':'Orange County, CA',
            'ONT':'Ontario, CA', 'KONT':'Ontario, CA',
            'BUR':'Burbank, CA', 'KBUR':'Burbank, CA',
            'LGB':'Long Beach, CA', 'KLGB':'Long Beach, CA',
            'TUS':'Tucson, AZ', 'KTUS':'Tucson, AZ',
            'FLG':'Flagstaff, AZ', 'KFLG':'Flagstaff, AZ',
            'GJT':'Grand Junction, CO', 'KGJT':'Grand Junction, CO',
            'COS':'Colorado Springs, CO', 'KCOS':'Colorado Springs, CO',
            'ABQ':'Albuquerque, NM', 'KABQ':'Albuquerque, NM',
            'SAF':'Santa Fe, NM', 'KSAF':'Santa Fe, NM',
            'ELP':'El Paso, TX', 'KELP':'El Paso, TX',
            'ABI':'Abilene, TX', 'KABI':'Abilene, TX',
            'AMA':'Amarillo, TX', 'KAMA':'Amarillo, TX',
            'LBB':'Lubbock, TX', 'KLBB':'Lubbock, TX',
            'MAF':'Midland, TX', 'KMAF':'Midland, TX',
            'TYR':'Tyler, TX', 'KTYR':'Tyler, TX',
            'SHV':'Shreveport, LA', 'KSHV':'Shreveport, LA',
            'BRO':'Brownsville, TX', 'KBRO':'Brownsville, TX',
            'CRP':'Corpus Christi, TX', 'KCRP':'Corpus Christi, TX',
            'ACT':'Waco, TX', 'KACT':'Waco, TX',
            'OKC':'Oklahoma City, OK', 'KOKC':'Oklahoma City, OK',
            'TUL':'Tulsa, OK', 'KTUL':'Tulsa, OK',
            'ICT':'Wichita, KS', 'KICT':'Wichita, KS',
            'LNK':'Lincoln, NE', 'KLNK':'Lincoln, NE',
            'OMA':'Omaha, NE', 'KOMA':'Omaha, NE',
            'FSD':'Sioux Falls, SD', 'KFSD':'Sioux Falls, SD',
            'BIS':'Bismarck, ND', 'KBIS':'Bismarck, ND',
            'GFK':'Grand Forks, ND', 'KGFK':'Grand Forks, ND',
            'RAP':'Rapid City, SD', 'KRAP':'Rapid City, SD',
            'BZN':'Bozeman, MT', 'KBZN':'Bozeman, MT',
            'MSO':'Missoula, MT', 'KMSO':'Missoula, MT',
            'GTF':'Great Falls, MT', 'KGTF':'Great Falls, MT',
            'BIL':'Billings, MT', 'KBIL':'Billings, MT',
            'JAC':'Jackson, WY', 'KJAC':'Jackson, WY',
            'CPR':'Casper, WY', 'KCPR':'Casper, WY',
            'BOI':'Boise, ID', 'KBOI':'Boise, ID',
            'TWF':'Twin Falls, ID', 'KTWF':'Twin Falls, ID',
            'IDA':'Idaho Falls, ID', 'KIDA':'Idaho Falls, ID',
            'RNO':'Reno, NV', 'KRNO':'Reno, NV',
            'EKO':'Elko, NV', 'KEKO':'Elko, NV',
            'MFR':'Medford, OR', 'KMFR':'Medford, OR',
            'RDM':'Bend, OR', 'KRDM':'Bend, OR',
            'EUG':'Eugene, OR', 'KEUG':'Eugene, OR',
            'YKM':'Yakima, WA', 'KYKM':'Yakima, WA',
            'PSC':'Pasco, WA', 'KPSC':'Pasco, WA',
            'GEG':'Spokane, WA', 'KGEG':'Spokane, WA',
            'BLI':'Bellingham, WA', 'KBLI':'Bellingham, WA',
            'BTV':'Burlington, VT', 'KBTV':'Burlington, VT',
            'PWM':'Portland, ME', 'KPWM':'Portland, ME',
            'BGR':'Bangor, ME', 'KBGR':'Bangor, ME',
            'MHT':'Manchester, NH', 'KMHT':'Manchester, NH',
            'PVD':'Providence, RI', 'KPVD':'Providence, RI',
            'HYA':'Hyannis, MA', 'KHYA':'Hyannis, MA',
            'ACK':'Nantucket, MA', 'KACK':'Nantucket, MA',
            'MVY':'Martha\'s Vineyard, MA', 'KMVY':'Martha\'s Vineyard, MA',
            'ALB':'Albany, NY', 'KALB':'Albany, NY',
            'ROC':'Rochester, NY', 'KROC':'Rochester, NY',
            'SYR':'Syracuse, NY', 'KSYR':'Syracuse, NY',
            'BUF':'Buffalo, NY', 'KBUF':'Buffalo, NY',
            'ITH':'Ithaca, NY', 'KITH':'Ithaca, NY',
            'EWB':'New Bedford, MA', 'KEWB':'New Bedford, MA',
            'ABE':'Allentown, PA', 'KABE':'Allentown, PA',
            'MDT':'Harrisburg, PA', 'KMDT':'Harrisburg, PA',
            'AVP':'Scranton, PA', 'KAVP':'Scranton, PA',
            'AGC':'Pittsburgh South', 'KAGC':'Pittsburgh South',
            'RIC':'Richmond, VA', 'KRIC':'Richmond, VA',
            'ROA':'Roanoke, VA', 'KROA':'Roanoke, VA',
            'CHO':'Charlottesville, VA', 'KCHO':'Charlottesville, VA',
            'ORF':'Norfolk, VA', 'KORF':'Norfolk, VA',
            'PHF':'Newport News, VA', 'KPHF':'Newport News, VA',
            'OAJ':'Jacksonville, NC', 'KOAJ':'Jacksonville, NC',
            'ILM':'Wilmington, NC', 'KILM':'Wilmington, NC',
            'FAY':'Fayetteville, NC', 'KFAY':'Fayetteville, NC',
            'GSO':'Greensboro, NC', 'KGSO':'Greensboro, NC',
            'GSP':'Greenville, SC', 'KGSP':'Greenville, SC',
            'CAE':'Columbia, SC', 'KCAE':'Columbia, SC',
            'CHS':'Charleston, SC', 'KCHS':'Charleston, SC',
            'SAV':'Savannah, GA', 'KSAV':'Savannah, GA',
            'VLD':'Valdosta, GA', 'KVLD':'Valdosta, GA',
            'AGS':'Augusta, GA', 'KAGS':'Augusta, GA',
            'CSG':'Columbus, GA', 'KCSG':'Columbus, GA',
            'DHN':'Dothan, AL', 'KDHN':'Dothan, AL',
            'MOB':'Mobile, AL', 'KMOB':'Mobile, AL',
            'HSV':'Huntsville, AL', 'KHSV':'Huntsville, AL',
            'BHM':'Birmingham, AL', 'KBHM':'Birmingham, AL',
            'MGM':'Montgomery, AL', 'KMGM':'Montgomery, AL',
            'GPT':'Gulfport, MS', 'KGPT':'Gulfport, MS',
            'JAN':'Jackson, MS', 'KJAN':'Jackson, MS',
            'BTR':'Baton Rouge, LA', 'KBTR':'Baton Rouge, LA',
            'LFT':'Lafayette, LA', 'KLFT':'Lafayette, LA',
            'LCH':'Lake Charles, LA', 'KLCH':'Lake Charles, LA',
            'AEX':'Alexandria, LA', 'KAEX':'Alexandria, LA',
            'MEI':'Meridian, MS', 'KMEI':'Meridian, MS',
            'TRI':'Tri-Cities, TN', 'KTRI':'Tri-Cities, TN',
            'TYS':'Knoxville, TN', 'KTYS':'Knoxville, TN',
            'CHA':'Chattanooga, TN', 'KCHA':'Chattanooga, TN',
            'MKL':'Jackson, TN', 'KMKL':'Jackson, TN',
            'EVV':'Evansville, IN', 'KEVV':'Evansville, IN',
            'SBN':'South Bend, IN', 'KSBN':'South Bend, IN',
            'FWA':'Fort Wayne, IN', 'KFWA':'Fort Wayne, IN',
            'TOL':'Toledo, OH', 'KTOL':'Toledo, OH',
            'CAK':'Akron, OH', 'KCAK':'Akron, OH',
            'MFD':'Mansfield, OH', 'KMFD':'Mansfield, OH',
            'GRR':'Grand Rapids, MI', 'KGRR':'Grand Rapids, MI',
            'LAN':'Lansing, MI', 'KLAN':'Lansing, MI',
            'FNT':'Flint, MI', 'KFNT':'Flint, MI',
            'MBS':'Saginaw, MI', 'KMBS':'Saginaw, MI',
            'TVC':'Traverse City, MI', 'KTVC':'Traverse City, MI',
            'MKE':'Milwaukee, WI', 'KMKE':'Milwaukee, WI',
            'GRB':'Green Bay, WI', 'KGRB':'Green Bay, WI',
            'LSE':'La Crosse, WI', 'KLSE':'La Crosse, WI',
            'AUS':'Austin, TX', 'KAUS':'Austin, TX',
            'SUS':'Chesterfield, MO', 'KSUS':'Chesterfield, MO',
            'STL':'St. Louis, MO', 'KSTL':'St. Louis, MO',
            'SGF':'Springfield, MO', 'KSGF':'Springfield, MO',
            'JLN':'Joplin, MO', 'KJLN':'Joplin, MO',
            'COU':'Columbia, MO', 'KCOU':'Columbia, MO',
            'FOE':'Topeka, KS', 'KFOE':'Topeka, KS',
            'MCI':'Kansas City, MO', 'KMCI':'Kansas City, MO',
            'DSM':'Des Moines, IA', 'KDSM':'Des Moines, IA',
            'CID':'Cedar Rapids, IA', 'KCID':'Cedar Rapids, IA',
            'DBQ':'Dubuque, IA', 'KDBQ':'Dubuque, IA',
            'MLI':'Moline, IL', 'KMLI':'Moline, IL',
            'BMI':'Bloomington, IL', 'KBMI':'Bloomington, IL',
            'SPI':'Springfield, IL', 'KSPI':'Springfield, IL',
            'MDW':'Chicago Midway', 'KMDW':'Chicago Midway',
            'SBY':'Salisbury, MD', 'KSBY':'Salisbury, MD',
            'HGR':'Hagerstown, MD', 'KHGR':'Hagerstown, MD',
            'ACY':'Atlantic City, NJ', 'KACY':'Atlantic City, NJ',
            'TTN':'Trenton, NJ', 'KTTN':'Trenton, NJ',
            'HPN':'White Plains, NY', 'KHPN':'White Plains, NY',
            'ISP':'Long Island, NY', 'KISP':'Long Island, NY',
            'SWF':'Newburgh, NY', 'KSWF':'Newburgh, NY',
            'BGM':'Binghamton, NY', 'KBGM':'Binghamton, NY',
            'ELM':'Elmira, NY', 'KELM':'Elmira, NY',
            'OGS':'Ogdensburg, NY', 'KOGS':'Ogdensburg, NY',
            'PBG':'Plattsburgh, NY', 'KPBG':'Plattsburgh, NY',
            'SLK':'Saranac Lake, NY', 'KSLK':'Saranac Lake, NY',
            'ASE':'Aspen, CO', 'KASE':'Aspen, CO',
            'EGE':'Eagle/Vail, CO', 'KEGE':'Eagle/Vail, CO',
            'HDN':'Steamboat Springs, CO', 'KHDN':'Steamboat Springs, CO',
            'MTJ':'Montrose, CO', 'KMTJ':'Montrose, CO',
            'DRO':'Durango, CO', 'KDRO':'Durango, CO',
            'PUB':'Pueblo, CO', 'KPUB':'Pueblo, CO',
            'TEX':'Telluride, CO', 'KTEX':'Telluride, CO',
            'ALS':'Alamosa, CO', 'KALS':'Alamosa, CO',
        };

        function _intelAreaLabel(code) {
            if (!code) return null;
            const upper = code.toUpperCase();
            const norm = normApt(code);
            return AIRPORT_CITIES[upper] || AIRPORT_CITIES[norm]
                || _serverCityCache[upper] || _serverCityCache[norm] || null;
        }

        async function _prefetchCities(input) {
            if (!input || !input.length) return;
            // Accept either raw code strings or segment objects {departure_airport, arrival_airport}
            const raw = typeof input[0] === 'string'
                ? input
                : input.flatMap(s => [s.departure_airport, s.arrival_airport]).filter(Boolean);
            const allCodes = [...new Set(raw.map(c => c.toUpperCase()))];

            // Fetch missing city names
            const neededCities = allCodes.filter(c => {
                const n = normApt(c);
                return !AIRPORT_CITIES[c] && !AIRPORT_CITIES[n] && !_serverCityCache[c] && !_serverCityCache[n];
            });
            // Fetch coordinates for airports not already in the client AIRPORTS map
            const neededCoords = allCodes.filter(c => !resolveAirport(c));
            await Promise.all([
                neededCities.length > 0 ? fetch(`${API_BASE}/airports/cities?codes=${neededCities.join(',')}`)
                    .then(res => res.ok ? res.json() : null).then(j => { if (j) Object.assign(_serverCityCache, j); }).catch(() => {}) : null,
                neededCoords.length > 0 ? fetch(`${API_BASE}/airports/coords?codes=${neededCoords.join(',')}`)
                    .then(res => res.ok ? res.json() : null).then(j => { if (j) Object.assign(AIRPORTS, j); }).catch(() => {}) : null,
            ]);
        }

        function _rebuildIntelCounts() {
            _intelCounts = {};
            _intelVisible().forEach(x => { _intelCounts[x.airport_code] = (_intelCounts[x.airport_code] || 0) + 1; });
        }

        // Opens on what's already loaded (startup fetches it), then refreshes quietly and only redraws
        // if something changed. It used to blank to a spinner and rebuild the map on every visit.
        async function loadIntel() {
            renderIntelHeader();
            const el = document.getElementById('intel-content');
            if (!el) return;
            const hadData = Array.isArray(_intelAll) && _intelAll.length > 0;
            if (hadData) renderIntel();
            else el.innerHTML = `<div class="flex items-center justify-center gap-2.5 py-10 text-zinc-500 text-sm"><div class="spinner"></div><span>Loading intel…</span></div>`;
            try {
                const rows = await fetch(_intelFetchUrl()).then(r => r.json());
                const changed = JSON.stringify(rows) !== JSON.stringify(_intelAll);
                _intelAll = rows;
                _rebuildIntelCounts();
                await _prefetchCities((_intelAll || []).map(x => x.airport_code).filter(Boolean));
                if (changed || !hadData) renderIntel();
            } catch {
                if (!hadData) el.innerHTML = `<div class="text-center py-10 text-zinc-600 text-sm">Failed to load intel.</div>`;
            }
        }

        async function loadIntelCounts() {
            try {
                const rows = await fetch(_intelFetchUrl()).then(r => r.json());
                if (!Array.isArray(rows)) return;
                _intelAll = rows;
                _rebuildIntelCounts();
                await _prefetchCities(rows.map(x => x.airport_code).filter(Boolean));
            } catch {}
        }

        function renderIntel() {
            renderIntelHeader();
            if (_intelView === 'detail' && _intelDetailAirport) {
                renderIntelDetail();
            } else if (_intelView === 'map') {
                renderIntelMap();
            } else {
                renderIntelAirports();
            }
        }

        function renderIntelHeader() {
            const header = document.getElementById('intel-header');
            if (!header) return;
            if (_intelView === 'airports' || _intelView === 'map') {
                const isMap = _intelView === 'map';
                const visibleEntries = _intelVisible();
                const totalEntries = visibleEntries.length;
                const totalAirports = new Set(visibleEntries.map(x => x.airport_code)).size;
                const rawAll = Array.isArray(_intelAll) ? _intelAll : [];
                const genericCount = rawAll.filter(_isGenericParkTip).length;
                const emptyActivityCount = rawAll.filter(_isEmptyActivityTip).length;
                const clearBtn = _intelSearch
                    ? `<button id="intel-search-clear" onclick="clearIntelSearch()" class="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-base leading-none transition-colors">×</button>`
                    : '';
                header.innerHTML = `
                    <div class="px-5 pt-5 pb-3 flex items-center justify-between gap-3">
                        <div>
                            <h2 class="text-base font-black text-white uppercase tracking-tight">Crew Intel</h2>
                            <p class="text-[10px] text-zinc-600 mt-0.5">${totalEntries > 0 ? `${totalEntries} tip${totalEntries !== 1 ? 's' : ''} · ${totalAirports} airport${totalAirports !== 1 ? 's' : ''}` : 'Shared airport knowledge'}</p>
                        </div>
                        <div class="flex items-center gap-2">
                            <div class="flex rounded-lg overflow-hidden border border-zinc-800 shrink-0">
                                <button onclick="setIntelView('airports')" class="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${!isMap ? 'bg-zinc-700 text-white' : 'bg-transparent text-zinc-500 hover:text-zinc-300'}">List</button>
                                <button onclick="setIntelView('map')" class="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest border-l border-zinc-800 transition-all ${isMap ? 'bg-zinc-700 text-white' : 'bg-transparent text-zinc-500 hover:text-zinc-300'}">Map</button>
                            </div>
                            ${!isDemo ? `<button onclick="openAddIntel()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-black text-[10px] uppercase tracking-widest transition-colors">+ Add</button>` : ''}
                        </div>
                    </div>
                    <div class="px-5 pb-2 flex flex-wrap gap-1.5">
                        <button onclick="toggleIntelHideGeneric()" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[9px] font-bold uppercase tracking-widest transition-colors ${_intelHideGeneric ? 'border-amber-800/50 bg-amber-950/30 text-amber-400 hover:bg-amber-950/50' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}">
                            <span>${_intelHideGeneric ? '🙈' : '👁'}</span>
                            <span>${_intelHideGeneric ? `Hiding park/monument tips${genericCount ? ` (${genericCount})` : ''}` : 'Showing park/monument tips'}</span>
                        </button>
                        <button onclick="toggleIntelHideEmptyActivity()" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[9px] font-bold uppercase tracking-widest transition-colors ${_intelHideEmptyActivity ? 'border-amber-800/50 bg-amber-950/30 text-amber-400 hover:bg-amber-950/50' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}">
                            <span>${_intelHideEmptyActivity ? '🙈' : '👁'}</span>
                            <span>${_intelHideEmptyActivity ? `Hiding blank activity tips${emptyActivityCount ? ` (${emptyActivityCount})` : ''}` : 'Showing blank activity tips'}</span>
                        </button>
                    </div>
                    ${isMap ? '' : `<div class="px-5 pb-3"><div class="relative">
                        <svg class="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input id="intel-search-input" type="text" placeholder="Search airports or cities…"
                            oninput="setIntelSearch(this.value)"
                            value="${escapeHtml(_intelSearch)}"
                            class="w-full bg-zinc-900/60 border border-zinc-800 focus:border-zinc-600 rounded-lg pl-8 pr-8 py-2 text-xs text-zinc-300 placeholder-zinc-600 outline-none transition-colors" />
                        ${clearBtn}
                    </div></div>`}`;
            } else {
                const ap = _intelDetailAirport || '';
                const areaLabel = _intelAreaLabel(ap);
                const allEntries = _intelVisible().filter(x => x.airport_code === ap);
                const catCounts = {};
                allEntries.forEach(e => { catCounts[e.category] = (catCounts[e.category] || 0) + 1; });
                const cats = ['all','hotel','food','activity','tip'];
                const catPills = cats.map(c => {
                    const n = c === 'all' ? allEntries.length : (catCounts[c] || 0);
                    if (c !== 'all' && n === 0) return '';
                    const label = c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1);
                    const isActive = _intelFilter.category === c;
                    return `<button onclick="setIntelCat('${c}')" class="intel-cat-btn ${isActive ? 'intel-cat-active' : ''}">${label}${c !== 'all' ? ` <span style="opacity:0.6">${n}</span>` : ''}</button>`;
                }).join('');
                header.innerHTML = `
                    <div class="px-4 pt-4 pb-2 flex items-center gap-3">
                        <button onclick="setIntelView(_intelPrevView)" class="w-8 h-8 flex items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600 transition-colors flex-shrink-0">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                        </button>
                        <div class="flex-1 min-w-0">
                            <div class="font-black text-white uppercase tracking-tight font-mono text-base leading-none">${escapeHtml(ap)}</div>
                            ${areaLabel ? `<div class="text-[10px] text-zinc-500 mt-0.5 truncate">${escapeHtml(areaLabel)}</div>` : ''}
                        </div>
                        <button onclick="openAddIntel('${escapeHtml(ap)}')" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-black text-[10px] uppercase tracking-widest transition-colors flex-shrink-0">+ Add</button>
                    </div>
                    <div class="flex gap-1.5 px-4 pb-3 overflow-x-auto">${catPills}</div>`;
            }
        }

        let _intelMapKey = null;
        // One Intel map for the session, like the main map. It used to be built from scratch on every first
        // open (~1.3 s), every pin change, and every switch back from the list. Now the map and its element
        // persist: the element is moved into #intel-content (which the list and detail views overwrite) when
        // the map view shows, and only the pins layer is redrawn. _prewarmIntelMap() creates it ahead of time
        // off-screen. Starts on the US like the main map; it keeps wherever you leave it.
        let _intelMapEl = null, _intelPins = null;
        function _ensureIntelMap() {
            if (_intelMap) return _intelMap;
            let holder = document.getElementById('intel-map-holder');
            if (!holder) {
                holder = document.createElement('div');
                holder.id = 'intel-map-holder';
                holder.style.cssText = 'position:fixed;left:-200vw;top:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none';
                document.body.appendChild(holder);
            }
            _intelMapEl = document.createElement('div');
            _intelMapEl.id = 'intel-map-el';
            holder.appendChild(_intelMapEl);
            _intelMap = L.map(_intelMapEl, { zoomControl: false, worldCopyJump: true, doubleClickZoom: true, bounceAtZoomLimits: false }).setView([39.8283, -98.5795], 4);
            _intelMap.attributionControl.setPrefix(false);
            addBasemap(_intelMap);
            setupDoubleTapZoom(_intelMap);
            const _intelZoom = document.createElement('div');
            _intelZoom.style.cssText = 'position:absolute;top:10px;left:10px;z-index:1000;display:flex;flex-direction:column;gap:4px;pointer-events:auto';
            _intelZoom.innerHTML = `<button onclick="if(_intelMap)_intelMap.zoomIn()" class="map-ctrl-pill" style="padding:5px 11px;font-size:15px;line-height:1;font-weight:900">+</button><button onclick="if(_intelMap)_intelMap.zoomOut()" class="map-ctrl-pill" style="padding:5px 11px;font-size:15px;line-height:1;font-weight:900">−</button>`;
            _intelMapEl.appendChild(_intelZoom);

            // Legend
            const legendItems = [
                { color: '#ef4444', label: 'Mixed' },
                { color: '#fbbf24', label: 'Food' },
                { color: '#4ade80', label: 'Activity' },
                { color: '#60a5fa', label: 'Hotel' },
                { color: '#c4b5fd', label: 'Tip' },
            ];
            const pinIcon = c => `<svg width="12" height="17" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg"><line x1="15" y1="24" x2="15" y2="40" stroke="#999" stroke-width="2" stroke-linecap="round"/><circle cx="15" cy="13" r="12" fill="${c}" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/><circle cx="10.5" cy="8.5" r="3.5" fill="rgba(255,255,255,0.2)"/></svg>`;
            const legendHtml = legendItems.map(({ color, label }) =>
                `<div style="display:flex;align-items:center;gap:5px">${pinIcon(color)}<span style="color:#71717a;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em">${label}</span></div>`
            ).join('');
            const legend = L.control({ position: 'bottomleft' });
            legend.onAdd = () => {
                const d = L.DomUtil.create('div');
                d.style.cssText = 'background:rgba(9,9,11,0.85);border:1px solid rgba(63,63,70,0.7);border-radius:8px;padding:8px 10px;backdrop-filter:blur(6px);display:flex;flex-direction:column;gap:5px;pointer-events:none';
                d.innerHTML = legendHtml;
                return d;
            };
            legend.addTo(_intelMap);
            _intelPins = L.layerGroup().addTo(_intelMap);
            return _intelMap;
        }
        function _prewarmIntelMap() {
            if (_intelMap || !_mapLibsReady() || (currentView === 'intel' && _intelView === 'map')) return;
            try { _ensureIntelMap(); } catch (e) { console.warn('[intel] prewarm failed:', e.message); }
        }
        function renderIntelMap() {
            const el = document.getElementById('intel-content');
            if (!el) return;
            // Map libraries load on first use (ensureMapLibs, maps/map-core.js); redraw once they're in.
            if (!_mapLibsReady()) { ensureMapLibs().then(() => { if (currentView === 'intel') renderIntel(); }).catch(() => {}); return; }
            const items = _intelVisible();

            document.getElementById('view-intel').classList.add('intel-map-mode');
            _ensureIntelMap();
            if (_intelMapEl.parentNode !== el) { el.innerHTML = ''; el.appendChild(_intelMapEl); }
            requestAnimationFrame(() => _intelMap?.invalidateSize());
            // Same pins: nothing to redraw.
            const mapKey = items.map(x => `${x.id}:${x.category}:${x.airport_code}`).join();
            if (mapKey === _intelMapKey) return;
            _intelMapKey = mapKey;
            _intelPins.clearLayers();

            const byAirport = {};
            items.forEach(x => { (byAirport[x.airport_code] = byAirport[x.airport_code] || []).push(x); });


            const catColors = { hotel:'#60a5fa', food:'#fbbf24', activity:'#4ade80', tip:'#c4b5fd' };
            const bounds = [];

            Object.entries(byAirport).forEach(([ap, entries]) => {
                const coords = resolveAirport(ap);
                if (!coords) return;
                bounds.push(coords);

                const count = entries.length;
                const cats = [...new Set(entries.map(e => e.category))];
                // pick dominant color: most frequent category, or red for mixed
                const catFreq = {};
                entries.forEach(e => { catFreq[e.category] = (catFreq[e.category] || 0) + 1; });
                const topCat = Object.entries(catFreq).sort((a,b) => b[1]-a[1])[0]?.[0];
                const pinColor = cats.length === 1 ? (catColors[cats[0]] || '#ef4444') : '#ef4444';
                const areaLabel = _intelAreaLabel(ap) || '';

                // SVG thumbtack: round head + thin needle
                const pinSvg = `<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.7));display:block">
                    <ellipse cx="15" cy="41" rx="3.5" ry="1.2" fill="rgba(0,0,0,0.35)"/>
                    <line x1="15" y1="24" x2="15" y2="40" stroke="#bbb" stroke-width="1.5" stroke-linecap="round"/>
                    <circle cx="15" cy="13" r="12" fill="${pinColor}" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/>
                    <circle cx="10.5" cy="8.5" r="3.5" fill="rgba(255,255,255,0.22)"/>
                    <text x="15" y="17.5" text-anchor="middle" font-size="11" font-weight="900" fill="white" font-family="system-ui,sans-serif" style="text-shadow:0 1px 2px rgba(0,0,0,0.6)">${count}</text>
                </svg>`;

                const catDots = cats.map(c =>
                    `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:${catColors[c]||'#94a3b8'}">${c.charAt(0).toUpperCase()+c.slice(1)}</span>`
                ).join('<span style="color:#52525b;margin:0 2px">·</span>');

                const icon = L.divIcon({
                    className: '',
                    iconSize: [30, 42],
                    iconAnchor: [15, 41],
                    popupAnchor: [0, -42],
                    html: `<div style="cursor:pointer;user-select:none">${pinSvg}</div>`
                });

                const popup = `<div style="font-family:system-ui,sans-serif;min-width:150px">
                    <div style="font-size:15px;font-weight:900;color:#f8fafc;letter-spacing:0.05em;font-family:monospace">${escapeHtml(ap)}</div>
                    ${areaLabel ? `<div style="font-size:10px;color:#94a3b8;margin-bottom:5px;line-height:1.3">${escapeHtml(areaLabel)}</div>` : '<div style="margin-bottom:5px"></div>'}
                    <div style="font-size:10px;margin-bottom:8px;line-height:1.6">${catDots}</div>
                    <button onclick="_intelMap.closePopup();openIntelAirport('${ap}')" style="width:100%;padding:7px;border-radius:7px;background:#3b82f6;color:#fff;font-size:11px;font-weight:900;border:none;cursor:pointer;letter-spacing:0.05em">VIEW ${count} TIP${count===1?'':'S'} →</button>
                </div>`;

                // Add marker at base lon and ±360° so pins appear on every world copy when panning
                [-360, 0, 360].forEach(offset => {
                    L.marker([coords[0], coords[1] + offset], { icon })
                        .bindPopup(popup, { className: 'dark-popup', maxWidth: 210 })
                        .addTo(_intelPins);
                });
            });

        }

        function renderIntelAirports() {
            const el = document.getElementById('intel-content');
            if (!el) return;
            document.getElementById('view-intel').classList.remove('intel-map-mode');
            const items = _intelVisible();
            const byAirport = {};
            items.forEach(x => { (byAirport[x.airport_code] = byAirport[x.airport_code] || []).push(x); });
            let airports = Object.keys(byAirport).sort((a, b) => {
                const la = _intelAreaLabel(a) || a;
                const lb = _intelAreaLabel(b) || b;
                return la.localeCompare(lb);
            });
            if (_intelSearch) {
                const q = _intelSearch.toUpperCase();
                airports = airports.filter(ap => ap.includes(q) || (_intelAreaLabel(ap) || '').toUpperCase().includes(q));
            }
            if (airports.length === 0) {
                el.innerHTML = _intelSearch
                    ? `<div class="text-center py-12 text-zinc-500 text-sm">No airports match "${escapeHtml(_intelSearch)}"</div>`
                    : `<div class="text-center py-12 text-zinc-500 text-sm">No crew intel yet.<br><span class="text-zinc-600 text-xs mt-1.5 block">Tap + Add to share your first tip.</span></div>`;
                return;
            }
            const catColors = { hotel:'#60a5fa', food:'#fbbf24', activity:'#4ade80', tip:'#c4b5fd' };
            const catOrder  = ['hotel','food','activity','tip'];
            el.innerHTML = `<div class="flex flex-col gap-2 pb-4">${airports.map(ap => {
                const entries = byAirport[ap];
                const areaLabel = _intelAreaLabel(ap);
                const counts = {};
                entries.forEach(e => { counts[e.category] = (counts[e.category] || 0) + 1; });
                const dominant = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'tip';
                const accentColor = catColors[dominant];
                const catRow = catOrder.filter(c => counts[c]).map(c =>
                    `<span class="text-[10px] font-bold" style="color:${catColors[c]}">${c.charAt(0).toUpperCase()+c.slice(1)}${counts[c] > 1 ? ` ${counts[c]}` : ''}</span>`
                ).join(`<span class="text-zinc-700 mx-1">·</span>`);
                return `<button onclick="openIntelAirport('${ap}')" class="w-full text-left rounded-xl border border-zinc-800/80 bg-zinc-900/30 hover:bg-zinc-900/70 hover:border-zinc-700 transition-all active:scale-[0.99] flex overflow-hidden group">
                    <div class="w-[3px] self-stretch shrink-0" style="background:${accentColor};opacity:0.65"></div>
                    <div class="flex-1 min-w-0 px-4 py-3.5 flex items-center gap-3">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-baseline gap-2.5 min-w-0">
                                <span class="font-black text-white font-mono text-[15px] leading-none tracking-wide shrink-0">${escapeHtml(ap)}</span>
                                ${areaLabel ? `<span class="text-xs text-zinc-500 truncate leading-none">${escapeHtml(areaLabel)}</span>` : ''}
                            </div>
                            <div class="flex items-center gap-0.5 mt-1.5 flex-wrap">${catRow}</div>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            <span class="text-[12px] font-black" style="color:${accentColor}">${entries.length}</span>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="text-zinc-700 group-hover:text-zinc-500 transition-colors"><polyline points="9 18 15 12 9 6"/></svg>
                        </div>
                    </div>
                </button>`;
            }).join('')}</div>`;
        }

        function renderIntelDetail() {
            const el = document.getElementById('intel-content');
            if (!el) return;
            document.getElementById('view-intel').classList.remove('intel-map-mode');
            const ap = _intelDetailAirport;
            let items = _intelVisible().filter(x => x.airport_code === ap);
            if (_intelFilter.category !== 'all') items = items.filter(x => x.category === _intelFilter.category);
            if (items.length === 0) {
                const catMsg = _intelFilter.category !== 'all' ? `${_intelFilter.category} tips` : 'tips';
                el.innerHTML = `<div class="text-center py-12 text-zinc-500 text-sm">No ${catMsg} for ${escapeHtml(ap)} yet.<br><span class="text-zinc-600 text-xs mt-1.5 block">Tap + Add to share what you know.</span></div>`;
                return;
            }
            const catColors = { hotel:'#60a5fa', food:'#fbbf24', activity:'#4ade80', tip:'#c4b5fd' };
            const catBg     = { hotel:'rgba(59,130,246,0.12)', food:'rgba(245,158,11,0.12)', activity:'rgba(34,197,94,0.12)', tip:'rgba(167,139,250,0.12)' };
            const fmtDate   = s => new Date(s).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
            const canVote   = !isDemo && !!myToken;
            // Reddit-style: highest score first, newest as tiebreaker. Category pills above
            // already let the crew narrow to one category if they want that grouping instead.
            items.sort((a, b) => (b.score || 0) - (a.score || 0) || new Date(b.created_at) - new Date(a.created_at));
            el.innerHTML = `<div class="flex flex-col gap-2.5 pb-4">${items.map(e => {
                const score = e.score || 0;
                if (score <= INTEL_REDACT_THRESHOLD && !_intelExpandedRedacted.has(e.id)) {
                    return `<button onclick="expandRedactedIntel(${e.id})" class="w-full text-left rounded-xl border border-zinc-800/50 bg-zinc-900/30 px-4 py-3 flex items-center gap-2.5 hover:bg-zinc-900/50 transition-colors">
                        <span class="text-sm">🙈</span>
                        <span class="text-[11px] text-zinc-500 font-bold flex-1">Downvoted by the crew (${score}) — tap to view anyway</span>
                        <span class="text-[9px] text-zinc-700 uppercase font-black tracking-widest shrink-0">Show</span>
                    </button>`;
                }
                const myVote = e.my_vote || 0;
                const isOwn = !isDemo && (myPilot === null || (myPilot && e.added_by === myPilot) || (myViewer && e.added_by === myViewerKey));
                const _rawName = (e.added_by_name || PILOT_NAMES[e.added_by] || e.added_by || '').split(' ')[0];
                const firstName = _rawName.charAt(0).toUpperCase() + _rawName.slice(1);
                const pilotColor = PILOT_COLORS[e.added_by] || '#52525b';
                const color  = catColors[e.category] || '#94a3b8';
                const bg     = catBg[e.category]     || 'rgba(255,255,255,0.05)';
                const catLabel = e.category.charAt(0).toUpperCase() + e.category.slice(1);
                const bodyText = (e.body || '').trim();
                const hasBody  = !!bodyText;
                const isLong   = bodyText.length > 180;
                const ownBtns = isOwn ? `<div class="flex items-center gap-0.5 ml-auto">
                    <button onclick="event.stopPropagation();openEditIntel(${e.id})" class="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-zinc-600 hover:text-zinc-300 transition-colors px-2 py-1 rounded">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit
                    </button>
                    <button onclick="event.stopPropagation();deleteIntelTip(${e.id})" class="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-zinc-600 hover:text-red-400 transition-colors px-2 py-1 rounded">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>Delete
                    </button>
                </div>` : '';
                const voteWidget = canVote ? `<div class="flex items-center gap-0.5 shrink-0">
                    <button onclick="event.stopPropagation();voteIntel(${e.id},1)" class="w-6 h-6 flex items-center justify-center rounded-md transition-colors ${myVote===1 ? 'text-green-400 bg-green-500/15' : 'text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800'}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l8 10H4z"/></svg>
                    </button>
                    <span class="text-[11px] font-black tabular-nums w-5 text-center ${score>0?'text-green-400':score<0?'text-red-400':'text-zinc-600'}">${score}</span>
                    <button onclick="event.stopPropagation();voteIntel(${e.id},-1)" class="w-6 h-6 flex items-center justify-center rounded-md transition-colors ${myVote===-1 ? 'text-red-400 bg-red-500/15' : 'text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800'}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20l-8-10h16z"/></svg>
                    </button>
                </div>` : (score ? `<span class="text-[11px] font-black shrink-0 ${score>0?'text-green-400':'text-red-400'}">${score>0?'+':''}${score}</span>` : '');
                return `<div class="rounded-xl border border-zinc-800/70 bg-zinc-900/50 overflow-hidden">
                    <div class="px-4 pt-3.5 pb-3">
                        <div class="flex items-center justify-between gap-2 mb-2.5">
                            <span class="inline-block px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest" style="background:${bg};color:${color}">${catLabel}</span>
                            ${voteWidget}
                        </div>
                        <div class="text-[15px] font-bold text-white leading-snug">${escapeHtml(e.title)}</div>
                        ${hasBody ? `<p id="intel-bp-${e.id}" class="text-sm text-zinc-400 leading-relaxed mt-2${isLong ? ' line-clamp-3' : ''}">${escapeHtml(bodyText).replace(/\n/g, '<br>')}</p>
                        ${isLong ? `<button onclick="const p=document.getElementById('intel-bp-${e.id}');const cl=p.classList.toggle('line-clamp-3');this.textContent=cl?'Show more':'Show less'" class="text-[10px] font-bold text-zinc-500 hover:text-zinc-300 mt-1 transition-colors">Show more</button>` : ''}` : ''}
                    </div>
                    <div class="border-t border-zinc-800/50 px-4 py-2 flex items-center gap-2">
                        <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${pilotColor}"></span>
                        <span class="text-[10px] font-bold text-zinc-500">${escapeHtml(firstName)}</span>
                        <span class="text-zinc-700">·</span>
                        <span class="text-[10px] text-zinc-600">${fmtDate(e.created_at)}</span>
                        ${ownBtns}
                    </div>
                </div>`;
            }).join('')}</div>`;
        }

        function setIntelView(view) {
            _intelView = view;
            if (view === 'airports' || view === 'map') { _intelDetailAirport = null; _intelFilter.category = 'all'; }
            renderIntel();
            if (view === 'airports') {
                requestAnimationFrame(() => document.getElementById('view-intel')?.scrollTo(0, _intelListScrollY));
            } else if (view !== 'map') {
                document.getElementById('view-intel')?.scrollTo(0, 0);
            }
        }

        function openIntelAirport(code) {
            _intelPrevView = _intelView === 'detail' ? _intelPrevView : _intelView;
            if (_intelView === 'airports') _intelListScrollY = document.getElementById('view-intel')?.scrollTop || 0;
            _intelDetailAirport = code;
            _intelView = 'detail';
            _intelFilter.category = 'all';
            renderIntel();
            document.getElementById('view-intel')?.scrollTo(0, 0);
        }

        function setIntelSearch(val) {
            _intelSearch = val.toUpperCase().trim();
            const clear = document.getElementById('intel-search-clear');
            if (clear) clear.classList.toggle('hidden', !val);
            renderIntelAirports();
        }

        function clearIntelSearch() {
            _intelSearch = '';
            const input = document.getElementById('intel-search-input');
            if (input) { input.value = ''; input.focus(); }
            const clear = document.getElementById('intel-search-clear');
            if (clear) clear.classList.add('hidden');
            renderIntelAirports();
        }

        function setIntelCat(cat) {
            _intelFilter.category = cat;
            renderIntelHeader();
            renderIntelDetail();
        }

        function openAddIntel(prefilledAirport) {
            _intelEditId = null;
            document.getElementById('intel-modal-title').textContent = 'Add Intel';
            document.getElementById('intel-form-airport').value = prefilledAirport || _intelDetailAirport || '';
            document.getElementById('intel-form-title').value = '';
            document.getElementById('intel-form-body').value = '';
            selectIntelCat('tip');
            document.getElementById('intel-modal').classList.remove('hidden');
        }

        function openEditIntel(id) {
            if (!Array.isArray(_intelAll)) return;
            const e = _intelAll.find(x => x.id === id);
            if (!e) return;
            _intelEditId = id;
            document.getElementById('intel-modal-title').textContent = 'Edit Intel';
            document.getElementById('intel-form-airport').value = e.airport_code;
            document.getElementById('intel-form-title').value = e.title;
            document.getElementById('intel-form-body').value = e.body || '';
            selectIntelCat(e.category);
            document.getElementById('intel-modal').classList.remove('hidden');
        }

        function closeIntelModal() {
            document.getElementById('intel-modal').classList.add('hidden');
        }

        function selectIntelCat(cat) {
            _intelFormCat = cat;
            document.querySelectorAll('.intel-form-cat').forEach(b => b.classList.remove('intel-form-cat-active'));
            document.getElementById(`form-icat-${cat}`)?.classList.add('intel-form-cat-active');
        }

        async function saveIntelTip() {
            const airport = document.getElementById('intel-form-airport').value.toUpperCase().trim();
            const title   = document.getElementById('intel-form-title').value.trim();
            const body    = document.getElementById('intel-form-body').value.trim();
            if (airport.length < 3) { alert('Enter a valid airport code (e.g. KLAX)'); return; }
            if (!title) { alert('Title is required'); return; }
            if (isDemo) { alert('Read-only in demo mode.'); return; }
            if (!myToken) { alert('Not signed in.'); return; }
            const payload = { airport_code: airport, category: _intelFormCat, title, body, token: myToken };
            try {
                let res;
                if (_intelEditId) {
                    res = await fetch(`/api/intel/${_intelEditId}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                } else {
                    res = await fetch('/api/intel', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                }
                if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}));
                    throw new Error(errBody.error || `Server returned ${res.status}`);
                }
                closeIntelModal();
                _intelDetailAirport = airport;
                _intelView = 'detail';
                _intelFilter.category = 'all';
                await loadIntel();
            } catch (e) { alert('Failed to save: ' + (e.message || 'unknown error')); }
        }

        async function deleteIntelTip(id) {
            if (!confirm('Delete this tip?')) return;
            try {
                const res = await fetch(`/api/intel/${id}`, {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: myToken })
                });
                if (!res.ok) throw new Error();
                if (Array.isArray(_intelAll)) _intelAll = _intelAll.filter(x => x.id !== id);
                _rebuildIntelCounts();
                renderIntel();
            } catch { alert('Failed to delete. Please try again.'); }
        }

        function openIntelForAirport(airport) {
            _intelDetailAirport = airport;
            _intelView = 'detail';
            _intelFilter.category = 'all';
            switchView('intel');
        }

