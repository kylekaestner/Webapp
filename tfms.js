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
const fs = require('fs');
const path = require('path');

const TFMS_HOST  = process.env.TFMS_HOST;
const TFMS_VPN   = process.env.TFMS_VPN;
const TFMS_USER  = process.env.TFMS_USER;
const TFMS_PASS  = process.env.TFMS_PASS;
const TFMS_QUEUE = process.env.TFMS_QUEUE;

const TFMS_ENABLED = !!(TFMS_HOST && TFMS_VPN && TFMS_USER && TFMS_PASS && TFMS_QUEUE);

let _connected = false;
let _relevantCallsigns = null; // same pattern as swim.js/stdds.js
// callsign -> Set<scheduledDepUTCms> -- see setRelevantCallsigns()/isExpectedDay() below. Unlike
// swim.js/stdds.js (live position only, self-evidently "right now"), TFMS carries pre-departure
// flight-plan/schedule data, which is exactly what let a recurring flight number's NEXT calendar
// day's flight get mistaken for today's -- confirmed live: Sam's RPA4492 (SDF-ORD, flown and
// landed today) showed "delayed" with a nonsense ETD, because the real _flightTimes[cs] entry got
// silently overwritten by a flightPlanInformation/flightTimeData message for TOMORROW's unrelated
// physical flight under the same recurring number, the instant today's instance stopped
// broadcasting. Real airline flight numbers recur daily -- this isn't an edge case.
let _relevantDepTimes = new Map();
// callsign -> Set<normalizedOrigin> -- see setRelevantOrigins()/isExpectedOrigin() below. The
// day-check above stops a recurring flight number's NEXT calendar day's data from contaminating
// today's; this stops a SAME-day, opposite-direction/different-route reuse of the same flight
// number -- confirmed live: Republic's real TUL-LGA return flight shares callsign RPA4605 with
// Sam's own LGA-TUL leg, same day, and isn't in CrewSync's own data at all, so no date check can
// tell them apart. The real origin is parsed straight out of this feed's own filed-route string
// (routeOrigin() below), not borrowed from any other feed.
let _relevantOrigins = new Map();

const _latest = {}; // callsign -> { route, fixes: [{name,lat?,lon?,time}], sid, star, lastMsg }
// Estimated/airline times, kept apart from _latest so they survive restarts and pruning. Persisted to disk.
const TIMES_CACHE_PATH = path.join(__dirname, '.tfms_times_cache.json');
const TIMES_TTL_MS = 6 * 60 * 60 * 1000;
const _flightTimes = {}; // callsign -> { igtd, etd, eta, ..., timesUpdated }
try {
    const saved = JSON.parse(fs.readFileSync(TIMES_CACHE_PATH, 'utf8'));
    for (const [cs, t] of Object.entries(saved)) if (Date.now() - (t.timesUpdated || 0) <= TIMES_TTL_MS) _flightTimes[cs] = t;
} catch (_) {}
let _timesSaveTimer = null;
function scheduleTimesSave() {
    if (_timesSaveTimer) return;
    _timesSaveTimer = setTimeout(() => {
        _timesSaveTimer = null;
        const now = Date.now();
        for (const cs of Object.keys(_flightTimes)) if (now - (_flightTimes[cs].timesUpdated || 0) > TIMES_TTL_MS) delete _flightTimes[cs];
        try { fs.writeFileSync(TIMES_CACHE_PATH, JSON.stringify(_flightTimes)); } catch (_) {}
    }, 2000);
}
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

function setRelevantCallsigns(input) {
    // Accepts either a plain Set/array of callsign strings (no day-check -- permissive, same as
    // before) or a Map<callsign, Iterable<number|Date|string>> giving each callsign's known
    // scheduled departure time(s), used by isExpectedDay() below to reject a message describing a
    // different calendar-day instance of a recurring flight number. server.js's
    // runActiveFlightPoller passes the Map form; it already has each relevant row's real
    // timezone-correct departure instant in scope when it builds the relevant set.
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
        if (!_relevantCallsigns.has(cs)) delete _latest[cs];
    }
}

// Pulls the origin airport out of a TFMS legacy-format route string, e.g. "KJFK./.TEYOU..." or
// "KSUS..KAMA/0415" -> "SUS"/"SUS" (K-prefix stripped to match server.js's own normApt()
// convention, same bare-code shape used throughout this codebase for airport comparisons).
function routeOrigin(routeStr) {
    if (!routeStr) return null;
    const first = String(routeStr).trim().split(/[.\/\s]+/)[0];
    if (!first) return null;
    return first.toUpperCase().replace(/^K/, '');
}

// server.js calls this separately from setRelevantCallsigns() (not folded into the same Map
// shape) so tfdm.js -- which shares that function's code but has its own, already-adequate
// per-message origin/dest reset logic -- doesn't need to change at all. map: callsign ->
// Iterable<airportCode> (bare or K-prefixed, either is fine -- normalized here the same way
// routeOrigin() normalizes a parsed route's origin, so the two sides compare equal).
function setRelevantOrigins(map) {
    _relevantOrigins = new Map();
    if (!map) return;
    for (const [cs, origins] of map) {
        const set = new Set();
        for (const o of origins) {
            const norm = o ? String(o).toUpperCase().trim().replace(/^K/, '') : null;
            if (norm) set.add(norm);
        }
        if (set.size) _relevantOrigins.set(cs, set);
    }
}

function isExpectedOrigin(cs, candidateOrigin) {
    if (!candidateOrigin) return true; // nothing in this message to compare against -- don't block on missing data
    const expected = _relevantOrigins.get(cs);
    if (!expected || !expected.size) return true; // caller didn't supply origin info for this callsign -- permissive, unchanged behavior
    return expected.has(candidateOrigin);
}

// Finds whichever route string this specific message actually carries (flightPlanInformation's
// routeOfFlight, or an amendment's newRouteOfFlight), without running either handler's full side
// effects -- used only to get a candidate origin to check isExpectedOrigin() against before
// anything from this message gets merged.
function messageRouteString(msgObj) {
    const info = findDeep(msgObj, 'flightPlanInformation');
    if (info) {
        const routeEl = findDeep(info, 'routeOfFlight');
        const route = routeEl ? findAttr(routeEl, 'legacyFormat') : null;
        if (route) return route;
    }
    const amend = findDeep(msgObj, 'flightPlanAmendmentInformation');
    if (amend) {
        const amendData = findDeep(amend, 'amendmentData');
        const routeEl = amendData ? findDeep(amendData, 'newRouteOfFlight') : null;
        const route = routeEl ? findAttr(routeEl, 'legacyFormat') : null;
        if (route) return route;
    }
    return null;
}

// Wide enough to tolerate any realistic ground delay, tight enough to reject a ~24h-later
// recurrence of the same flight number (the actual failure mode this guards against).
const DAY_CHECK_TOLERANCE_MS = 16 * 60 * 60 * 1000;
function isExpectedDay(cs, candidateMs) {
    if (candidateMs == null) return true; // nothing in this message to compare against -- don't block on missing data
    const expected = _relevantDepTimes.get(cs);
    if (!expected || !expected.size) return true; // caller didn't supply day info for this callsign -- permissive, unchanged behavior
    for (const t of expected) if (Math.abs(candidateMs - t) <= DAY_CHECK_TOLERANCE_MS) return true;
    return false;
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
    if (route) { entry.route = route; const o = routeOrigin(route); if (o) entry.origin = o; }
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
    const o = routeOrigin(route);
    if (o) entry.origin = o;
    // Stale until the next flightPlanInformation message re-derives these for the new route.
    entry.fixes = [];
    entry.trajectory = [];
}

// Pulls whatever departure-ish absolute timestamp this message actually has, to check against
// isExpectedDay() before trusting it -- igtd (initial gate time departure) first since it's on
// every qualifiedAircraftId block, falling back to etd's timeValue, then flightTimeData's
// originalDeparture, in roughly most-reliably-present order.
function candidateMessageTimeMs(msgObj) {
    const iso = s => { if (!s) return null; const d = new Date(String(s).trim()); return isNaN(d) ? null : d.getTime(); };
    const qid = findDeep(msgObj, 'qualifiedAircraftId');
    const igtdMs = qid ? iso(textOf(findDeep(qid, 'igtd'))) : null;
    if (igtdMs != null) return igtdMs;
    const etdNode = findDeep(msgObj, 'etd');
    const etdMs = etdNode ? iso(findAttr(etdNode, 'timeValue')) : null;
    if (etdMs != null) return etdMs;
    const ftd = findDeep(msgObj, 'flightTimeData');
    if (ftd) {
        const origMs = iso(findAttr(ftd, 'originalDeparture'));
        if (origMs != null) return origMs;
    }
    return null;
}

function processOneFltdMessage(msgObj) {
    const acid = textOf(findDeep(msgObj, 'aircraftId'));
    if (!acid) return;
    const cs = String(acid).trim().toUpperCase();
    if (_relevantCallsigns && !_relevantCallsigns.has(cs)) return;
    const candidateMs = candidateMessageTimeMs(msgObj);
    const candidateOrigin = routeOrigin(messageRouteString(msgObj)) || (_latest[cs] && _latest[cs].origin) || null;
    // TEMPORARY research trace (added 2026-10-30, remove once the NetJets same-callsign
    // investigation is done -- see server.js's _NETJETS_RESEARCH_CALLSIGNS for the full why).
    // Logs every raw TFMS message for a watched EJA callsign BEFORE either day/origin check below
    // has a chance to reject anything, specifically to see whether a message's own candidate time
    // ever points at a different calendar day than today while a NetJets tour is still in
    // progress -- isExpectedDay()/isExpectedOrigin() are both permissive no-ops for an EJA
    // callsign right now (no known schedule to check against), so nothing here is actually being
    // filtered yet; this is purely to see what the raw feed looks like.
    if (/^EJA\d+$/.test(cs)) {
        const dayGapHrs = candidateMs != null ? ((candidateMs - Date.now()) / 3600000).toFixed(1) : '-';
        console.log(`[NetJets-research][TFMS] ${new Date().toISOString()} ${cs} msgType=${findAttr(msgObj, 'msgType') || '-'} candidateTime=${candidateMs != null ? new Date(candidateMs).toISOString() : '-'} (${dayGapHrs}h from now) candidateOrigin=${candidateOrigin || '-'} route=${messageRouteString(msgObj) || '-'}`);
    }
    // Reject a message describing a different calendar-day instance of a recurring flight number
    // (see isExpectedDay()'s and _relevantDepTimes's header comments) before any of it gets
    // merged into _latest/_flightTimes -- route, times, everything, not just one field.
    if (!isExpectedDay(cs, candidateMs)) return;
    // Reject a message describing a same-day, different-route reuse of this flight number -- see
    // _relevantOrigins's header comment. Prefers THIS message's own route-string origin when
    // present; falls back to whatever origin was cached from this callsign's last route-bearing
    // message, so a route-less times-only update doesn't slip past unchecked just because it
    // doesn't carry a fresh route of its own.
    if (!isExpectedOrigin(cs, candidateOrigin)) return;

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
    _flightTimes[cs] = { ...(_flightTimes[cs] || {}), ...times, timesUpdated: Date.now() };
    scheduleTimesSave();
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
    const key = String(airport).trim().toUpperCase();
    const prev = _airportConfig[key];
    const next = {
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
    // TEMPORARY — logging only, to settle a real question with evidence instead of guessing:
    // does FAA re-broadcast APTC periodically even when nothing changed (a heartbeat, in which
    // case a long silence really does mean something's stale/wrong), or only when the
    // configuration actually changes (in which case the 30min staleness window in
    // getAirportConfig() is needlessly discarding good data and should be relaxed)? Compares
    // every field except lastMsg/updateTime (which naturally differ message-to-message even with
    // an unchanged config) against what was already stored for this airport. Remove once this
    // has run long enough to answer the question.
    const unchanged = prev && ['facility','arrRunwayConf','depRunwayConf','arrRate','depRate','weather','stratAar']
        .every(k => prev[k] === next[k]);
    const sinceLastMs = prev ? Date.now() - prev.lastMsg : null;
    console.log(`[TFMS-APTC] ${key} ${unchanged ? 'UNCHANGED' : (prev ? 'CHANGED' : 'FIRST')}` +
        (sinceLastMs != null ? ` (+${Math.round(sinceLastMs/60000)}min since last msg)` : '') +
        ` dep=${next.depRunwayConf || '-'} arr=${next.arrRunwayConf || '-'}`);
    _airportConfig[key] = next;
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
    const cs = String(callsign || '').trim().toUpperCase();
    const f = _flightTimes[cs];
    if (!f || !f.timesUpdated) return null;
    if (Date.now() - f.timesUpdated > TIMES_TTL_MS) return null;
    const { igtd, etd, eta, airlineOutTime, airlineOffTime, airlineOnTime, airlineInTime,
        gateDeparture, gateArrival, runwayDeparture, runwayArrival, originalDeparture, originalArrival } = f;
    return { igtd, etd, eta, airlineOutTime, airlineOffTime, airlineOnTime, airlineInTime,
        gateDeparture, gateArrival, runwayDeparture, runwayArrival, originalDeparture, originalArrival };
}

module.exports = { connect, getFlightData, getFlightTimes, getAirportConfig, splitRunwayConf, setRelevantCallsigns, setRelevantOrigins, isEnabled: () => TFMS_ENABLED };
