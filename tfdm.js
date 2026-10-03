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

// callsign -> { depRunway, arrRunway, flightState, lastMsg, raw }
const _latest = {};

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

function setRelevantCallsigns(set) {
    _relevantCallsigns = set instanceof Set ? set : new Set(set || []);
    for (const cs of Object.keys(_latest)) {
        if (!_relevantCallsigns.has(cs)) delete _latest[cs];
    }
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
    if (_relevantCallsigns && !_relevantCallsigns.has(cs)) return;

    const departure = flight.departure;
    const arrival = flight.arrival;
    const origin = departure ? findAttr(departure, 'departurePointText') : null;
    const dest = arrival ? findAttr(arrival, 'destinationPointText') : null;
    const depRunway = extractRunway(departure);
    const arrRunway = extractRunway(arrival);
    const flightState = findAttr(flight.flightStatus?.tfdmFlightState, 'value');
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
}

function handleMessage(xmlText) {
    // Same cheap pre-filter as swim.js/stdds.js/tfms.js -- see swim.js's handleMessage comment
    // for the production incident this exists to prevent. Skipped only once _relevantCallsigns is
    // actually set; null means the startup grace window, same as every other feed here.
    if (_relevantCallsigns) {
        let hasRelevant = false;
        for (const cs of _relevantCallsigns) {
            if (xmlText.includes(cs)) { hasRelevant = true; break; }
        }
        if (!hasRelevant && _dumpCount >= DUMP_CAP) return;
    }

    dumpSample(xmlText);

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

module.exports = { connect, getFlightInfo, setRelevantCallsigns, _testSeedRunway, isEnabled: () => TFDM_ENABLED };
