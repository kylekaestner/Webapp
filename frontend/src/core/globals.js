        /*
         * ╔══════════════════════════════════════════════════════════════════╗
         * ║  CrewSync  app.html  --  architecture overview                  ║
         * ╠══════════════════════════════════════════════════════════════════╣
         * ║  IDENTITY  (stateless, resolved fresh on every page load)       ║
         * ║  URL ?u=TOKEN -> GET /api/pilots/by-token/:token                ║
         * ║    pilotKey === 'admin' -> myPilot = null  (full access)        ║
         * ║    any other key        -> myPilot = 'kyle' etc.                ║
         * ║  No token, not /demo    -> redirect to landing page (/)         ║
         * ║                                                                  ║
         * ║  KEY GLOBALS                                                     ║
         * ║  myPilot      -- who you ARE (null = admin/no identity)         ║
         * ║  currentPilot -- whose schedule is on screen right now          ║
         * ║  PILOT_KEYS   -- mutable array; extra pilots pushed at runtime  ║
         * ║  VALID_PILOTS -- alias for PILOT_KEYS (same object reference)   ║
         * ║  pilotsCache  -- { key: apiResponse } filled lazily on demand   ║
         * ║                                                                  ║
         * ║  DATA FLOW                                                       ║
         * ║  loadPilot(key) -> fetchPilotData -> GET /api/pilots/:key       ║
         * ║    API returns snake_case DB fields (departure_time, etc.)       ║
         * ║    loadPilot maps them to camelCase for the segments array       ║
         * ║    inferAwayLayovers() inserts synthetic 'away' events           ║
         * ║    render() dispatches to grid / list / map / overlap view       ║
         * ║                                                                  ║
         * ║  SCHEDULE SOURCES  (stored in pilots.parser_type in DB)         ║
         * ║  kyle  -- Schedaero ICS sync  (sync button only, no upload)     ║
         * ║  drew  -- RosterBuster ICS    (sync button only, no upload)     ║
         * ║  others -- CSV or ICS file upload                               ║
         * ║                                                                  ║
         * ║  DEMO MODE  (/demo route)                                       ║
         * ║  isDemo = true; fetches hit /api/demo/pilots/:key               ║
         * ║  canEdit() always false; no ?u= token required                  ║
         * ╚══════════════════════════════════════════════════════════════════╝
         */

        // pilotsCache persists fetched API responses for the session lifetime.
        // computeOverlap(), renderAllPilotsMap(), and renderDayMap() all read from it
        // to avoid redundant fetches when switching views.
        const pilotsCache = {};
        const _pilotLoads = new Map(); // pilot key -> request in flight, see _loadPilotOnce()

        // True if this pilot's flight times are stored as UTC (Z suffix).
        // Only flight segments are checked — events like hard/vacation use local midnight without Z.
        function pilotUsesUtc(k) {
            const segs = pilotsCache[k]?.segments;
            if (!segs?.length) return false;
            const t = (segs.find(s => s.departure_time && s.type === 'flight') || {}).departure_time || '';
            return t.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(t);
        }

        const _isDemo = window.location.pathname === '/demo';
        const API_BASE = _isDemo ? '/api/demo' : '/api';

        let _confirmCallback = null;
