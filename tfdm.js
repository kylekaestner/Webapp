// tfdm.js — FAA SWIM TFDM (Terminal Flight Data Manager) feed.
//
// Why this one, on top of SFDPS/STDDS/TFMS: navdata.js's NASR-based SID/STAR resolution has a
// real, confirmed gap — a procedure like AARCH2 (STL) can have multiple runway-specific body
// segments (AARCH-BUELL for RWY 11/12L/12R vs AARCH-FDRKO for RWY 29/30L/30R) and the resolver
// just picks whichever body happens to come first in NASR's own CSV row order, with zero actual
// runway awareness. TFDM is the FAA's terminal/surface automation system and is the one real
// place a per-flight ASSIGNED runway should show up (confirmed conceptually via a public
// reference implementation, f03809/swim-tfdm-consumer on GitHub, which documents `departure`/
// `arrival` blocks each carrying a `runway` field for a TFDM flight record — that repo consumes
// a re-published Kafka/JSON distribution, not the raw FAA SWIM XML this module connects to
// directly, so its field names are a hypothesis for what to look for, not a guarantee of this
// feed's actual shape).
//
// Field mapping below is UNVERIFIED against a live message — same starting point every other
// module in this file began at (see swim.js/stdds.js/tfms.js's own header comments). This module
// starts in diagnostic mode: dump real messages to inspect the actual schema before trusting any
// specific field name. Expect correction once connected.
//
// CPU lesson learned the hard way with swim.js (see its handleMessage comment for the full
// incident writeup): a nationwide/terminal-wide SWIM feed delivers everything on the queue
// regardless of relevance, and full XML parsing of every message before filtering can peg a small
// droplet's CPU. This module applies the same cheap substring pre-filter from the start, not as
// an afterthought.

const solace = require('solclientjs');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

const TFDM_HOST  = process.env.TFDM_HOST;
const TFDM_VPN   = process.env.TFDM_VPN;
const TFDM_USER  = process.env.TFDM_USER;
const TFDM_PASS  = process.env.TFDM_PASS;
const TFDM_QUEUE = process.env.TFDM_QUEUE;

const TFDM_ENABLED = !!(TFDM_HOST && TFDM_VPN && TFDM_USER && TFDM_PASS && TFDM_QUEUE);

// Diagnostic mode: dump the first N raw messages (and N more that match a relevant callsign, once
// any are being watched) to disk for schema inspection, then stop dumping. Not gated behind any
// env flag — this is a one-time, local-only exploration aid, cheap to leave on, and automatically
// stops itself once it's collected enough samples.
const DUMP_DIR = path.join(__dirname, 'scratch', 'tfdm-samples');
let _dumpCount = 0;
const DUMP_CAP = 25;
let _debugSingleCaptured = false; // see handleMessage()'s one-off EJA815 capture
function dumpSample(xmlText) {
    if (_dumpCount >= DUMP_CAP) return;
    try {
        fs.mkdirSync(DUMP_DIR, { recursive: true });
        fs.writeFileSync(path.join(DUMP_DIR, `sample-${Date.now()}-${_dumpCount}.xml`), xmlText);
        _dumpCount++;
        if (_dumpCount === DUMP_CAP) console.log(`[TFDM] collected ${DUMP_CAP} raw sample messages in ${DUMP_DIR} — inspect these to confirm real field names`);
    } catch (e) {
        console.warn('[TFDM] sample dump failed:', e.message);
    }
}

let _connected = false;
let _relevantCallsigns = null; // same pattern as swim.js/stdds.js/tfms.js
// callsign -> Set<scheduledDepUTCms> -- see setRelevantCallsigns()/isExpectedDay() below, same
// mechanism and same reason as tfms.js's own copy of this (see its header comment for the real
// incident: a recurring flight number's NEXT calendar day's pre-departure record overwriting
// today's already-completed flight's evidence here too, via offBlockTime).
let _relevantDepTimes = new Map();

// callsign -> { depRunway, arrRunway, flightState, lastMsg, raw }
const _latest = {};

// callsign -> Map(legKey -> { origin, dest, offBlockTime (ISO), scheduledDepMs, state, depRunway,
// arrRunway, departureDelayMin, lastMsg }) -- a NetJets-shape callsign can carry several of these
// alive at once (the whole day's remaining legs filed/amended concurrently under one callsign,
// confirmed live via the NetJets research log: EJA458 alternated between a KPVU->KLAS 20:36Z
// record and an F70->KLAS 23:00Z record message-to-message for over an hour). _latest above is a
// flat single-record cache and gets clobbered by whichever message arrived last -- correct for
// every other pilot (a real flight number's legs are sequential, never concurrent, per the
// origin/dest-changed reset in processOneMessage below) but wrong for NetJets, which is exactly
// what corrupted a real auto-created segment's times (see CLAUDE.md). Purely additive: _latest/
// getFlightInfo() are untouched, so nothing already depending on them changes behavior.
const _legs = {};
const LEG_STALE_MS = 48 * 60 * 60 * 1000; // longer than _latest's 1h -- a future leg's plan is exactly what this exists to keep around
function legKey(origin, dest) { return (origin && dest) ? `${origin}>${dest}` : null; }

// Persisted to disk, same reasoning and pattern as tfms.js's own _flightTimes cache (and this
// module's/server.js's pre-existing parked/airborne caches): in-memory only would mean a
// `pm2 restart` (which happens on every server.js/tfdm.js/tfms.js deploy) throws away whatever
// future legs had already been filed ahead -- exactly the "forward schedule" value this store
// exists to provide. A Map doesn't JSON-serialize on its own, so the save/load round-trips
// through plain [key, leg] entry arrays.
const LEGS_CACHE_PATH = path.join(__dirname, '.tfdm_legs_cache.json');
try {
    const saved = JSON.parse(fs.readFileSync(LEGS_CACHE_PATH, 'utf8'));
    const now = Date.now();
    for (const [cs, entries] of Object.entries(saved)) {
        const map = new Map();
        for (const [key, leg] of entries) {
            if (now - (leg.lastMsg || 0) <= LEG_STALE_MS) map.set(key, leg);
        }
        if (map.size) _legs[cs] = map;
    }
} catch (_) {}
let _legsSaveTimer = null;
function scheduleLegsSave() {
    if (_legsSaveTimer) return;
    _legsSaveTimer = setTimeout(() => {
        _legsSaveTimer = null;
        const out = {};
        for (const [cs, map] of Object.entries(_legs)) out[cs] = [...map.entries()];
        try { fs.writeFileSync(LEGS_CACHE_PATH, JSON.stringify(out)); } catch (_) {}
    }, 2000);
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

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
function findAttr(obj, attrName) { return findDeep(obj, '@_' + attrName); }
function textOf(val) {
    if (val == null) return undefined;
    if (typeof val === 'object') return val['#text'];
    return val;
}

// TEMPORARY (added 2026-10-30, remove once the NetJets same-callsign-all-day filing
// investigation is done): treats every real EJA callsign as relevant, not just the handful
// server.js explicitly lists. Deliberately NOT implemented by enumerating hundreds of individual
// tails into _relevantCallsigns -- that would turn the cheap per-message substring pre-filter in
// handleMessage() (a loop over every relevant callsign, checked against every message TFDM
// delivers nationwide) into an O(hundreds) cost per message, the exact CPU mistake swim.js's own
// handleMessage comment documents a real past incident over. A single `includes('EJA')` check is
// O(1) regardless of how many individual tails this ends up covering.
const NETJETS_RESEARCH_MODE = true;
function _isResearchRelevant(cs) { return NETJETS_RESEARCH_MODE && /^EJA\d+$/.test(cs); }

// Dedicated log file (not pm2's general console output) so the investigation's own volume
// doesn't bury or get buried by normal app logs, and only written ON CHANGE per callsign (not
// every repeated message -- a flight sends position/plan updates every few seconds to minutes,
// and this now potentially covers the whole active NetJets fleet, not one or two watched tails).
const _NETJETS_RESEARCH_LOG_PATH = path.join(__dirname, '.netjets_research.log');
const _netjetsResearchLastSig = new Map(); // callsign -> last-logged detail string
function _netjetsResearchLog(source, cs, detail) {
    const key = `${source}|${cs}`;
    if (_netjetsResearchLastSig.get(key) === detail) return;
    _netjetsResearchLastSig.set(key, detail);
    try {
        fs.appendFileSync(_NETJETS_RESEARCH_LOG_PATH, `${new Date().toISOString()} [${source}] ${cs} ${detail}\n`);
    } catch (_) {}
}

function setRelevantCallsigns(input) {
    // Accepts either a plain Set/array of callsign strings (no day-check) or a
    // Map<callsign, Iterable<number|Date|string>> of known scheduled departure time(s) -- see
    // tfms.js's identical setRelevantCallsigns() for the full reasoning, shared verbatim here.
    if (input instanceof Map) {
        _relevantCallsigns = new Set(input.keys());
        _relevantDepTimes = new Map();
        for (const [cs, times] of input) {
            const set = new Set();
            for (const t of times) {
                const ms = t instanceof Date ? t.getTime() : (typeof t === 'number' ? t : new Date(t).getTime());
                if (!isNaN(ms)) set.add(ms);
            }
            if (set.size) _relevantDepTimes.set(cs, set);
        }
    } else {
        _relevantCallsigns = input instanceof Set ? input : new Set(input || []);
        _relevantDepTimes = new Map();
    }
    for (const cs of Object.keys(_latest)) {
        if (!_relevantCallsigns.has(cs) && !_isResearchRelevant(cs)) delete _latest[cs];
    }
    for (const cs of Object.keys(_legs)) {
        if (!_relevantCallsigns.has(cs) && !_isResearchRelevant(cs)) delete _legs[cs];
    }
}

const DAY_CHECK_TOLERANCE_MS = 16 * 60 * 60 * 1000; // same tolerance and reasoning as tfms.js
function isExpectedDay(cs, candidateMs) {
    if (candidateMs == null) return true;
    const expected = _relevantDepTimes.get(cs);
    if (!expected || !expected.size) return true;
    for (const t of expected) if (Math.abs(candidateMs - t) <= DAY_CHECK_TOLERANCE_MS) return true;
    return false;
}

let _unmappedWarnings = 0;
const WARN_CAP = 20;

// CONFIRMED against 25 real messages (scratch/tfdm-samples/, 2026-10-02) -- root is
// <nas:NasMessage>, with <nas:flight xsi:type="nas:TfdmFlightType"> containing <fx:departure>/
// <fx:arrival> blocks, each carrying the same three-tier runway structure below. Both ends are
// mapped here since the real captured samples show arrival carries the identical
// runwayAssigned/runwayPredicted/runwayActual shape that departure does.
//
// Three runway fields, by confidence (prefer the first one present):
//   runwayActual    -- confirmed, the aircraft is physically on this runway now (rare/late signal)
//   runwayAssigned  -- controller-assigned via STARS/TFDM automation (the one we actually want for
//                      picking the right NASR STAR body -- this is what was missing before)
//   runwayPredicted -- TFDM's own best-guess prediction, lowest confidence
// Each is its own element with a `runwayDesignator` attribute, not a plain-text field.
function extractCallsign(flight) {
    const v = findAttr(flight.flightIdentification, 'aircraftIdentification');
    return v ? String(v).trim().toUpperCase() : null;
}
function extractRunway(block) {
    if (!block) return null;
    return findAttr(block.runwayActual, 'runwayDesignator')
        || findAttr(block.runwayAssigned, 'runwayDesignator')
        || findAttr(block.runwayPredicted, 'runwayDesignator')
        || null;
}

// Confirmed in scratch/tfdm-samples/ (2026-10-31, re-checked while chasing why EJA815 -- a real
// NetJets leg TFDM already shows SCHEDULED with a real offBlockTime -- had no arrival estimate
// anywhere: TFMS simply hadn't filed a flight plan for it yet, the only place this app's eta
// field came from before this). TFDM's own arrival block carries
// <nas:runwayArrivalTime><nas:estimated source="TFDM"|"TFMS"><nas:time>...</nas:time></nas:estimated></nas:runwayArrivalTime>
// -- a real estimated runway-arrival time, sometimes computed by TFDM itself (source="TFDM"),
// sometimes just relayed from TFMS (source="TFMS"). The departure side carries the identical
// shape under runwayDepartureTime. No separate <actual> sibling was ever found in any sample --
// once the real event happens, the "estimated" value itself converges to match (confirmed: a
// landed flight's runwayArrivalTime.estimated.time lines up with its own runwayActual
// timestamp), so there's no actual/estimated tier to pick between here the way the runway
// designator fields above have.
function extractRunwayTime(block, fieldName) {
    const node = block?.[fieldName]?.estimated;
    if (!node) return null;
    const iso = textOf(node.time);
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? null : d.toISOString();
}

// ISO 8601 duration, the only shape TFDM actually uses for these fields (confirmed against real
// messages: always "PT" + optional H/M/S, e.g. "PT7M", "PT0S", never a larger unit). Returns
// minutes (fractional for a seconds-only duration like "PT0S" -> 0), or null if unparseable.
function parseIsoDurationMinutes(s) {
    if (!s) return null;
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(s).trim());
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    return (parseInt(m[1] || 0, 10) * 60) + parseInt(m[2] || 0, 10) + (parseInt(m[3] || 0, 10) / 60);
}

function processOneMessage(msgObj) {
    const flight = msgObj.flight;
    if (!flight) return;
    const cs = extractCallsign(flight);
    if (!cs) {
        if (_unmappedWarnings++ < WARN_CAP) console.warn('[TFDM] flight had no aircraftIdentification attribute — check scratch/tfdm-samples/ for a shape change');
        return;
    }
    if (_relevantCallsigns && !_relevantCallsigns.has(cs) && !_isResearchRelevant(cs)) return;

    const departure = flight.departure;
    const arrival = flight.arrival;
    // Reject a message describing a different calendar-day instance of a recurring flight number
    // (see isExpectedDay()'s header comment) before any of it gets merged into _latest -- the
    // origin/dest-based reset below only catches a genuinely DIFFERENT route on the same
    // callsign, not the identical route flown again tomorrow, which is exactly this failure mode.
    const offBlockIso = textOf(departure?.offBlockTime?.initial);
    const scheduledDepMs = offBlockIso ? (d => isNaN(d) ? null : d.getTime())(new Date(offBlockIso)) : null;
    // TEMPORARY research trace (added 2026-10-30, remove once the NetJets same-callsign
    // investigation is done). Logs every raw TFDM message for ANY EJA callsign BEFORE
    // isExpectedDay() has a chance to reject anything, specifically to see whether a message's
    // own offBlockTime ever points at a different calendar day than today -- but only ON CHANGE
    // (see _netjetsResearchLog()), not every repeated message, to keep log volume sane now that
    // this covers the whole NetJets fleet rather than one or two watched tails.
    if (_isResearchRelevant(cs)) {
        const dayGapHrs = scheduledDepMs != null ? ((scheduledDepMs - Date.now()) / 3600000).toFixed(1) : '-';
        _netjetsResearchLog('TFDM', cs, `offBlockTime=${offBlockIso || '-'} (${dayGapHrs}h from now) origin=${departure ? findAttr(departure, 'departurePointText') : '-'} dest=${arrival ? findAttr(arrival, 'destinationPointText') : '-'} state=${findAttr(flight.flightStatus?.tfdmFlightState, 'value') || '-'}`);
    }
    if (!isExpectedDay(cs, scheduledDepMs)) return;
    const origin = departure ? findAttr(departure, 'departurePointText') : null;
    const dest = arrival ? findAttr(arrival, 'destinationPointText') : null;
    const depRunway = extractRunway(departure);
    const arrRunway = extractRunway(arrival);
    const flightState = findAttr(flight.flightStatus?.tfdmFlightState, 'value');
    // Confirmed real in scratch/tfdm-samples/ (2026-10-31 audit) -- a flight-level field (not
    // nested under departure/arrival, hence findDeep over the whole flight object rather than a
    // specific block), corroborated by a second field on the same real flight
    // (departure.smpExemptionReason = "DIVERSION_RECOVERY" on SKW487W, which had diverted into
    // KDEN and was recovering). Genuinely new, app-wide-useful context -- a flight flagged this
    // way is in a very different situation than an ordinary delay.
    const isDiversion = textOf(findDeep(flight, 'diversionRecoveryIndicator')) === 'DIVERSION_RECOVERY';
    // Real departure-delay insight, straight from the FAA's own surface-management system --
    // requested directly: the uploaded schedule stays the source of truth for when a flight is
    // SUPPOSED to depart/land (never overwritten with real times), but TFDM already knows when a
    // flight is actually running late (e.g. a long ORD ground/taxi delay) and this is exactly
    // that number, not a guess. <nas:departureDelay> carries three ISO-8601-duration fields —
    // prefer actualDelay (confirmed, populated once real departure timing is known) over
    // currentDelay (TFDM's live best-estimate before that), same "prefer the more confirmed
    // value" pattern as the three-tier runway fields above. predictedDelay (forward-looking, pre-
    // departure) isn't used here -- actual/current are the "how late did/is it actually run"
    // signals this feature is about, not a prediction.
    const delayBlock = departure?.departureDelay;
    const actualDelayMin = delayBlock ? parseIsoDurationMinutes(textOf(delayBlock.actualDelay)) : null;
    const currentDelayMin = delayBlock ? parseIsoDurationMinutes(textOf(delayBlock.currentDelay)) : null;
    // See extractRunwayTime()'s own comment -- TFDM's own estimated runway arrival/departure
    // time, independent of whether TFMS has a filed flight plan yet.
    const estArrivalTime = extractRunwayTime(arrival, 'runwayArrivalTime');
    const estDepartureTime = extractRunwayTime(departure, 'runwayDepartureTime');

    const entry = _latest[cs] || (_latest[cs] = {});
    entry.lastMsg = Date.now();
    // A flight NUMBER (and therefore callsign) commonly continues through several legs in one
    // rotation -- e.g. a Southwest flight flying BOI->PHX->STL all under the same number. Confirmed
    // live: SWA3492 showed a stale KBOI->KPHX/AT_STAND record from an earlier completed leg while
    // the aircraft was already airborne cruising PHX->STL per the real live position, because
    // nothing ever reset depRunway/arrRunway/flightState/departureDelayMin between legs -- a
    // changed origin OR dest from what's already cached is an unambiguous "this is a new leg"
    // signal (same reasoning as swim.js's _hexToCallsign reset on a changed callsign), so those
    // leg-specific fields are cleared before applying this message's own values, rather than
    // merging indefinitely across legs like a single multi-message flight would need.
    if ((origin && entry.origin && origin !== entry.origin) || (dest && entry.dest && dest !== entry.dest)) {
        entry.depRunway = null; entry.arrRunway = null; entry.flightState = null; entry.departureDelayMin = null;
        entry.estArrivalTime = null; entry.estDepartureTime = null; entry.isDiversion = false;
    }
    // Merge, don't clobber -- a FlightUpdate is a partial/delta message (confirmed live: most
    // updates carry neither runway field at all), so a later message missing a value must not
    // erase one already learned from an earlier message within the SAME leg.
    if (origin) entry.origin = origin;
    if (dest) entry.dest = dest;
    if (depRunway) entry.depRunway = depRunway;
    if (arrRunway) entry.arrRunway = arrRunway;
    if (flightState) entry.flightState = flightState;
    if (actualDelayMin != null) entry.departureDelayMin = actualDelayMin;
    else if (currentDelayMin != null) entry.departureDelayMin = currentDelayMin;
    if (estArrivalTime) entry.estArrivalTime = estArrivalTime;
    if (estDepartureTime) entry.estDepartureTime = estDepartureTime;
    if (isDiversion) entry.isDiversion = true;

    // Per-leg record, additive -- see _legs's header comment above. Keyed by origin+dest, which
    // TFDM gives fully resolved on every message (no route-string guessing needed), so two
    // concurrently-filed legs for the same callsign land in separate entries instead of one
    // clobbering the other. Scoped to NetJets (EJA) callsigns only via _isResearchRelevant() --
    // this store (and its disk persistence) exists purely to solve NetJets' same-callsign
    // concurrent-leg filing problem, so every other pilot's tracked flight (covered by the same
    // _relevantCallsigns set that gates _latest above) has no reason to pay for it.
    const lk = _isResearchRelevant(cs) ? legKey(origin, dest) : null;
    if (lk) {
        const legsMap = _legs[cs] || (_legs[cs] = new Map());
        const leg = legsMap.get(lk) || { origin, dest };
        leg.lastMsg = Date.now();
        if (offBlockIso) { leg.offBlockTime = offBlockIso; leg.scheduledDepMs = scheduledDepMs; }
        if (depRunway) leg.depRunway = depRunway;
        if (arrRunway) leg.arrRunway = arrRunway;
        if (flightState) leg.flightState = flightState;
        if (actualDelayMin != null) leg.departureDelayMin = actualDelayMin;
        else if (currentDelayMin != null) leg.departureDelayMin = currentDelayMin;
        if (estArrivalTime) leg.estArrivalTime = estArrivalTime;
        if (estDepartureTime) leg.estDepartureTime = estDepartureTime;
        if (isDiversion) leg.isDiversion = true;
        legsMap.set(lk, leg);
        scheduleLegsSave();
    }
}

function handleMessage(xmlText) {
    // Same cheap pre-filter as swim.js/stdds.js/tfms.js -- see swim.js's handleMessage comment
    // for the production incident this exists to prevent. Skipped only once _relevantCallsigns is
    // actually set; null means the startup grace window, same as every other feed here.
    if (_relevantCallsigns) {
        let hasRelevant = NETJETS_RESEARCH_MODE && xmlText.includes('EJA');
        if (!hasRelevant) for (const cs of _relevantCallsigns) {
            if (xmlText.includes(cs)) { hasRelevant = true; break; }
        }
        if (!hasRelevant && _dumpCount >= DUMP_CAP) return;
    }

    dumpSample(xmlText);
    // TEMPORARY -- one-off capture for a specific callsign on request, since the general
    // dumpSample() cap (25) was reached long before EJA815 was ever relevant. Remove once no
    // longer needed.
    if (xmlText.includes('EJA815') && !_debugSingleCaptured) {
        try { fs.writeFileSync(path.join(__dirname, '.eja815_debug.xml'), xmlText); _debugSingleCaptured = true; } catch (_) {}
    }

    let parsed;
    try {
        parsed = xmlParser.parse(xmlText);
    } catch (e) {
        if (_unmappedWarnings++ < WARN_CAP) console.warn('[TFDM] XML parse failed:', e.message);
        return;
    }

    // CONFIRMED shape (see processOneMessage's header comment): root is always a single
    // <nas:NasMessage>, one flight per message -- unlike SFDPS/TFMS, TFDM doesn't batch many
    // flights into one Solace message. metadata.messageType is FlightAdd/FlightUpdate/FlightDelete;
    // all three carry the same <flight> shape (a delete doesn't need special handling here --
    // its entry just ages out naturally via purgeStale once no further updates arrive for it).
    const msg = parsed.NasMessage;
    if (!msg) return;
    processOneMessage(msg);
}

function purgeStale() {
    const now = Date.now();
    const STALE_MS = 60 * 60 * 1000; // runway assignment changes slowly; keep longer than position data
    for (const cs of Object.keys(_latest)) {
        if (now - (_latest[cs].lastMsg || 0) > STALE_MS) delete _latest[cs];
    }
    let legsChanged = false;
    for (const cs of Object.keys(_legs)) {
        const legsMap = _legs[cs];
        for (const [k, leg] of legsMap) {
            if (now - (leg.lastMsg || 0) > LEG_STALE_MS) { legsMap.delete(k); legsChanged = true; }
        }
        if (legsMap.size === 0) delete _legs[cs];
    }
    if (legsChanged) scheduleLegsSave();
}
setInterval(purgeStale, 5 * 60 * 1000);

let session = null;
let messageConsumer = null;

function connect() {
    if (!TFDM_ENABLED) {
        console.log('[TFDM] TFDM_* env vars not set — runway-assignment data disabled');
        return;
    }

    try {
        const factoryProps = new solace.SolclientFactoryProperties();
        factoryProps.profile = solace.SolclientFactoryProfiles.version10;
        if (!solace.SolclientFactory._crewsyncInitDone) {
            solace.SolclientFactory.init(factoryProps);
            solace.SolclientFactory.setLogLevel(solace.LogLevel.WARN);
            solace.SolclientFactory._crewsyncInitDone = true;
        }
    } catch (e) {
        console.error('[TFDM] Solace factory init failed:', e.message);
        return;
    }

    try {
        session = solace.SolclientFactory.createSession({
            url: TFDM_HOST,
            vpnName: TFDM_VPN,
            userName: TFDM_USER,
            password: TFDM_PASS,
            connectRetries: 5,
            reconnectRetries: -1,
        });
    } catch (e) {
        console.error('[TFDM] session creation failed:', e.message);
        return;
    }

    session.on(solace.SessionEventCode.UP_NOTICE, () => {
        console.log('[TFDM] session up, binding to queue', TFDM_QUEUE);
        startConsumer();
    });
    session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
        console.error('[TFDM] connect failed:', e?.message || e);
    });
    session.on(solace.SessionEventCode.DISCONNECTED, () => {
        console.warn('[TFDM] session disconnected');
        _connected = false;
    });

    try {
        session.connect();
    } catch (e) {
        console.error('[TFDM] session.connect() threw:', e.message);
    }
}

function startConsumer() {
    try {
        messageConsumer = session.createMessageConsumer({
            queueDescriptor: { name: TFDM_QUEUE, type: solace.QueueType.QUEUE },
            acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
        });
    } catch (e) {
        console.error('[TFDM] message consumer creation failed:', e.message);
        return;
    }

    messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
        console.log('[TFDM] message consumer up — live TFDM messages flowing');
        _connected = true;
    });
    messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (e) => {
        console.error('[TFDM] consumer connect failed:', e?.message || e);
        _connected = false;
    });
    messageConsumer.on(solace.MessageConsumerEventName.DOWN, () => {
        console.warn('[TFDM] message consumer down');
        _connected = false;
    });

    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
        try {
            const xmlText = message.getXmlContent();
            if (xmlText) handleMessage(xmlText);
        } catch (e) {
            if (_unmappedWarnings++ < WARN_CAP) console.warn('[TFDM] message handling error:', e.message);
        } finally {
            try { message.acknowledge(); } catch (_) {}
        }
    });

    try {
        messageConsumer.connect();
    } catch (e) {
        console.error('[TFDM] messageConsumer.connect() threw:', e.message);
    }
}

// Returns everything known for a callsign -- runway assignments (the original reason this
// module exists), plus flightState and departureDelayMin now too. Kept as one function/one entry
// object rather than splitting into separate getters since it's all the same underlying TFDM
// FlightUpdate stream for one flight; callers just read whichever fields they need.
function getFlightInfo(callsign) {
    const cs = String(callsign || '').trim().toUpperCase();
    return _latest[cs] || null;
}

// All currently-known distinct legs for a callsign, sorted by scheduled departure ascending --
// the per-leg counterpart to getFlightInfo() above. See _legs's header comment: this is what
// proves a NetJets callsign's later-filed legs are retrievable intact, not just whichever one
// _latest happened to hold most recently.
function getAllLegs(callsign) {
    const cs = String(callsign || '').trim().toUpperCase();
    const legsMap = _legs[cs];
    if (!legsMap) return [];
    return [...legsMap.entries()]
        .map(([key, leg]) => ({ key, ...leg }))
        .sort((a, b) => (a.scheduledDepMs || 0) - (b.scheduledDepMs || 0));
}

// TEMP — same purpose as swim.js's _testSeedFlight: injects a synthetic runway assignment for a
// test callsign so the pickBody() runway-matching logic in navdata.js can be exercised on demand
// (e.g. forcing AARCH2's BUELL vs FDRKO leg) without waiting for TFDM to happen to report a real
// assignment for whatever flight is being tested.
function _testSeedRunway(callsign, { depRunway, arrRunway } = {}) {
    const cs = String(callsign).trim().toUpperCase();
    const entry = _latest[cs] || (_latest[cs] = {});
    entry.lastMsg = Date.now();
    if (depRunway) entry.depRunway = depRunway;
    if (arrRunway) entry.arrRunway = arrRunway;
    return true;
}

module.exports = { connect, getFlightInfo, getAllLegs, setRelevantCallsigns, _testSeedRunway, isEnabled: () => TFDM_ENABLED };
