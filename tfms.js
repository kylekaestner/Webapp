// tfms.js — FAA SWIM TFMS (Traffic Flow Management System) feed.
//
// Separate feed again: different VPN, different message family. TFMS carries filed-route and
// flow data — not position telemetry (that's SFDPS/swim.js) and not surface/terminal tracking
// (that's STDDS/stdds.js). The reason to connect it at all: cross-checking a real flight
// (SWA2932) showed TFMS hands back an ALREADY-RESOLVED fix-by-fix sequence for a filed route —
// including SID/STAR expansion done correctly for the specific runway/airport-configuration
// actually in use, which our own NASR-based resolution (navdata.js) can only guess at since the
// raw route string alone doesn't say which runway applies.
//
// A second, unrelated message family lives on the same queue: fiOutput/msgType="APTC"
// (airport configuration — the general arrival/departure runway flow an airport is actually
// using right now, independent of any specific flight). Found via live capture of real
// production TFMS traffic (a nationwide fiOutput message stream, filtered down by keyword
// pattern to the rarer APTC subtype rather than the far more common per-flight restriction-list
// messages that also share this message family), confirmed against 20 real captured samples
// spanning 20 distinct airports. Real shape, confirmed live:
//   <ds:tfmDataService><ds:fiOutput>
//     <fi:fiMessage msgType="APTC" ...>
//       <fi:airportConfigMessage>
//         <fcm:airport>SMF</fcm:airport>              -- bare 3-letter code, not K-prefixed
//         <fcm:facility>NCT</fcm:facility>
//         <fcm:arrRunwayConf>35L/35R</fcm:arrRunwayConf>  -- slash-separated, can be >1 runway
//         <fcm:depRunwayConf>35L/35R</fcm:depRunwayConf>  -- can be blank/whitespace-only
//         <fcm:arrRate>64</fcm:arrRate> <fcm:depRate>70</fcm:depRate>
//         <fcm:weather>VMC</fcm:weather> <fcm:stratAar>64</fcm:stratAar>
//         <fcm:updateTime>...</fcm:updateTime>
//       </fi:airportConfigMessage>
//     </fi:fiMessage>
//   </ds:fiOutput></ds:tfmDataService>
// Used as a fallback (in server.js's resolveRouteWaypoints) when TFDM hasn't yet assigned a
// specific flight a runway: the airport's current general config is still a better guess than
// navdata.js's arbitrary bodies[0]. No "pick the right one" logic beyond staleness is applied
// here — just the latest message per airport, flagged stale past 1800s (30 minutes, matching how
// often an airport's configuration realistically changes). getAirportConfig() below implements
// that convention.

const solace = require('solclientjs');
const { XMLParser } = require('fast-xml-parser');

const TFMS_HOST  = process.env.TFMS_HOST;
const TFMS_VPN   = process.env.TFMS_VPN;
const TFMS_USER  = process.env.TFMS_USER;
const TFMS_PASS  = process.env.TFMS_PASS;
const TFMS_QUEUE = process.env.TFMS_QUEUE;

const TFMS_ENABLED = !!(TFMS_HOST && TFMS_VPN && TFMS_USER && TFMS_PASS && TFMS_QUEUE);

let _connected = false;
let _relevantCallsigns = null; // same pattern as swim.js/stdds.js

const _latest = {}; // callsign -> { route, fixes: [{name,lat?,lon?,time}], sid, star, lastMsg }
const _airportConfig = {}; // bare 3-letter airport code -> { arrRunwayConf, depRunwayConf, ..., lastMsg }

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
    processFlightTimes(msgObj, cs);
}

// Estimated and airline-reported times TFMS carries alongside the flight plan. These are estimates
// only: the uploaded schedule is never changed from them, they're just exposed for display.
// IGTD sits on the qualified aircraft id; ETD/ETA are timeValue attributes on route/track data;
// gate/runway/airline OOOI-style times and the original ETA come from the airline data block.
const FLIGHT_TIME_ATTRS = ['airlineOutTime', 'airlineOffTime', 'airlineOnTime', 'airlineInTime',
    'gateDeparture', 'gateArrival', 'runwayDeparture', 'runwayArrival', 'originalDeparture', 'originalArrival'];
function processFlightTimes(msgObj, cs) {
    const entry = _latest[cs] || (_latest[cs] = {});
    const iso = v => {
        const s = textOf(v);
        if (s == null) return undefined;
        const d = new Date(String(s).trim());
        return isNaN(d) ? undefined : d.toISOString();
    };
    const times = {};
    const qid = findDeep(msgObj, 'qualifiedAircraftId');
    const igtd = qid ? iso(findDeep(qid, 'igtd')) : undefined;
    if (igtd) times.igtd = igtd;
    const timeValue = el => {
        const node = findDeep(msgObj, el);
        return node ? iso(findAttr(node, 'timeValue')) : undefined;
    };
    const etd = timeValue('etd');
    const eta = timeValue('eta');
    if (etd) times.etd = etd;
    if (eta) times.eta = eta;
    const ftd = findDeep(msgObj, 'flightTimeData');
    if (ftd) {
        for (const attr of FLIGHT_TIME_ATTRS) {
            const v = iso(findAttr(ftd, attr));
            if (v) times[attr] = v;
        }
    }
    if (Object.keys(times).length === 0) return;
    Object.assign(entry, times);
    entry.timesUpdated = Date.now();
}

// Not callsign-scoped at all (an airport's config isn't tied to any one flight), so this is
// never gated by _relevantCallsigns the way processOneFltdMessage is — every airport the
// nationwide feed mentions gets stored. That's cheap: there are only a few hundred towered
// airports FAA flow management tracks configuration for, nowhere near the memory concern a
// per-flight/per-callsign map would be over time.
function processOneFiMessage(msgObj) {
    if (findAttr(msgObj, 'msgType') !== 'APTC') return; // other fiOutput shape seen live: TMI_FLIGHT_LIST (flow-constraint timing, not this)
    const cfg = findDeep(msgObj, 'airportConfigMessage');
    if (!cfg) return;
    const airport = textOf(findDeep(cfg, 'airport'));
    if (!airport) return;
    const val = (tag) => {
        const t = textOf(findDeep(cfg, tag));
        if (t == null) return null;
        const s = String(t).trim();
        return s || null; // depRunwayConf in particular can be a lone space when no distinct dep config is active
    };
    _airportConfig[String(airport).trim().toUpperCase()] = {
        facility: val('facility'),
        arrRunwayConf: val('arrRunwayConf'),
        depRunwayConf: val('depRunwayConf'),
        arrRate: val('arrRate'),
        depRate: val('depRate'),
        weather: val('weather'),
        stratAar: val('stratAar'),
        updateTime: val('updateTime') || val('eventTime'),
        lastMsg: Date.now(),
    };
}

function handleMessage(xmlText) {
    // APTC messages carry no callsign at all, so they'd always fail the relevant-callsigns
    // substring check below and never reach the parser once that check applies — checked for
    // and parsed unconditionally, ahead of that gate, same cheap-substring-first approach as
    // every other filter in this file (avoid a full XML parse on text we already know is
    // irrelevant, per this app's established CPU-safety lesson from a prior production incident).
    const isAptc = xmlText.includes('msgType="APTC"');

    if (!isAptc && _relevantCallsigns) {
        // Same fix as swim.js's handleMessage -- see its comment for the full incident writeup.
        // TFMS messages carry `aircraftId` as plain text (processOneFltdMessage), so this is a
        // clean skip with no GUFI-style caveat like stdds.js's.
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
        if (_unmappedWarnings++ < WARN_CAP) console.warn('[TFMS] XML parse failed:', e.message);
        return;
    }
    const service = findDeep(parsed, 'tfmDataService');
    if (!service) return;

    if (isAptc) {
        const fiOutput = findDeep(service, 'fiOutput');
        if (!fiOutput) return;
        const raw = fiOutput.fiMessage;
        const messages = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        for (const m of messages) processOneFiMessage(m);
        return;
    }

    const fltdOutput = findDeep(service, 'fltdOutput');
    if (!fltdOutput) return; // fiOutput (TMI lists, or APTC already handled above) — not flight-route data, ignored
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

// aptCode may be a bare 3-letter code (as APTC itself uses) or a 4-letter ICAO code (as route
// strings/airports.json use elsewhere in this app) — accepts either.
function getAirportConfig(aptCode) {
    if (!_connected) return null;
    const code = String(aptCode || '').trim().toUpperCase();
    const bare = (code.length === 4 && code[0] === 'K') ? code.slice(1) : code;
    const cfg = _airportConfig[bare];
    if (!cfg) return null;
    // 1800s staleness window -- longer than a position/trail check needs, since an airport's
    // runway configuration realistically only changes a few times a day, not every poll.
    if (Date.now() - (cfg.lastMsg || 0) > 30 * 60 * 1000) return null;
    return cfg;
}

// Splits a runway-configuration string ("19R/19L/18", or a single "35L") into individual
// designators for matching against navdata.js's pickBody(), which expects the runways a NASR
// procedure body actually lists (e.g. "19R"). Returns null for an absent/blank config (APTC's
// depRunwayConf is commonly just whitespace when no distinct departure config is active).
function splitRunwayConf(confStr) {
    if (!confStr) return null;
    const parts = String(confStr).split('/').map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : null;
}

// Estimated/airline times for a callsign (see processFlightTimes). Kept separate from getFlightData so
// the times stay available for the whole flight, not just while the route data is fresh.
function getFlightTimes(callsign) {
    if (!_connected) return null;
    const cs = String(callsign || '').trim().toUpperCase();
    const f = _latest[cs];
    if (!f || !f.timesUpdated) return null;
    if (Date.now() - f.timesUpdated > 2 * 60 * 60 * 1000) return null;
    const { igtd, etd, eta, airlineOutTime, airlineOffTime, airlineOnTime, airlineInTime,
        gateDeparture, gateArrival, runwayDeparture, runwayArrival, originalDeparture, originalArrival } = f;
    return { igtd, etd, eta, airlineOutTime, airlineOffTime, airlineOnTime, airlineInTime,
        gateDeparture, gateArrival, runwayDeparture, runwayArrival, originalDeparture, originalArrival };
}

module.exports = { connect, getFlightData, getFlightTimes, getAirportConfig, splitRunwayConf, setRelevantCallsigns, isEnabled: () => TFMS_ENABLED };
