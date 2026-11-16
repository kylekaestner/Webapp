        // ── Airport time ─────────────────────────────────────────────────────────
        // Time-zone lookup per airport (tz-lookup on its coordinates), local <-> UTC conversion, and
        // formatting. flightLocalDate() = which calendar day at the airport; flightUTCTime() = the true
        // instant, for comparing across pilots or "is it active now" (see CLAUDE.md). Their caches
        // (_tzOffsetFmts, _tzDateFmts, _utcMemo) are in schedule/airports-and-bases.js.
        // tz-lookup (tzlookup) loads async from the page head. Until it's in, airportTz() returns null, the same
        // as before airports.json arrives, and only successes are cached. Once it loads, redraw so every time
        // shown picks up its zone (if it loads before this script runs, there's nothing to redraw yet).
        function _onTzLookup() { if (typeof airportDbReady !== 'undefined' && airportDbReady && typeof render === 'function') render(); }
        const _tzCache = {}; // populated on demand by airportTz() via tz-lookup + coordinates
        function airportTz(code) {
            if (!code) return null;
            const c = code.toUpperCase().trim();
            if (_tzCache[c]) return _tzCache[c];
            // Derive from coordinates if tz-lookup is available
            const coords = AIRPORTS[c] || (typeof AIRPORT_DB !== 'undefined' && (AIRPORT_DB.byIcao[c] || AIRPORT_DB.byIata[c]));
            if (coords && typeof tzlookup === 'function') {
                try {
                    const tz = tzlookup(coords[0], coords[1]);
                    if (tz) { _tzCache[c] = tz; return tz; }
                } catch (e) { /* ignore */ }
            }
            return null;
        }
        const _TZ_SHORT = { 'EST':'ET','EDT':'ET','CST':'CT','CDT':'CT','MST':'MT','MDT':'MT','PST':'PT','PDT':'PT','AKST':'AKT','AKDT':'AKT','HST':'HT','HDT':'HT','AST':'AT','ADT':'AT' };
        function tzAbbr(airportCode, iso) {
            const tz = airportTz(airportCode);
            if (!tz) return '';
            try {
                const d = new Date(iso || Date.now());
                const raw = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
                    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value || '';
                return _TZ_SHORT[raw] || raw;
            } catch (e) { return ''; }
        }
        function formatTimeISO(iso, airportCode) {
            if (!iso) return '—';
            try {
                const d = new Date(iso);
                if (isNaN(d.getTime())) return '—';
                const isUtc = iso.endsWith('Z') || iso.endsWith('z');
                if (isUtc && airportCode) {
                    const tz = airportTz(airportCode);
                    if (tz) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz });
                }
                return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            } catch (e) {
                return '—';
            }
        }
        function formatDurationMinutes(mins) {
            if (mins <= 0 || !isFinite(mins)) return '—';
            const h = Math.floor(mins / 60); const m = Math.round(mins % 60);
            if (h > 0) return `${h}h ${m}m`;
            return `${m}m`;
        }

        function localTimeToUTC(localISO, tzName) {
            const memoKey = tzName + '|' + localISO;
            const memo = _utcMemo.get(memoKey);
            if (memo !== undefined) return new Date(memo);
            const approx = new Date(localISO + 'Z');
            let fmt = _tzOffsetFmts.get(tzName);
            if (!fmt) {
                fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzName, timeZoneName: 'longOffset' });
                _tzOffsetFmts.set(tzName, fmt);
            }
            const offsetAt = d => {
                const parts = fmt.formatToParts(d);
                const m = (parts.find(p => p.type === 'timeZoneName')?.value || '').match(/GMT([+-])(\d+):(\d{2})/);
                return m ? (m[1] === '+' ? 1 : -1) * (parseInt(m[2]) * 60 + parseInt(m[3])) : null;
            };
            const first = offsetAt(approx);
            if (first == null) return approx;
            // Second pass with the offset at the corrected instant: the first guess reads the offset
            // a few hours away from the real moment, so on a DST-change day a time shortly after
            // the switch came out an hour off (Nov 1 3:00 AM CST converted as 2:00 AM).
            const second = offsetAt(new Date(approx.getTime() - first * 60000));
            const utcMs = approx.getTime() - (second ?? first) * 60000;
            _utcMemo.set(memoKey, utcMs);
            return new Date(utcMs);
        }

        // Returns the local calendar date (YYYY-MM-DD) of a flight time at its airport.
        // Non-Z strings already encode the local date — use the prefix directly.
        // Only apply timezone conversion for UTC (Z-suffixed) strings.
        function flightLocalDate(isoStr, airportCode) {
            if (!isoStr) return '';
            try {
                const d = new Date(isoStr);
                if (isNaN(d.getTime())) return isoStr.substring(0, 10);
                if ((isoStr.endsWith('Z') || isoStr.endsWith('z')) && airportCode) {
                    const tz = airportTz(airportCode);
                    if (tz) {
                        let fmt = _tzDateFmts.get(tz);
                        if (!fmt) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz }); _tzDateFmts.set(tz, fmt); }
                        return fmt.format(d);
                    }
                }
                return isoStr.substring(0, 10);
            } catch(e) { return isoStr.substring(0, 10); }
        }

        // Returns a proper UTC Date for a flight time, accounting for airport timezone.
        // Times ending in Z are already UTC. Local times (Adam/Sam/Logan) are converted
        // using the airport's IANA timezone so browser timezone doesn't corrupt comparisons.
        function flightUTCTime(isoStr, airportCode) {
            if (!isoStr) return null;
            if (isoStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(isoStr)) return new Date(isoStr);
            const tz = airportTz(airportCode);
            if (tz) {
                try { return localTimeToUTC(isoStr.slice(0, 16), tz); } catch(e) {}
            }
            return new Date(isoStr); // fallback: browser-local (old behavior)
        }
