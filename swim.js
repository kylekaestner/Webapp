// swim.js — FAA SWIM (SFDPS) live position feed.
//
// Replaces ADS-B as the primary source for live position lookups on domestic flights;
// server.js falls back to the existing ADS-B sources whenever this has no fresh data for
// a callsign (SWIM connection down, international leg SFDPS doesn't cover, or a flight
// SFDPS simply hasn't published a position for recently).
//
// SFDPS delivers en-route position reports as FIXM XML over a Solace-brokered queue — a
// message stream, not a request/response API, so this module stays connected and maintains
// state itself rather than being polled per lookup.
//
// FIXM field extraction below is a first pass, written without the ability to test against
// a live feed. It WILL need correction once connected to the real stream — every ICS/CSV
// parser already in this codebase was built the same way: assume a shape, then diff against
// real messages and fix what's wrong. Treat this the same way.

const solace = require('solclientjs');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

const SFDPS_HOST  = process.env.SFDPS_HOST;
const SFDPS_VPN   = process.env.SFDPS_VPN;
const SFDPS_USER  = process.env.SFDPS_USER;
const SFDPS_PASS  = process.env.SFDPS_PASS;
const SFDPS_QUEUE = process.env.SFDPS_QUEUE;

const SWIM_ENABLED = !!(SFDPS_HOST && SFDPS_VPN && SFDPS_USER && SFDPS_PASS && SFDPS_QUEUE);

// Confirmed against real captured messages (2026-10-02): SFDPS has no literal radio frequency
// anywhere, but it does carry real ATC sector handoff events -- <enRoute><boundaryCrossings>
// <handoff><receivingUnit unitIdentifier="SDA" sectorIdentifier="1D"/>
// <transferringUnit unitIdentifier="ZID" sectorIdentifier="21"/></handoff> -- fired each time the
// aircraft crosses a sector boundary. This module only exposes that raw unit+sector identifier
// (entry.sector = { unit, sectorId }); resolving it to a real tunable frequency is vnas.js's job,
// wired together in server.js's fetchLivePosition() -- see vnas.js's own header for how and why.

const STALE_MS  = 10 * 60 * 1000; // a position older than this isn't offered as a fresh hit
const PURGE_MS  = 60 * 60 * 1000; // drop a watched flight's trail after this long with no update
const LATEST_PURGE_MS = 2 * 60 * 60 * 1000; // cheap latest-position-only entries live longer

// Two tiers, since SFDPS covers the whole country's en-route traffic and CrewSync only
// cares about a handful of callsigns at any given time:
//   _latest  — lat/lon/altitude only, kept for every callsign the feed mentions (cheap)
//   _watched — full trail history, built for every scheduled-relevant callsign automatically
//              (see setRelevantCallsigns() below) from ~30min before departure, not just
//              whichever ones a client happens to have looked at. Confirmed live this
//              distinction mattered: a flight (SWA133) added to CrewSync mid-flight had a real
//              gap back to departure in its SWIM trail, because the only thing that used to set
//              _watched was a client actually hitting /api/live-position for that callsign --
//              being in _relevantCallsigns (i.e. "CrewSync knows about this flight and SWIM is
//              already receiving its position") did NOT by itself mean its trail was being kept.
const _latest  = {};  // callsign -> { lat, lon, altFt, heading, onGround, lastMsg, gufi, origin, dest }
const _watched = new Set();

// SFDPS can't be filtered server-side — the queue delivers every en-route flight in the
// country regardless of what CrewSync actually wants. This is the client-side equivalent:
// server.js refreshes this with the set of callsigns actually scheduled on CrewSync (same
// derivation as the existing ADS-B background poller), and anything not in it is dropped
// before any state is stored or any field is parsed — no reason to retain or process data
// for flights no CrewSync pilot is on. null (the startup default, before the first refresh)
// means "no filter yet" — fail open to tracking everything rather than silently tracking
// nothing if this is ever misconfigured.
let _relevantCallsigns = null;
function setRelevantCallsigns(set) {
    _relevantCallsigns = set instanceof Set ? set : new Set(set || []);
    // Actively prune, don't just gate future entries. Messages can (and do, in a brief window
    // right after connecting, before this has been called even once) arrive before a filter is
    // set — those create real _latest entries that a gate-only filter would never retroactively
    // clean up, since it only blocks *new* writes. Confirmed live: without this, callsigns seen
    // in the first second or two after connecting kept answering queries indefinitely.
    for (const cs of Object.keys(_latest)) {
        if (!_relevantCallsigns.has(cs)) { delete _latest[cs]; _watched.delete(cs); }
    }
    // Start trail recording the moment a flight becomes relevant (runActiveFlightPoller refreshes
    // this every 15s off the real -8h/+30min schedule window), not only once a client happens to
    // open the live map for it — see _watched's declaration comment above for the real SWA133 gap
    // this closes. getSwimPosition() below still does its own _watched.add() too, as a harmless
    // fallback for any callsign asked about that isn't (yet, or for some edge case) relevant.
    for (const cs of _relevantCallsigns) _watched.add(cs);
}

// Persists across a server restart: the trail (original purpose) AND the last-parsed route/
// sector too -- requested directly, confirmed live that a restart wiped a route that had already
// been resolved and was actively being displayed on the map (SWA3492), forcing a wait for SFDPS
// to happen to re-send a route-bearing message, which (per the file-level gotcha above) can take
// a while for a field that doesn't change every message. Covers every relevant callsign currently
// in _latest with something worth saving, not just _watched ones -- route data is useful even for
// a flight nobody's live-tracking the trail of yet (e.g. the preflight route display, which can
// run up to 4h before departure, well before any trail exists to watch).
const STATE_CACHE_FILE = path.join(__dirname, '.swim_state_cache.json');
let _saveTimer = null;
function scheduleSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        const data = {};
        for (const cs of Object.keys(_latest)) {
            const f = _latest[cs];
            const hasTrail = _watched.has(cs) && f.trail?.length;
            const hasRoute = !!f.route;
            if (!hasTrail && !hasRoute) continue;
            data[cs] = {
                ts: Date.now(),
                ...(hasTrail ? { trail: f.trail } : {}),
                // routeParsed may already carry a resolved resolvedPath (server.js's
                // resolveRouteWaypoints mutates the same object in place) -- saving it as-is means
                // a restart doesn't even need to wait for a fresh resolve, not just a fresh route.
                ...(hasRoute ? {
                    route: f.route, originalRoute: f.originalRoute, routeParsed: f.routeParsed,
                    sid: f.sid, star: f.star, origin: f.origin, dest: f.dest,
                } : {}),
            };
        }
        try { fs.writeFileSync(STATE_CACHE_FILE, JSON.stringify(data)); } catch (_) {}
    }, 5000); // batch writes, same pattern as the ADS-B trail cache
}
function loadStateCache() {
    try {
        const data = JSON.parse(fs.readFileSync(STATE_CACHE_FILE, 'utf8'));
        const cutoff = Date.now() - 24 * 60 * 60 * 1000; // same reuse-the-next-day concern trail already had
        for (const [cs, entry] of Object.entries(data)) {
            if (entry.ts <= cutoff) continue;
            _latest[cs] = _latest[cs] || {};
            if (Array.isArray(entry.trail) && entry.trail.length) {
                _latest[cs].trail = entry.trail;
                _watched.add(cs);
            }
            if (entry.route) {
                _latest[cs].route = entry.route;
                _latest[cs].originalRoute = entry.originalRoute;
                _latest[cs].routeParsed = entry.routeParsed;
                _latest[cs].sid = entry.sid;
                _latest[cs].star = entry.star;
                _latest[cs].origin = entry.origin;
                _latest[cs].dest = entry.dest;
            }
        }
    } catch (_) {}
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

// Depth-first search for the first value under a given (namespace-stripped) tag name.
// FIXM messages nest deeply and inconsistently across message types; searching by bare tag
// name rather than hardcoding an exact path is more resilient to that than it is a hack —
// same reasoning the project's other parsers use a loose match before tightening later.
// Confirmed against a real message: the first <position> hit this way is the aircraft's
// actual reported position (nested enRoute > position > position > location > pos), ahead
// of the predicted <targetPosition> that carries the same <pos> shape later in the same
// message — so searching for the leaf tag 'pos' directly (rather than walking the position/
// position/location chain) naturally prefers actual over predicted, matching document order.
function findDeep(obj, tagName) {
    if (obj == null || typeof obj !== 'object') return undefined;
    if (tagName in obj) return obj[tagName];
    for (const key of Object.keys(obj)) {
        const v = obj[key];
        if (v && typeof v === 'object') {
            const found = findDeep(Array.isArray(v) ? v[0] : v, tagName);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

// Same deep search, but for an XML attribute (fast-xml-parser prefixes attribute keys with
// "@_"). Confirmed against a real message: callsign (aircraftIdentification) and the
// departure/arrival airports (departurePoint/arrivalPoint) are all attributes, not elements.
function findAttr(obj, attrName) {
    return findDeep(obj, '@_' + attrName);
}

// fast-xml-parser gives a leaf element with both text and attributes as {"#text": "...", ...}
// but a plain leaf with no attributes comes through as a bare string — normalize both.
function textOf(val) {
    if (val == null) return undefined;
    if (typeof val === 'object') return val['#text'];
    return val;
}

// Breaks a raw NAS route string into an ordered list of waypoints. Standard US domestic route
// notation. Verified against a 300-route survey of real nationwide traffic, not just 2-3
// examples — the survey changed a couple of conclusions drawn from the smaller sample:
//
// Single "." separates a structured/published continuation (airport→SID, SID→its transition
// fix, STAR→destination); ".." means "direct" between two otherwise-unconnected points.
// "./." means "direct from present position." Initially read as "this route was just amended by
// ATC" (true of one early example) — the 300-route survey showed it on 70% of all routes, so
// it's really just the normal way an active flight's *current* clearance is expressed, not a
// reroute signal. Treat it as "starting point," not "something changed."
//
// Two real patterns the small sample completely missed:
// - Airways (J217, Q82, V39, M580...) appeared on 25% of surveyed routes — common, not an edge
//   case. Flagged as their own type since resolving one means looking up a published sequence
//   of intermediate fixes along it, not just the two named points around it.
// - International routes (Mexico, Canada, and even one transatlantic business-jet filing to
//   Spain) were 14% of the survey. The airport check below deliberately does NOT use a country
//   regex (e.g. "starts with K") — it checks each token against the message's own known
//   origin/dest instead, which works regardless of country.
// - Raw lat/lon tokens (e.g. "4052N/09119W", degrees+minutes) show up on long-haul/oceanic
//   routes where there's no named fix at a boundary-crossing point. These need zero database
//   lookup — they're already coordinates, just in a different notation — so they're resolved
//   directly here rather than deferred to the NASR-lookup phase everything else needs.
//
// This still does NOT resolve named fixes/navaids/airways/procedures to real coordinates —
// that needs FAA's NASR data (public domain — same category as the OurAirports data already
// used elsewhere in this app, confirmed via SwimReader's own real implementation, not a
// licensed product like Navigraph) and, for SID/STAR/airway sequences specifically, the
// published procedure/airway definition (FAA CIFP data). Neither is wired up yet. Treat this as
// "the filed route as a readable, ordered, typed list," not yet "a plottable line on the map" —
// except for the lat/lon tokens, which already are plottable.
const RADIAL_FIX_RE = /^([A-Z]{2,4})(\d{3})(\d{3})$/; // e.g. CKW117042 = radial 117, 42nm from CKW
const AIRWAY_RE = /^[A-Z]{1,2}\d{1,4}$/; // e.g. J217, Q82, V39, M580 — short letter prefix + number, distinct from 5-6 char procedure names
const LATLON_RE = /^(\d{2})(\d{2})([NS])\/(\d{3})(\d{2})([EW])$/; // e.g. 4052N/09119W = 40°52'N 091°19'W
function latLonTokenToDecimal(name) {
    const m = name.match(LATLON_RE);
    if (!m) return null;
    const lat = (parseInt(m[1], 10) + parseInt(m[2], 10) / 60) * (m[3] === 'S' ? -1 : 1);
    const lon = (parseInt(m[4], 10) + parseInt(m[5], 10) / 60) * (m[6] === 'W' ? -1 : 1);
    return [lat, lon];
}
function parseRouteString(routeText, origin, dest) {
    if (!routeText) return null;
    let text = routeText;
    let elapsedTime = null;
    const timeMatch = text.match(/\/(\d{4})$/);
    if (timeMatch) { elapsedTime = timeMatch[1]; text = text.slice(0, timeMatch.index); }
    text = text.replace(/\*$/, ''); // trailing "*" seen on one real example (CYYZ*) — meaning unconfirmed, stripped rather than guessed at

    const directFromPresent = /^[^.]*\.\/\./.test(text) || text.startsWith('./.');
    text = text.replace(/\.\/\./g, '..'); // normalize "direct from present position" to a plain direct separator

    const parts = text.split(/\.+/).filter(Boolean);
    const directFlags = []; // whether each token (after the first) was reached via ".." (direct) vs "." (published)
    for (const m of text.matchAll(/\.+/g)) directFlags.push(m[0].length >= 2);

    const originU = (origin || '').toUpperCase();
    const destU = (dest || '').toUpperCase();

    const waypoints = parts.map((name, i) => {
        const direct = i === 0 ? directFromPresent : directFlags[i - 1];
        const latlon = latLonTokenToDecimal(name);
        if (latlon) return { name, type: 'latlon', lat: latlon[0], lon: latlon[1], direct };

        const radialMatch = name.match(RADIAL_FIX_RE);
        if (radialMatch) {
            return { name, type: 'radial_fix', navaid: radialMatch[1], radial: parseInt(radialMatch[2], 10), distanceNm: parseInt(radialMatch[3], 10), direct };
        }
        // Checked against the message's own known origin/dest rather than a country-prefix
        // regex (e.g. "starts with K") — real routes include Mexico, Canada, and beyond, so a
        // US-only check misclassifies 14% of real traffic (see survey notes above).
        if (name === originU || name === destU) return { name, type: 'airport', direct };
        if (AIRWAY_RE.test(name)) return { name, type: 'airway', direct };
        if (/^[A-Z]+\d$/.test(name) && name.length >= 4 && name.length <= 7) return { name, type: 'procedure', direct }; // heuristic: SID/STAR names end in a single digit
        return { name, type: 'fix', direct };
    });

    return { waypoints, elapsedTime, directFromPresent };
}

let _unmappedWarnings = 0;
const WARN_CAP = 20; // don't flood the log once we're clearly missing a field mapping

// One Solace message batches many FIXM <message> entries under <MessageCollection> — a
// real sample came through with 74 — so this updates one single flight's state from one
// already-isolated <message> object, and handleMessage() below calls it once per entry.
function processOneMessage(msgObj) {
    // aircraftIdentification lives on <flightIdentification> as an attribute, e.g.
    // <flightIdentification ... aircraftIdentification="SWA2977"/> — confirmed live.
    const rawCallsign = findAttr(msgObj, 'aircraftIdentification');
    if (!rawCallsign) {
        if (_unmappedWarnings++ < WARN_CAP) {
            console.warn('[SWIM] message had no recognizable callsign field (tried aircraftIdentification attribute) — field mapping needs adjustment for this message type');
        }
        return;
    }
    const cs = String(rawCallsign).trim().toUpperCase();
    // TEMP — capture SWA2932 specifically: both nasRouteText and expandedRoute together, to
    // check directly whether expandedRoute actually expands a SID/STAR into its real fixes.
    // Bypasses the relevant-callsigns filter just for this one callsign.
    if (cs === 'SWA2932') {
        const route = findAttr(msgObj, 'nasRouteText');
        const expandedRoute = findDeep(msgObj, 'expandedRoute');
        if (route || expandedRoute) {
            try {
                const file = path.join(__dirname, '.swim_swa2932.json');
                let existing = {};
                try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
                if (route) existing.route = route;
                if (expandedRoute) existing.expandedRoute = expandedRoute;
                existing.sid = existing.sid || (findDeep(msgObj, 'adaptedDepartureRoute') ? findAttr(findDeep(msgObj, 'adaptedDepartureRoute'), 'nasRouteIdentifier') : undefined);
                existing.star = existing.star || (findDeep(msgObj, 'nasadaptedArrivalRoute') ? findAttr(findDeep(msgObj, 'nasadaptedArrivalRoute'), 'nasRouteIdentifier') : undefined);
                fs.writeFileSync(file, JSON.stringify(existing, null, 1));
            } catch (_) {}
        }
    }
    if (_relevantCallsigns && !_relevantCallsigns.has(cs)) return; // not a CrewSync-scheduled flight — drop before any further parsing

    // Position is <enRoute><position>...<position xsi:type="...LocationPointType"><location>
    // <pos>LAT LON</pos> — a single space-separated pair, not separate lat/lon tags.
    const posText = textOf(findDeep(msgObj, 'pos'));
    let lat = NaN, lon = NaN;
    if (posText) {
        const parts = String(posText).trim().split(/\s+/).map(Number);
        if (parts.length === 2 && parts.every(n => !isNaN(n))) [lat, lon] = parts;
    }

    const altFt = parseFloat(textOf(findDeep(msgObj, 'altitude')));
    const speedKts = parseFloat(textOf(findDeep(msgObj, 'surveillance'))); // under actualSpeed — first source seen, may need a fallback to other speed-source tags once more message shapes are seen

    // Heading isn't given directly — derived from <trackVelocity><x>/<y> (KNOTS components),
    // seen on a real message. ASSUMED convention (not yet confirmed against the actual map):
    // y = north component, x = east component, giving a standard compass bearing via atan2(x,y).
    // If the plane icon rotates backward/sideways once this is actually on the map, this axis
    // assumption is the first thing to flip.
    let heading = null;
    const trackVel = findDeep(msgObj, 'trackVelocity');
    if (trackVel) {
        const vx = parseFloat(textOf(trackVel.x));
        const vy = parseFloat(textOf(trackVel.y));
        if (!isNaN(vx) && !isNaN(vy) && (vx !== 0 || vy !== 0)) {
            heading = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360;
        }
    }

    const gufi = textOf(findDeep(msgObj, 'gufi'));
    const origin = findAttr(msgObj, 'departurePoint');
    const dest   = findAttr(msgObj, 'arrivalPoint');
    const flightStatus = findAttr(msgObj, 'fdpsFlightStatus'); // e.g. ACTIVE, DROPPED — not yet used for onGround, see file header

    // Filed/current route string — confirmed live on FH-type messages, e.g.
    // "KSLC.DEZRT2.BAM..FMG..LEGGS.BDEGA4.KSFO/0142" (SID, fixes, STAR, destination, elapsed
    // time). Lives at <agreed><route nasRouteText="..."> — only present on some message types
    // (flight-plan updates), so most messages simply won't have it; that's expected, not a bug.
    // A later FH message with a changed nasRouteText represents a real reroute/amendment —
    // not yet specifically tested against a real amendment, but this is the same field that
    // would carry one, so overwriting entry.route below should pick it up automatically.
    const route = findAttr(msgObj, 'nasRouteText');
    const sidEl = findDeep(msgObj, 'adaptedDepartureRoute');
    const starEl = findDeep(msgObj, 'nasadaptedArrivalRoute');
    const sid = sidEl ? findAttr(sidEl, 'nasRouteIdentifier') : null;
    const star = starEl ? findAttr(starEl, 'nasRouteIdentifier') : null;

    // ATC sector handoff — <enRoute><boundaryCrossings><handoff><receivingUnit
    // unitIdentifier="SDA" sectorIdentifier="1D"/><transferringUnit unitIdentifier="ZID"
    // sectorIdentifier="21"/></handoff> — fires each time the aircraft crosses a sector
    // boundary. `receivingUnit` is the unit/sector it's being handed INTO (i.e. who's
    // controlling it now), not `transferringUnit` (who just released it) — read directly off
    // the child object rather than a generic findAttr search, since both units carry the same
    // attribute names and a generic deep search would just return whichever happens to come
    // first in parse order. SFDPS itself has no frequency field anywhere (confirmed against real
    // captured messages) -- just this raw unit+sector identifier. Resolving it to a real
    // frequency is vnas.js's job (server.js's fetchLivePosition wires the two together), not
    // this module's -- kept separate since vnas.js's data source (VATSIM's own public API) is
    // completely unrelated to the SFDPS feed itself.
    const handoff = findDeep(msgObj, 'handoff');
    const recvUnit = handoff?.receivingUnit;
    const sectorUnit = recvUnit ? (recvUnit['@_unitIdentifier'] ?? null) : null;
    const sectorId = recvUnit ? (recvUnit['@_sectorIdentifier'] ?? null) : null;

    const entry = _latest[cs] || (_latest[cs] = {});
    entry.lastMsg = Date.now();
    if (gufi) entry.gufi = gufi;
    if (origin) entry.origin = origin;
    if (dest) entry.dest = dest;
    if (!isNaN(altFt)) entry.altFt = altFt;
    if (!isNaN(speedKts)) entry.speedKts = speedKts;
    if (heading != null) entry.heading = heading;
    if (flightStatus) entry.flightStatus = flightStatus;
    if (route) {
        // The first nasRouteText ever seen for this flight is the originally filed route;
        // anything after that is the current/amended one. Confirmed this is the right model by
        // cross-checking a real flight (VXP331) against swim.vncrcc.org's API, which separately
        // exposes both — its "originalRoute" was the long SID/airway-heavy path, its "route" was
        // a later radial-fix shortcut, exactly what "first seen vs. most recent" would produce.
        // No separate FIXM field needed for this — SwimReader's own docs don't mention one
        // either, so this is almost certainly how any such tool derives the distinction.
        if (!entry.originalRoute) entry.originalRoute = route;
        entry.route = route;
        entry.routeParsed = parseRouteString(route, origin || entry.origin, dest || entry.dest);
        scheduleSave(); // a route-only message (no position yet) must still persist -- see below
    }
    if (sid) entry.sid = sid;
    if (star) entry.star = star;
    if (sectorUnit && sectorId) entry.sector = { unit: sectorUnit, sectorId: String(sectorId) };

    if (!isNaN(lat) && !isNaN(lon)) {
        entry.lat = lat;
        entry.lon = lon;

        if (_watched.has(cs)) {
            entry.trail = entry.trail || [];
            entry.trail.push([lat, lon, Date.now()]);
            if (entry.trail.length > 4000) entry.trail.splice(0, entry.trail.length - 4000);
            scheduleSave();
        }
    }
}

function handleMessage(xmlText) {
    // SFDPS is NATIONWIDE en-route traffic -- every IFR flight over the US, not just the handful
    // CrewSync actually cares about. The real per-flight filter below (_relevantCallsigns) only
    // runs AFTER a message is already fully parsed into a JS object tree, so every single batch
    // paid the full xmlParser.parse() cost regardless of whether it contained anything relevant.
    // Confirmed live: this pegged the production droplet's CPU at 100% and made the server unable
    // to service HTTP requests at all (Node has one event loop; a saturated CPU blocks everything,
    // not just this module). A cheap substring scan of the raw text for any watched callsign,
    // before the real parse, skips the expensive path entirely for the overwhelming majority of
    // batches -- only a tiny fraction of nationwide traffic is ever one of our ~10-15 active
    // flights. Only skips once _relevantCallsigns is actually set; null means the startup grace
    // window before the first poller tick, same fail-open posture as the per-flight filter below.
    if (_relevantCallsigns) {
        let hasRelevant = false;
        for (const cs of _relevantCallsigns) {
            if (xmlText.includes(cs)) { hasRelevant = true; break; }
        }
        if (!hasRelevant) return;
    }

    let parsed;
    try {
        parsed = xmlParser.parse(xmlText);
    } catch (e) {
        if (_unmappedWarnings++ < WARN_CAP) console.warn('[SWIM] XML parse failed:', e.message);
        return;
    }

    // SFDPS carries more than one message family on the same queue — confirmed live, besides
    // FIXM flight messages (<MessageCollection>) it also publishes AIXM airspace/sector
    // reference data (<AIXMBasicMessage>), which has no flight/position content at all. That's
    // expected and silently skipped here, not a parsing failure worth warning about — only an
    // actual <MessageCollection> with an unrecognized shape inside it is.
    const rootKey = Object.keys(parsed).find(k => k !== '?xml');
    if (rootKey !== 'MessageCollection') return;

    const rawMessages = parsed.MessageCollection.message;
    if (rawMessages === undefined) {
        if (_unmappedWarnings++ < WARN_CAP) console.warn('[SWIM] MessageCollection had no <message> entries — shape needs adjustment');
        return;
    }
    const messages = Array.isArray(rawMessages) ? rawMessages : [rawMessages];
    for (const msgObj of messages) processOneMessage(msgObj);
}

function purgeStale() {
    const now = Date.now();
    for (const cs of Object.keys(_latest)) {
        const age = now - (_latest[cs].lastMsg || 0);
        if (_watched.has(cs) && age > PURGE_MS) _watched.delete(cs);
        if (age > LATEST_PURGE_MS) delete _latest[cs];
    }
}
setInterval(purgeStale, 5 * 60 * 1000);

let session = null;
let messageConsumer = null;

// Tracks real connection health, independent of per-callsign staleness. Without this, a
// dropped connection would only be noticed once each cached callsign individually aged past
// STALE_MS (up to 10 minutes) — far too slow for something meant to be live. The moment the
// consumer reports DOWN, every lookup should defer to ADS-B immediately, not wait that out.
let _connected = false;

function connect() {
    if (!SWIM_ENABLED) {
        console.log('[SWIM] SFDPS_* env vars not set — SWIM position feed disabled, ADS-B remains the only live position source');
        return;
    }

    try {
        const factoryProps = new solace.SolclientFactoryProperties();
        factoryProps.profile = solace.SolclientFactoryProfiles.version10;
        solace.SolclientFactory.init(factoryProps);
        solace.SolclientFactory.setLogLevel(solace.LogLevel.WARN);
    } catch (e) {
        console.error('[SWIM] Solace factory init failed — ADS-B remains the live position source:', e.message);
        return;
    }

    try {
        session = solace.SolclientFactory.createSession({
            url: SFDPS_HOST,
            vpnName: SFDPS_VPN,
            userName: SFDPS_USER,
            password: SFDPS_PASS,
            connectRetries: 5,
            reconnectRetries: -1, // keep retrying indefinitely — a dropped session shouldn't need a server restart
        });
    } catch (e) {
        console.error('[SWIM] session creation failed — ADS-B remains the live position source:', e.message);
        return;
    }

    session.on(solace.SessionEventCode.UP_NOTICE, () => {
        console.log('[SWIM] SFDPS session up, binding to queue', SFDPS_QUEUE);
        startConsumer();
    });
    session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
        console.error('[SWIM] SFDPS connect failed — ADS-B remains the live position source:', e?.message || e);
    });
    session.on(solace.SessionEventCode.DISCONNECTED, () => {
        console.warn('[SWIM] SFDPS session disconnected — ADS-B is now the live position source until it recovers');
        _connected = false;
    });

    try {
        session.connect();
    } catch (e) {
        console.error('[SWIM] session.connect() threw — ADS-B remains the live position source:', e.message);
    }
}

function startConsumer() {
    try {
        messageConsumer = session.createMessageConsumer({
            queueDescriptor: { name: SFDPS_QUEUE, type: solace.QueueType.QUEUE },
            acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
        });
    } catch (e) {
        console.error('[SWIM] message consumer creation failed:', e.message);
        return;
    }

    messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
        console.log('[SWIM] message consumer up — live SFDPS messages flowing');
        _connected = true;
    });
    messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (e) => {
        console.error('[SWIM] consumer connect failed — ADS-B remains the live position source:', e?.message || e);
        _connected = false;
    });
    messageConsumer.on(solace.MessageConsumerEventName.DOWN, () => {
        console.warn('[SWIM] message consumer down — ADS-B is now the live position source until it recovers');
        _connected = false;
    });

    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
        try {
            // Confirmed live: SFDPS sends the FIXM payload as the message's XML content part,
            // not the generic binary attachment (getBinaryAttachment() returns null for these).
            const xmlText = message.getXmlContent();
            if (xmlText) handleMessage(xmlText);
        } catch (e) {
            if (_unmappedWarnings++ < WARN_CAP) console.warn('[SWIM] message handling error:', e.message);
        } finally {
            try { message.acknowledge(); } catch (_) {}
        }
    });

    try {
        messageConsumer.connect();
    } catch (e) {
        console.error('[SWIM] messageConsumer.connect() threw:', e.message);
    }
}

// Same response shape fetchAdsbPosition()/parseAdsbAircraft() already produce in server.js,
// so the rest of the live-tracking pipeline doesn't need to know which source answered.
function getSwimPosition(callsign) {
    if (!_connected) return null; // connection down — defer to ADS-B immediately, don't wait for per-callsign staleness
    const cs = String(callsign || '').trim().toUpperCase();
    if (!cs) return null;
    // setRelevantCallsigns() is the real trigger now (trail starts ~30min before departure,
    // whether or not a client ever asks). This is just a fallback for a callsign asked about
    // outside that set for some reason — harmless, Set.add() is idempotent either way.
    _watched.add(cs);

    const f = _latest[cs];
    if (!f) return null;
    const hasPosition = f.lat != null && f.lon != null && (Date.now() - (f.lastMsg || 0) <= STALE_MS);
    if (!hasPosition) {
        // No live position yet -- normal preflight, before an aircraft is airborne/squawking.
        // Still surface a filed route if SFDPS has already sent one (flight-plan messages can
        // arrive well before a position report -- see setRelevantCallsigns()'s widened lookahead
        // window), so the frontend can draw the planned route ahead of departure. `found: false`
        // still correctly tells callers there's no live position to track.
        if (!f.route) return null;
        return {
            found: false,
            hasRoute: true,
            route: f.route ?? null,
            originalRoute: f.originalRoute ?? null,
            origin: f.origin ?? null,
            dest: f.dest ?? null,
            routeParsed: f.routeParsed ?? null,
            sid: f.sid ?? null,
            star: f.star ?? null,
            sector: f.sector ?? null,
            source: 'swim',
        };
    }

    return {
        found: true,
        lat: f.lat,
        lon: f.lon,
        altFt: f.altFt ?? null,
        speedKts: f.speedKts ?? null,
        onGround: false,  // not yet mapped from FIXM — see file header
        heading: f.heading ?? null, // derived from trackVelocity x/y — axis convention unverified, see processOneMessage
        trail: f.trail || [],
        hadTrail: !!(f.trail && f.trail.length),
        parked: false,
        route: f.route ?? null, // current route string (reflects amendments) — e.g. "KSLC.DEZRT2.BAM..FMG..LEGGS.BDEGA4.KSFO/0142"
        originalRoute: f.originalRoute ?? null, // first route string ever seen for this flight — the as-filed route before any amendments
        origin: f.origin ?? null,
        dest: f.dest ?? null,
        routeParsed: f.routeParsed ?? null, // ordered waypoint list with type tags — see parseRouteString(); names only, not yet resolved to coordinates
        sid: f.sid ?? null,
        star: f.star ?? null,
        sector: f.sector ?? null, // "ZID-21" style unit+sector identifier from the most recent handoff — see processOneMessage
        source: 'swim',
    };
}

loadStateCache();

// STDDS surface tracks (stdds.js) often carry a GUFI but no callsign — most ASDE-X surface
// contacts start anonymous until correlated to a flight plan. SFDPS already gives us GUFI per
// callsign, so this reverse lookup is how stdds.js attributes an anonymous surface track back
// to one of CrewSync's own pilots. _latest is already filtered to just relevant callsigns, so
// a linear scan here is cheap — no separate reverse index needed.
function callsignForGufi(gufi) {
    if (!gufi) return null;
    for (const [cs, f] of Object.entries(_latest)) {
        if (f.gufi === gufi) return cs;
    }
    return null;
}

// TEMP — manually seeds route data for a callsign, going through the same parseRouteString()
// used for real messages, to let the map-rendering pipeline be tested with a known real route
// without waiting on the live feed to happen to send one for this specific flight. Does not
// touch position/lat/lon — only useful if the callsign is already being live-tracked.
function _testSeedRoute(callsign, routeText, origin, dest) {
    const cs = String(callsign).trim().toUpperCase();
    const entry = _latest[cs];
    if (!entry) return false;
    if (!entry.originalRoute) entry.originalRoute = routeText;
    entry.route = routeText;
    entry.routeParsed = parseRouteString(routeText, origin || entry.origin, dest || entry.dest);
    return true;
}

// TEMP — like _testSeedRoute, but CREATES the entry outright (position included) instead of
// requiring a real flight already being live-tracked. Lets the frontend/map-rendering pipeline be
// exercised on demand for a fully synthetic test flight — no need to find a real aircraft
// currently airborne on a route that happens to exercise whatever's being tested (e.g. a specific
// STAR runway leg).
function _testSeedFlight(callsign, { lat, lon, altFt, speedKts, heading, route, origin, dest }) {
    const cs = String(callsign).trim().toUpperCase();
    const entry = _latest[cs] || (_latest[cs] = {});
    entry.lastMsg = Date.now();
    if (lat != null) entry.lat = lat;
    if (lon != null) entry.lon = lon;
    if (altFt != null) entry.altFt = altFt;
    if (speedKts != null) entry.speedKts = speedKts;
    if (heading != null) entry.heading = heading;
    if (origin) entry.origin = origin;
    if (dest) entry.dest = dest;
    if (route) {
        if (!entry.originalRoute) entry.originalRoute = route;
        entry.route = route;
        entry.routeParsed = parseRouteString(route, origin || entry.origin, dest || entry.dest);
    }
    return true;
}

module.exports = { connect, getSwimPosition, setRelevantCallsigns, callsignForGufi, _testSeedRoute, _testSeedFlight, isEnabled: () => SWIM_ENABLED };
