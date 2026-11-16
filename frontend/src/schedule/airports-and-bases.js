        function haversineMi(lat1, lon1, lat2, lon2) {
            const R = 3958.8;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        }

        // Projects the aircraft's live position onto the filed/resolved route (an ordered
        // origin→...→destination point sequence) to find how far along it the aircraft actually
        // is, in miles. Used to drop fixes/waypoints the aircraft has already passed from the
        // live map — a simple "nearest point" wouldn't work here, since a fix starts being the
        // nearest one well before the aircraft actually reaches it, which would make it disappear
        // too early. Projecting onto each segment (equirectangular approximation — lon scaled by
        // cos(lat); accurate enough over typical enroute/STAR fix spacing) and taking the
        // closest-approach segment gives a much better "has this fix been passed yet" answer.
        // Returns { cumDist: number[] (one entry per path point, cumulative miles from the
        // start), aircraftProgress: number (the aircraft's own cumulative-mile position) }.
        function computeRouteProgress(path, aircraftPt) {
            const cumDist = [0];
            let running = 0, best = { progress: 0, distToRoute: Infinity };
            for (let i = 0; i < path.length - 1; i++) {
                const a = path[i], b = path[i + 1];
                const segLen = haversineMi(a.lat, a.lon, b.lat, b.lon);
                const latScale = 69, lonScale = 69 * Math.cos(a.lat * Math.PI / 180);
                const bx = (b.lon - a.lon) * lonScale, by = (b.lat - a.lat) * latScale;
                const px = (aircraftPt[1] - a.lon) * lonScale, py = (aircraftPt[0] - a.lat) * latScale;
                const segLenSq = bx * bx + by * by;
                let t = segLenSq > 0 ? (px * bx + py * by) / segLenSq : 0;
                t = Math.max(0, Math.min(1, t));
                const dist = Math.hypot(px - bx * t, py - by * t);
                if (dist < best.distToRoute) best = { progress: running + t * segLen, distToRoute: dist };
                running += segLen;
                cumDist.push(running);
            }
            return { cumDist, aircraftProgress: best.progress };
        }

        const AIRPORTS = {};  // populated from airports.json on load
        // Building an Intl.DateTimeFormat is very slow, worst on iPhone Safari, and these run for every
        // segment of every pilot on each render. Formatters are reused per zone; a conversion result
        // never changes, so each local time + zone is only worked out once.
        const _tzOffsetFmts = new Map();
        const _tzDateFmts = new Map();
        const _utcMemo = new Map();
        let airportDbReady = false;
        let _serverCityCache = {};  // populated on schedule load from /api/airports/cities

        // Airports in the same metro area — treated as co-located for overlap purposes
        const METRO_GROUPS = {
            // New York
            'JFK': 'NYC', 'LGA': 'NYC', 'EWR': 'NYC', 'TEB': 'NYC', 'HPN': 'NYC', 'ISP': 'NYC', 'SWF': 'NYC',
            // Philadelphia
            'PHL': 'PHL', 'ABE': 'PHL', 'TTN': 'PHL', 'ILG': 'PHL', 'ACY': 'PHL',
            // St. Louis
            'STL': 'STL_M', 'SUS': 'STL_M', 'CPS': 'STL_M',
            // Chicago
            'ORD': 'CHI', 'MDW': 'CHI', 'PWK': 'CHI', 'RFD': 'CHI', 'DPA': 'CHI',
            // Los Angeles
            'LAX': 'LAX', 'BUR': 'LAX', 'SNA': 'LAX', 'LGB': 'LAX', 'ONT': 'LAX', 'VNY': 'LAX', 'SMO': 'LAX', 'TOA': 'LAX',
            // San Francisco Bay Area
            'SFO': 'SFB', 'OAK': 'SFB', 'SJC': 'SFB', 'STS': 'SFB', 'SQL': 'SFB', 'APC': 'SFB',
            // Dallas
            'DFW': 'DFW_M', 'DAL': 'DFW_M', 'ADS': 'DFW_M', 'FTW': 'DFW_M', 'GPM': 'DFW_M', 'RBD': 'DFW_M',
            // Phoenix
            'PHX': 'PHX', 'SDL': 'PHX', 'DVT': 'PHX', 'FFZ': 'PHX', 'CHD': 'PHX', 'IWA': 'PHX',
            // Washington DC
            'DCA': 'WAS', 'IAD': 'WAS', 'BWI': 'WAS', 'GAI': 'WAS', 'JYO': 'WAS',
            // Boston
            'BOS': 'BOS', 'BED': 'BOS', 'MHT': 'BOS', 'PVD': 'BOS', 'ORH': 'BOS', 'BVY': 'BOS',
            // Miami / South Florida
            'MIA': 'MIA', 'FLL': 'MIA', 'OPF': 'MIA', 'BCT': 'MIA', 'PBI': 'MIA', 'TMB': 'MIA',
            // Tampa Bay
            'TPA': 'TPA', 'PIE': 'TPA', 'SRQ': 'TPA', 'TBZ': 'TPA',
            // Orlando
            'MCO': 'ORL', 'SFB': 'ORL', 'ISM': 'ORL', 'ORL': 'ORL',
            // Houston
            'IAH': 'HOU', 'HOU': 'HOU', 'EFD': 'HOU', 'DWH': 'HOU', 'SGR': 'HOU',
            // Seattle
            'SEA': 'SEA', 'BFI': 'SEA', 'RNT': 'SEA', 'PAE': 'SEA',
            // Atlanta
            'ATL': 'ATL', 'PDK': 'ATL', 'FTY': 'ATL', 'RYY': 'ATL',
            // Denver
            'DEN': 'DEN', 'APA': 'DEN', 'BJC': 'DEN', 'FNL': 'DEN',
            // Minneapolis
            'MSP': 'MSP', 'FCM': 'MSP', 'ANE': 'MSP', 'STP': 'MSP',
            // Detroit
            'DTW': 'DTW', 'PTK': 'DTW', 'YIP': 'DTW', 'DET': 'DTW',
            // Cleveland / Akron
            'CLE': 'CLE', 'CAK': 'CLE', 'BKL': 'CLE', 'CGF': 'CLE',
            // Cincinnati
            'CVG': 'CVG', 'LUK': 'CVG', 'HAO': 'CVG',
            // Charlotte
            'CLT': 'CLT', 'JQF': 'CLT', 'UZA': 'CLT',
            // Las Vegas
            'LAS': 'LAS', 'HND': 'LAS', 'VGT': 'LAS',
            // San Diego
            'SAN': 'SAN', 'MYF': 'SAN', 'SEE': 'SAN', 'NZY': 'SAN', 'CRQ': 'SAN',
            // Portland OR
            'PDX': 'PDX', 'TTD': 'PDX', 'HIO': 'PDX', 'UAO': 'PDX',
            // Salt Lake City
            'SLC': 'SLC', 'PVU': 'SLC', 'U42': 'SLC',
            // Kansas City
            'MCI': 'MKC', 'JCI': 'MKC', 'OJC': 'MKC', 'MKC': 'MKC',
            // Nashville
            'BNA': 'BNA', 'MQY': 'BNA', 'JWN': 'BNA',
            // Pittsburgh
            'PIT': 'PIT', 'AGC': 'PIT', 'BTP': 'PIT',
            // Raleigh / Triangle
            'RDU': 'RDU', 'TTA': 'RDU', 'RWI': 'RDU',
            // Columbus OH
            'CMH': 'CMH', 'OSU': 'CMH', 'LCK': 'CMH',
            // San Antonio
            'SAT': 'SAT', 'SSF': 'SAT', 'SKF': 'SAT',
            // Baltimore (already in WAS but standalone too)
            // Memphis
            'MEM': 'MEM', 'NQA': 'MEM',
            // New Orleans
            'MSY': 'MSY', 'NEW': 'MSY', 'NBG': 'MSY',
            // Canada — Toronto area
            'YYZ': 'YTO', 'YTZ': 'YTO', 'YHM': 'YTO', 'YKZ': 'YTO',
            // Canada — Vancouver area
            'YVR': 'YVA', 'YXX': 'YVA', 'ZBB': 'YVA', 'YDT': 'YVA',
            // Canada — Montreal area
            'YUL': 'YMT', 'YHU': 'YMT', 'YMX': 'YMT',
            // Canada — Ottawa / Gatineau
            'YOW': 'YOT', 'YND': 'YOT',
            // Canada — Calgary area
            'YYC': 'YCA', 'YBW': 'YCA',
            // Canada — Edmonton area
            'YEG': 'YEA', 'YXD': 'YEA',
        };
        const METRO_LABELS = {
            'NYC': 'New York Area', 'PHL': 'Philadelphia Area', 'STL_M': 'St. Louis Area',
            'CHI': 'Chicago Area', 'LAX': 'LA Area', 'SFB': 'SF Bay Area',
            'DFW_M': 'Dallas Area', 'PHX': 'Phoenix Area', 'WAS': 'DC Area',
            'BOS': 'Boston Area', 'MIA': 'South Florida', 'TPA': 'Tampa Bay Area',
            'ORL': 'Orlando Area', 'HOU': 'Houston Area', 'SEA': 'Seattle Area',
            'ATL': 'Atlanta Area', 'DEN': 'Denver Area', 'MSP': 'Minneapolis Area',
            'DTW': 'Detroit Area', 'CLE': 'Cleveland Area', 'CVG': 'Cincinnati Area',
            'CLT': 'Charlotte Area', 'LAS': 'Las Vegas Area', 'SAN': 'San Diego Area',
            'PDX': 'Portland Area', 'SLC': 'Salt Lake City Area', 'MKC': 'Kansas City Area',
            'BNA': 'Nashville Area', 'PIT': 'Pittsburgh Area', 'RDU': 'Raleigh Area',
            'CMH': 'Columbus Area', 'SAT': 'San Antonio Area', 'MEM': 'Memphis Area',
            'MSY': 'New Orleans Area',
            'YTO': 'Toronto Area', 'YVA': 'Vancouver Area', 'YMT': 'Montreal Area',
            'YOT': 'Ottawa Area', 'YCA': 'Calgary Area', 'YEA': 'Edmonton Area',
        };

        const IATA_TO_CALLSIGN = {
            // Regionals (existing crew airlines)
            G7: 'GJS', OO: 'SKW', YX: 'RPA', '9E': 'FLG',
            // US majors / LCCs — IATA 2-letter → ICAO 3-letter for ADS-B callsign lookup
            UA: 'UAL', DL: 'DAL', AA: 'AAL', WN: 'SWA', AS: 'ASA',
            B6: 'JBU', F9: 'FFT', NK: 'NKS', G4: 'AAY', SY: 'SCX',
            HA: 'HAL', MX: 'MXY', VX: 'VRD',
            // Canada / common international
            AC: 'ACA', WS: 'WJA', WE: 'SWG',
        };
        const IATA_TO_CALLSIGN_ENTRIES = Object.entries(IATA_TO_CALLSIGN);
        // Airports that count as "home" — some pilots have two (e.g. Kyle: SUS + STL, same metro)
        const PILOT_HOME_AIRPORTS = { kyle: ['SUS','STL'], adam: ['TUL'], sam: ['STL'], logan: ['PHX'], drew: ['STL'] };
        // Normalize ICAO → IATA: strip leading K (US) or C (Canada) from 4-char ICAO codes
        // KSUS → SUS, KLGA → LGA, CYYZ → YYZ, CYVR → YVR
        function normApt(code) {
            if (!code) return '';
            const u = code.toUpperCase().trim();
            // Keep the prefix when the 3-letter remainder is a different airport (KCQF Fairhope AL
            // vs CQF Calais, KBKV Brooksville FL vs BKV China) -- same rule as server.js's
            // norm3Airport(); stripping it sent maps/Crossings to the wrong continent.
            if (u.length === 4 && (u[0] === 'K' || u[0] === 'C')) return _prefixCollides(u) ? u : u.slice(1);
            return u;
        }
        // Display only. NetJets legs show 3 letters, but a KSDL/KCQF/KBKV row keeps its K in the data
        // because the bare code is another airport (Sundsvall, Calais, China): resolveAirport() and the
        // timezone lookups must get the stored code, never this label. With no pilot (Crossings, shared
        // map labels) codes are already normApt'd, so only a K kept for a collision is left to drop.
        function aptLabel(code, pilotKey) {
            const c = code || '';
            if (!/^K[A-Z0-9]{3}$/.test(c)) return c;
            if (pilotKey) return pilotsCache[pilotKey]?.parser_type === 'manual_netjets' ? c.slice(1) : c;
            return _prefixCollides(c) ? c.slice(1) : c;
        }
        function _prefixCollides(icao) {
            if (typeof AIRPORTS === 'undefined') return false;
            const full = AIRPORTS[icao], bare = AIRPORTS[icao.slice(1)];
            if (!full || !bare) return false;
            const dLat = full[0] - bare[0], dLon = (full[1] - bare[1]) * Math.cos(full[0] * Math.PI / 180);
            return Math.sqrt(dLat * dLat + dLon * dLon) * 111 > 50;
        }
        function sameApt(a, b) { return !!a && !!b && normApt(a) === normApt(b); }
        function isHomeAirport(airport, pilotKey) {
            if (!airport) return false;
            const homes = PILOT_HOME_AIRPORTS[pilotKey] || (PILOT_HOME[pilotKey] ? [PILOT_HOME[pilotKey]] : []);
            return homes.some(h => sameApt(h, airport));
        }
        function isBaseAirport(airport, pilotKey) {
            const base = pilotsCache[pilotKey]?.base;
            return !!base && sameApt(base, airport);
        }
        function isHomeOrBase(airport, pilotKey) {
            return isHomeAirport(airport, pilotKey) || isBaseAirport(airport, pilotKey);
        }
        // The base a pilot was on at a moment, using the same rule as buildGroundPeriods's baseAt():
        // a trip keeps the base it left from, even if a base change takes effect while it's out
        // (Sam's October LGA trip ended 11/1, the day ORD took over). Departure times from any known
        // base are indexed once per segment list, so a lookup never rescans the pilot's history.
        const _baseDepIndex = new WeakMap();
        function pilotBaseAt(pilotKey, when) {
            const data = pilotsCache[pilotKey];
            if (!data) return null;
            const hist = data.base_history;
            if (!hist?.length || !data.segments) return data.base ? normApt(data.base) : null;
            let times = _baseDepIndex.get(data.segments);
            if (!times) {
                const known = new Set(hist.filter(h => h.base).map(h => normApt(h.base)));
                if (data.base) known.add(normApt(data.base));
                times = data.segments
                    .filter(x => x.departure_time && x.departure_airport && !x.auto_leg_cancelled && known.has(normApt(x.departure_airport)))
                    .map(x => new Date(x.departure_time).getTime())
                    .sort((a, b) => a - b);
                _baseDepIndex.set(data.segments, times);
            }
            const at = new Date(when).getTime();
            let lo = 0, hi = times.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= at) lo = mid + 1; else hi = mid; }
            return resolveBaseAt(data.base, hist, new Date(lo ? times[lo - 1] : at));
        }
        function isHomeOrBaseAt(airport, pilotKey, when) {
            return isHomeAirport(airport, pilotKey) || sameApt(airport, pilotBaseAt(pilotKey, when));
        }
        // Resolves which airline base was actually in effect on a given date, for a pilot whose
        // base changed over time (e.g. a regional reassignment) -- baseHistory is the pilot's
        // `base_history` array from the API ([{base, effective_from}], ascending), and falls back
        // to the pilot's current `base` untouched when there's no history (every pilot who's never
        // had a recorded base change).
        function resolveBaseAt(base, baseHistory, atDate) {
            const current = base ? normApt(base) : null;
            if (!baseHistory || !baseHistory.length) return current;
            const t = atDate instanceof Date ? atDate.getTime() : new Date(atDate).getTime();
            let resolved = current;
            for (const h of baseHistory) {
                if (new Date(h.effective_from).getTime() <= t) resolved = normApt(h.base);
                else break;
            }
            return resolved;
        }

