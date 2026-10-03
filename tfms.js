// tfms.js — FAA SWIM TFMS (Traffic Flow Management System) feed.
//
// Separate feed again: different VPN, different message family. TFMS carries filed-route and
// flow data — not position telemetry (that's SFDPS/swim.js) and not surface/terminal tracking
// (that's STDDS/stdds.js). The reason to connect it at all: cross-checking a real flight
// (swim.vncrcc.org's public API, SWA2932) showed TFMS hands back an ALREADY-RESOLVED fix-by-fix
// sequence for a filed route — including SID/STAR expansion done correctly for the specific
// runway/airport-configuration actually in use, which our own NASR-based resolution (navdata.js)
// can only guess at since the raw route string alone doesn't say which runway applies.
//
// Field mapping below is unverified against a live feed — same starting point every other
// module here began at. Expect correction once connected to real messages.

const solace = require('solclientjs');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

// TEMP — the existing handleMessage() silently drops any <tfmDataService> payload that isn't
// fltdOutput (see its own comment: "fiOutput (restrictions/TMI lists) — not flight-route data,
// ignored"). Checking whether real airport-configuration/acceptance-rate data (the public
// SwimReader instance exposes this as /api/tfms/aptc — arrRunwayConf/depRunwayConf per airport,
// exactly the "what runway is this airport actually using right now" signal that would let
// pickBody() stop guessing bodies[0] before a specific flight gets a TFDM runway assignment)
// lives under that dropped fiOutput structure, or somewhere else entirely. Same one-time dump
// pattern already used in swim.js/tfdm.js, but capturing the FULL raw message (fltdOutput
// included) rather than pre-filtering, since fiOutput messages carry no callsign to filter on.
const DUMP_DIR = path.join(__dirname, 'scratch', 'tfms-samples');
let _dumpCount = 0;
const DUMP_CAP = 20;
function dumpSample(xmlText) {
    if (_dumpCount >= DUMP_CAP) return;
    try {
        fs.mkdirSync(DUMP_DIR, { recursive: true });
        fs.writeFileSync(path.join(DUMP_DIR, `sample-${Date.now()}-${_dumpCount}.xml`), xmlText);
        _dumpCount++;
        if (_dumpCount === DUMP_CAP) console.log(`[TFMS] collected ${DUMP_CAP} raw samples in ${DUMP_DIR} -- checking for airport-configuration data`);
    } catch (e) {}
}

const TFMS_HOST  = process.env.TFMS_HOST;
const TFMS_VPN   = process.env.TFMS_VPN;
const TFMS_USER  = process.env.TFMS_USER;
const TFMS_PASS  = process.env.TFMS_PASS;
const TFMS_QUEUE = process.env.TFMS_QUEUE;

const TFMS_ENABLED = !!(TFMS_HOST && TFMS_VPN && TFMS_USER && TFMS_PASS && TFMS_QUEUE);

let _connected = false;
let _relevantCallsigns = null; // same pattern as swim.js/stdds.js

const _latest = {}; // callsign -> { route, fixes: [{name,lat?,lon?,time}], sid, star, lastMsg }

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

// One fltdOutput batches many fltdMessage entries (same batching pattern as every other SWIM
// feed here). Confirmed live, two message types matter:
//   flightPlanInformation          — the rich one: routeOfFlight (raw string) plus
//     flightTraversalData2, which has BOTH a named-fix sequence (name+elapsedTime) AND a dense
//     raw lat/lon trajectory (waypoint elements, elapsedTime-tagged) already computed by
//     TFMS/ERAM for this exact flight's actual routing — no NASR/procedure lookup needed at all
//     when this is present.
//   flightPlanAmendmentInformation — lighter: just the updated route string
//     (newRouteOfFlight). No fresh fixes/waypoints come with it — those arrive on the next
//     regular flightPlanInformation message, so an amendment just invalidates the old trajectory
//     until that next message refreshes it.
function processFlightPlanInfo(msgObj, cs) {
    const info = findDeep(msgObj, 'flightPlanInformation');
    if (!info) return;
    const routeEl = findDeep(info, 'routeOfFlight');
    const route = routeEl ? findAttr(routeEl, 'legacyFormat') : null;

    const travData = findDeep(info, 'flightTraversalData2');
    let fixesList = [], waypointsList = [];
    if (travData) {
        const rawFixes = travData.fix;
        const rawWaypoints = travData.waypoint;
        fixesList = (Array.isArray(rawFixes) ? rawFixes : (rawFixes ? [rawFixes] : [])).map(f => ({
            name: textOf(f), seq: parseInt(findAttr(f, 'sequenceNumber'), 10),
            elapsedSec: parseInt(findAttr(f, 'elapsedTime'), 10) || 0,
        }));
        waypointsList = (Array.isArray(rawWaypoints) ? rawWaypoints : (rawWaypoints ? [rawWaypoints] : [])).map(w => ({
            lat: parseFloat(findAttr(w, 'latitudeDecimal')), lon: parseFloat(findAttr(w, 'longitudeDecimal')),
            seq: parseInt(findAttr(w, 'sequenceNumber'), 10), elapsedSec: parseInt(findAttr(w, 'elapsedTime'), 10) || 0,
        })).filter(w => !isNaN(w.lat) && !isNaN(w.lon));
    }

    const entry = _latest[cs] || (_latest[cs] = {});
    entry.lastMsg = Date.now();
    if (route) entry.route = route;
    if (fixesList.length) entry.fixes = fixesList;
    if (waypointsList.length) entry.trajectory = waypointsList;
}

function processAmendment(msgObj, cs) {
    const info = findDeep(msgObj, 'flightPlanAmendmentInformation');
    const amendData = info ? findDeep(info, 'amendmentData') : null;
    if (!amendData) return;
    const routeEl = findDeep(amendData, 'newRouteOfFlight');
    const route = routeEl ? findAttr(routeEl, 'legacyFormat') : null;
    if (!route) return;
    const entry = _latest[cs] || (_latest[cs] = {});
    entry.lastMsg = Date.now();
    entry.route = route;
    // Stale until the next flightPlanInformation message re-derives these for the new route.
    entry.fixes = [];
    entry.trajectory = [];
}

function processOneFltdMessage(msgObj) {
    const acid = textOf(findDeep(msgObj, 'aircraftId'));
    if (!acid) return;
    const cs = String(acid).trim().toUpperCase();
    if (_relevantCallsigns && !_relevantCallsigns.has(cs)) return;

    const msgType = findAttr(msgObj, 'msgType');
    if (msgType === 'flightPlanInformation') processFlightPlanInfo(msgObj, cs);
    else if (msgType === 'flightPlanAmendmentInformation') processAmendment(msgObj, cs);
    // trackInformation (position-only) is ignored — SFDPS already covers live position, better.
}

function handleMessage(xmlText) {
    // Same fix as swim.js's handleMessage -- see its comment for the full incident writeup. TFMS
    // messages carry `aircraftId` as plain text (processOneFltdMessage), so this is a clean skip
    // with no GUFI-style caveat like stdds.js's.
    if (_relevantCallsigns) {
        let hasRelevant = false;
        for (const cs of _relevantCallsigns) {
            if (xmlText.includes(cs)) { hasRelevant = true; break; }
        }
        if (!hasRelevant) {
            // TEMP -- capture whatever's being dropped here that ISN'T just an irrelevant
            // flight's fltdMessage (every real per-flight message contains that tag per
            // processOneFltdMessage below), to find the real shape of the airport-configuration
            // data believed to live in the fiOutput structure this file already drops entirely
            // a few lines down. See dumpSample's own header comment.
            if (!xmlText.includes('fltdMessage')) dumpSample(xmlText);
            return;
        }
    }

    let parsed;
    try {
        parsed = xmlParser.parse(xmlText);
    } catch (e) {
        if (_unmappedWarnings++ < WARN_CAP) console.warn('[TFMS] XML parse failed:', e.message);
        return;
    }
    const service = findDeep(parsed, 'tfmDataService');
    const fltdOutput = service ? findDeep(service, 'fltdOutput') : null;
    if (!fltdOutput) return; // fiOutput (restrictions/TMI lists) — not flight-route data, ignored
    const raw = fltdOutput.fltdMessage;
    const messages = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (const m of messages) processOneFltdMessage(m);
}

let session = null;
let messageConsumer = null;

function connect() {
    if (!TFMS_ENABLED) {
        console.log('[TFMS] TFMS_* env vars not set — filed-route/flow data disabled');
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
        console.error('[TFMS] Solace factory init failed:', e.message);
        return;
    }

    try {
        session = solace.SolclientFactory.createSession({
            url: TFMS_HOST,
            vpnName: TFMS_VPN,
            userName: TFMS_USER,
            password: TFMS_PASS,
            connectRetries: 5,
            reconnectRetries: -1,
        });
    } catch (e) {
        console.error('[TFMS] session creation failed:', e.message);
        return;
    }

    session.on(solace.SessionEventCode.UP_NOTICE, () => {
        console.log('[TFMS] session up, binding to queue', TFMS_QUEUE);
        startConsumer();
    });
    session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
        console.error('[TFMS] connect failed:', e?.message || e);
    });
    session.on(solace.SessionEventCode.DISCONNECTED, () => {
        console.warn('[TFMS] session disconnected');
        _connected = false;
    });

    try {
        session.connect();
    } catch (e) {
        console.error('[TFMS] session.connect() threw:', e.message);
    }
}

function startConsumer() {
    try {
        messageConsumer = session.createMessageConsumer({
            queueDescriptor: { name: TFMS_QUEUE, type: solace.QueueType.QUEUE },
            acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
        });
    } catch (e) {
        console.error('[TFMS] message consumer creation failed:', e.message);
        return;
    }

    messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
        console.log('[TFMS] message consumer up — live TFMS messages flowing');
        _connected = true;
    });
    messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (e) => {
        console.error('[TFMS] consumer connect failed:', e?.message || e);
        _connected = false;
    });
    messageConsumer.on(solace.MessageConsumerEventName.DOWN, () => {
        console.warn('[TFMS] message consumer down');
        _connected = false;
    });

    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
        try {
            const xmlText = message.getXmlContent(); // same accessor confirmed for SFDPS/STDDS — trying it first here too
            if (xmlText) handleMessage(xmlText);
        } catch (e) {
            if (_unmappedWarnings++ < WARN_CAP) console.warn('[TFMS] message handling error:', e.message);
        } finally {
            try { message.acknowledge(); } catch (_) {}
        }
    });

    try {
        messageConsumer.connect();
    } catch (e) {
        console.error('[TFMS] messageConsumer.connect() threw:', e.message);
    }
}

function getFlightData(callsign) {
    if (!_connected) return null;
    const cs = String(callsign || '').trim().toUpperCase();
    const f = _latest[cs];
    if (!f) return null;
    if (Date.now() - (f.lastMsg || 0) > 30 * 60 * 1000) return null; // flow data changes slower than position — longer staleness window
    return f;
}

module.exports = { connect, getFlightData, setRelevantCallsigns, isEnabled: () => TFMS_ENABLED };
