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

// TEMPORARY (added 2026-10-31): raw per-flight message dump, same pattern as tfdm.js's own
// dumpSample() -- scratch/tfms-samples/ turned out to only ever hold the OLD APTC-only capture
// (2026-10-02), never a real per-flight fltdMessage, so there's been no way to audit the full
// real shape of what this module actually receives for a flight -- only what processOneFltdMessage()
// already knew to look for. Separate directory so the existing APTC samples aren't touched.
// Stops itself once it's collected enough; remove this block once that audit is done.
const FLTD_DUMP_DIR = path.join(__dirname, 'scratch', 'tfms-fltd-samples');
let _fltdDumpCount = 0;
const FLTD_DUMP_CAP = 25;
function dumpFltdSample(xmlText) {
    if (_fltdDumpCount >= FLTD_DUMP_CAP) return;
    try {
        fs.mkdirSync(FLTD_DUMP_DIR, { recursive: true });
        fs.writeFileSync(path.join(FLTD_DUMP_DIR, `sample-${Date.now()}-${_fltdDumpCount}.xml`), xmlText);
        _fltdDumpCount++;
        if (_fltdDumpCount === FLTD_DUMP_CAP) console.log(`[TFMS] collected ${FLTD_DUMP_CAP} raw per-flight samples in ${FLTD_DUMP_DIR}`);
    } catch (e) {
        console.warn('[TFMS] fltd sample dump failed:', e.message);
    }
}

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
        for (const cs of Object.keys(_legTimes)) {
            const legsMap = _legTimes[cs];
            for (const [k, leg] of legsMap) if (now - (leg.lastMsg || 0) > LEG_TIMES_STALE_MS) legsMap.delete(k);
            if (legsMap.size === 0) delete _legTimes[cs];
        }
        try { fs.writeFileSync(TIMES_CACHE_PATH, JSON.stringify(_flightTimes)); } catch (_) {}
        const legTimesOut = {};
        for (const [cs, map] of Object.entries(_legTimes)) legTimesOut[cs] = [...map.entries()];
        try { fs.writeFileSync(LEG_TIMES_CACHE_PATH, JSON.stringify(legTimesOut)); } catch (_) {}
    }, 2000);
}
// callsign -> Map(legKey -> {...FLIGHT_TIME_ATTRS, etd, eta, igtd, origin, dest, scheduledDepMs,
// lastMsg}) -- the per-leg counterpart to _flightTimes above. _flightTimes is a flat,
// single-record cache shared across a callsign's whole day -- correct for a normal airline flight
// number (legs are sequential, never concurrent) but wrong for NetJets, whose later legs get
// filed/amended while an earlier one is still open under the same callsign (see tfdm.js's _legs
// comment for the confirmed live evidence). Only populated from a message that carries its OWN
// route string end-to-end (see processOneFltdMessage below) -- never from the same
// _latest[cs].origin fallback isExpectedOrigin() uses, so a leg key here is never guessed.
// Deliberately sparser than _flightTimes as a result, but every entry it has is correctly
// attributed to the leg it's actually about.
const _legTimes = {};
const LEG_TIMES_STALE_MS = 48 * 60 * 60 * 1000;
// Persisted to disk, same reasoning as _flightTimes above and tfdm.js's identical _legs cache --
// a pm2 restart otherwise throws away whatever future legs had already been filed ahead.
const LEG_TIMES_CACHE_PATH = path.join(__dirname, '.tfms_legtimes_cache.json');
try {
    const saved = JSON.parse(fs.readFileSync(LEG_TIMES_CACHE_PATH, 'utf8'));
    const now = Date.now();
    for (const [cs, entries] of Object.entries(saved)) {
        const map = new Map();
        for (const [key, leg] of entries) {
            if (now - (leg.lastMsg || 0) <= LEG_TIMES_STALE_MS) map.set(key, leg);
        }
        if (map.size) _legTimes[cs] = map;
    }
} catch (_) {}

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

// TEMPORARY (added 2026-10-30, remove once the NetJets same-callsign-all-day filing
// investigation is done): see tfdm.js's identical _isResearchRelevant() for the full reasoning --
// a single cheap `includes('EJA')` check, never a per-tail loop, to avoid the exact CPU mistake
// swim.js's own handleMessage comment documents a real past incident over.
const NETJETS_RESEARCH_MODE = true;
function _isResearchRelevant(cs) { return NETJETS_RESEARCH_MODE && /^EJA\d+$/.test(cs); }

// Same dedicated-file, log-on-change-only helper as tfdm.js -- see its own comment for the full
// reasoning. Writes to the SAME file (not a separate one per module) so TFDM and TFMS entries
// interleave in real chronological order when reviewing the investigation later.
const _NETJETS_RESEARCH_LOG_PATH = path.join(__dirname, '.netjets_research.log');
const _netjetsResearchLastSig = new Map();
function _netjetsResearchLog(source, cs, detail) {
    const key = `${source}|${cs}`;
    if (_netjetsResearchLastSig.get(key) === detail) return;
    _netjetsResearchLastSig.set(key, detail);
    try {
        fs.appendFileSync(_NETJETS_RESEARCH_LOG_PATH, `${new Date().toISOString()} [${source}] ${cs} ${detail}\n`);
    } catch (_) {}
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
        if (!_relevantCallsigns.has(cs) && !_isResearchRelevant(cs)) delete _latest[cs];
    }
    for (const cs of Object.keys(_legTimes)) {
        if (!_relevantCallsigns.has(cs) && !_isResearchRelevant(cs)) delete _legTimes[cs];
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

// The other end of a legacy-format route string (e.g.
// "KJFK./.TEYOU..KP75C..TBC..JASSE.Q90.DNERO.ANJLL4.KLAX/0739" -> "LAX"). A local copy of
// server.js's identical routeDest() -- that one was deliberately kept out of this file when it
// was added (NetJets-leg-creation-only, avoid touching a feed every pilot depends on); this copy
// exists only for the new per-leg store below, which needs to key a leg by BOTH ends, not just
// the origin routeOrigin() already gave this file. Same loose, no-strict-ICAO-validation style.
function routeDest(routeStr) {
    if (!routeStr) return null;
    const tokens = String(routeStr).trim().split(/[.\/\s]+/).filter(Boolean);
    for (let i = tokens.length - 1; i >= 0; i--) {
        if (!/^\d+$/.test(tokens[i])) return tokens[i].toUpperCase().replace(/^K/, '');
    }
    return null;
}

// Fallback source of dep/arr airports for every TFMS message type messageRouteString() can't
// resolve a route from at all. Confirmed real (2026-10-31 audit): depArpt/arrArpt are plain
// attributes on the <fdm:fltdMessage> wrapper of essentially every message type -- FlightModify,
// FlightRoute, FlightTimes, FlightSectors, FlightCreate, trackInformation, etc -- not just the
// two route-bearing types (flightPlanInformation/flightPlanAmendmentInformation)
// messageRouteString() checks. That's ~90% of real NetJets-relevant TFMS traffic that previously
// never produced a leg at all, even though the airports were sitting right there on the message.
// Scoped to the per-leg store only (both callers below are already inside _isResearchRelevant(cs)
// blocks) -- never touches candidateOrigin/isExpectedOrigin, which gate every other pilot's real
// tracked flight, so this can't affect the general pipeline.
function attrAirport(msgObj, attrName) {
    const v = findAttr(msgObj, attrName);
    return v ? String(v).trim().toUpperCase().replace(/^K/, '') : null;
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
    if (_relevantCallsigns && !_relevantCallsigns.has(cs) && !_isResearchRelevant(cs)) return;
    const candidateMs = candidateMessageTimeMs(msgObj);
    const ownOrigin = routeOrigin(messageRouteString(msgObj));
    const candidateOrigin = ownOrigin || (_latest[cs] && _latest[cs].origin) || null;
    // TEMPORARY research trace (added 2026-10-30, remove once the NetJets same-callsign
    // investigation is done). Logs every raw TFMS message for ANY EJA callsign BEFORE either
    // day/origin check below has a chance to reject anything, specifically to see whether a
    // message's own candidate time ever points at a different calendar day than today --
    // isExpectedDay()/isExpectedOrigin() are both permissive no-ops for an EJA callsign right now
    // (no known schedule to check against), so nothing here is actually being filtered yet; this
    // is purely to see what the raw feed looks like. Only ON CHANGE (see _netjetsResearchLog()).
    if (_isResearchRelevant(cs)) {
        const dayGapHrs = candidateMs != null ? ((candidateMs - Date.now()) / 3600000).toFixed(1) : '-';
        _netjetsResearchLog('TFMS', cs, `msgType=${findAttr(msgObj, 'msgType') || '-'} candidateTime=${candidateMs != null ? new Date(candidateMs).toISOString() : '-'} (${dayGapHrs}h from now) candidateOrigin=${candidateOrigin || '-'} route=${messageRouteString(msgObj) || '-'}`);
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

    // Per-leg record, additive. Scoped to NetJets (EJA) callsigns only, same reasoning as
    // tfdm.js's identical scoping on its own per-leg store -- every other pilot's tracked flight
    // has no reason to pay for this. See _legTimes's header comment.
    if (_isResearchRelevant(cs)) {
        // Prefer the real route string's own ends; fall back to the message's depArpt/arrArpt
        // attributes when messageRouteString() came back empty (see attrAirport()'s comment --
        // this is what recovers a leg from a FlightSectors/FlightTimes/trackInformation/etc
        // message that never carries a parseable route string at all).
        const legOrigin = ownOrigin || attrAirport(msgObj, 'depArpt');
        const legDest = routeDest(messageRouteString(msgObj)) || attrAirport(msgObj, 'arrArpt');
        if (legOrigin && legDest) {
            // THIS message's own route (or its depArpt/arrArpt attributes) resolves both ends --
            // never guessed.
            processLegTimes(msgObj, cs, legOrigin, legDest, candidateMs);
        } else if (candidateMs != null) {
            // Routeless times-only update (confirmed the common case live: most ongoing ETD/ETA
            // refinements for an already-established leg arrive this way -- only the first,
            // route-bearing message per leg ever sets the key). Without this branch, these never
            // reach _legTimes at all, so the per-leg store goes stale the moment a leg's route
            // stops being re-sent, even while the flat _flightTimes cache keeps getting fresher
            // data -- confirmed live 2026-10-31: EJA742's SGR->DAL leg had a real, fresh ETA in
            // the flat cache that never made it into the per-leg store, so
            // _pollNetjetsLegCreation() (server.js) never refilled the segment's cleared
            // arrival_time with it. Attribute to whichever ALREADY-KNOWN leg's own
            // scheduledDepMs is closest to this message's candidateMs, within a tight tolerance
            // -- never creates a new leg key from a routeless message, only refines one a real
            // route-bearing message already established.
            const existing = _legTimes[cs];
            if (existing) {
                let bestKey = null, bestDiff = Infinity;
                for (const [key, leg] of existing) {
                    if (leg.scheduledDepMs == null) continue;
                    const diff = Math.abs(leg.scheduledDepMs - candidateMs);
                    if (diff <= ROUTELESS_TIMES_MATCH_TOLERANCE_MS && diff < bestDiff) { bestKey = key; bestDiff = diff; }
                }
                if (bestKey) {
                    const leg = existing.get(bestKey);
                    processLegTimes(msgObj, cs, leg.origin, leg.dest, candidateMs);
                }
            }
        }
    }
}
const ROUTELESS_TIMES_MATCH_TOLERANCE_MS = 2 * 60 * 60 * 1000;

// Estimated and airline-reported times TFMS carries alongside the flight plan. These are estimates
// only: the uploaded schedule is never changed from them, they're just exposed for display.
// IGTD sits on the qualified aircraft id; ETD/ETA are timeValue attributes on route/track data;
// gate/runway/airline OOOI-style times and the original ETA come from the airline data block.
const FLIGHT_TIME_ATTRS = ['airlineOutTime', 'airlineOffTime', 'airlineOnTime', 'airlineInTime',
    'gateDeparture', 'gateArrival', 'runwayDeparture', 'runwayArrival', 'originalDeparture', 'originalArrival'];
// Shared extraction, used by both the flat per-callsign cache (processFlightTimes) and the new
// per-leg cache (processLegTimes) below -- same fields, two different places to file them.
function _extractTimeFields(msgObj) {
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

    // Everything below is NEW (added 2026-10-31, confirmed against real captured
    // scratch/tfms-fltd-samples/) and deliberately additive-only -- these keys are never added to
    // getFlightTimes()'s explicit return allowlist, so every pilot already relying on the flat
    // cache (the general SWIM-based pipeline that already works correctly) sees zero behavior
    // change. They DO flow through getAllLegTimes() (no allowlist there), which is read only by
    // NetJets-specific code -- exactly where these are actually useful (schedule creation, not
    // live tracking display).
    //
    // etd/eta each carry a type attribute ("ACTUAL" vs "ESTIMATED") this app previously
    // discarded -- knowing which it is matters for NetJets specifically, where "the departure
    // time" is often just the latest estimate, not a real commitment.
    const etdNode = findDeep(msgObj, 'etd');
    const etaNode = findDeep(msgObj, 'eta');
    const etdType = etdNode ? findAttr(etdNode, 'etdType') : undefined;
    const etaType = etaNode ? findAttr(etaNode, 'etaType') : undefined;
    if (etdType) times.etdType = etdType;
    if (etaType) times.etaType = etaType;
    // TFMS's own diversion flag (nxcm:diversionIndicator, confirmed real value "NO_DIVERSION" --
    // implying a non-"NO_DIVERSION" value exists for an actual diversion), independent of
    // tfdm.js's diversionRecoveryIndicator -- a second, cross-checkable source.
    const diversionIndicator = textOf(findDeep(msgObj, 'diversionIndicator'));
    if (diversionIndicator) times.diversionIndicator = diversionIndicator;
    // arrivalInformation messages carry a dedicated time-of-arrival field with an explicit
    // estimated="true|false" flag -- distinct from the generic eta above, and tells you directly
    // whether this specific value is confirmed or still a guess.
    const toaNode = findDeep(msgObj, 'timeOfArrival');
    if (toaNode) {
        const toa = iso(toaNode);
        if (toa) {
            times.timeOfArrival = toa;
            times.timeOfArrivalEstimated = findAttr(toaNode, 'estimated') === 'true';
        }
    }
    // GUFI (Globally Unique Flight Identifier) -- a real FIXM-standard identifier for one
    // specific physical flight instance, not a recurring callsign/flight number. Confirmed
    // stable across 6 repeated messages for the same real flight (ASH4013) in one capture batch.
    // Stored here, not yet used to change any matching logic -- a real candidate for eventually
    // replacing the fuzzy origin/dest/time-tolerance leg-matching this app currently relies on
    // for NetJets, but that's a deliberate follow-on decision, not bundled into this parsing pass.
    const gufi = qid ? textOf(findDeep(qid, 'gufi')) : undefined;
    if (gufi) times.gufi = gufi;

    return times;
}

function processFlightTimes(msgObj, cs) {
    const times = _extractTimeFields(msgObj);
    if (Object.keys(times).length === 0) return;
    _flightTimes[cs] = { ...(_flightTimes[cs] || {}), ...times, timesUpdated: Date.now() };
    scheduleTimesSave();
}

// Per-leg counterpart -- see _legTimes's header comment. origin/dest here are always THIS
// message's own route-string ends (never _latest[cs]'s stale fallback), so distinct concurrently
// -filed legs for one callsign land in separate entries instead of one overwriting the other.
function processLegTimes(msgObj, cs, origin, dest, candidateMs) {
    const times = _extractTimeFields(msgObj);
    const key = `${origin}>${dest}`;
    const legsMap = _legTimes[cs] || (_legTimes[cs] = new Map());
    const leg = legsMap.get(key) || { origin, dest };
    Object.assign(leg, times);
    if (candidateMs != null) leg.scheduledDepMs = candidateMs;
    leg.lastMsg = Date.now();
    legsMap.set(key, leg);
    scheduleTimesSave();

    // TEMPORARY research-only (added 2026-10-31, remove once the NetJets ETD-drift question is
    // answered): tracks the FIRST estimated departure ever seen for this leg, purely so a later
    // analysis can measure how far an estimate moves over a leg's lifetime. Raised directly:
    // "delays may not happen with EJA flights as their departure time may just keep pushing
    // further" -- confirmed partially true on EJA742's own SGR->DAL leg, whose TFDM
    // departureDelayMin was never populated at all despite its own estimate visibly sliding
    // ~30 minutes. This measures drift independently of whether TFDM ever flags a delay. Never
    // read by any production code path -- logging only, in-memory, not persisted across a
    // restart (an acceptable gap for a research-only measurement).
    const bestEstimate = times.etd || times.igtd || null;
    if (bestEstimate) {
        const dkey = `${cs}|${key}`;
        const bestMs = new Date(bestEstimate).getTime();
        if (!_driftFirstSeen[dkey]) _driftFirstSeen[dkey] = { value: bestEstimate, ms: bestMs };
        const driftMin = Math.round((bestMs - _driftFirstSeen[dkey].ms) / 60000);
        _netjetsResearchLog('TFMS-drift', cs, `${key} firstSeen=${_driftFirstSeen[dkey].value} current=${bestEstimate} driftMin=${driftMin}`);
    }
}
const _driftFirstSeen = {}; // "cs|origin>dest" -> { value: ISO string, ms: number } -- see processLegTimes() above

// All currently-known distinct legs' times for a callsign, sorted by scheduled departure
// ascending -- the per-leg counterpart to getFlightTimes() below.
function getAllLegTimes(callsign) {
    const cs = String(callsign || '').trim().toUpperCase();
    const legsMap = _legTimes[cs];
    if (!legsMap) return [];
    return [...legsMap.entries()]
        .map(([key, leg]) => ({ key, ...leg }))
        .sort((a, b) => (a.scheduledDepMs || 0) - (b.scheduledDepMs || 0));
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

// TEMPORARY one-off raw capture (added 2026-10-31, remove once the EJA829 missing-leg
// investigation is done) -- user explicitly wants the UNPARSED XML, not our own
// messageRouteString()/candidateOrigin fields, since those already have a confirmed blind spot.
// Appends every distinct raw message mentioning EJA829 (capped) so the real wire format can be
// read directly instead of trusting our extraction code.
let _eja829CaptureCount = 0;
const _EJA829_CAP = 15;
const _EJA829_DEBUG_PATH = path.join(__dirname, '.eja829_debug_tfms.xml');
function _captureEja829(xmlText) {
    if (_eja829CaptureCount >= _EJA829_CAP || !xmlText.includes('EJA829')) return;
    _eja829CaptureCount++;
    try { fs.appendFileSync(_EJA829_DEBUG_PATH, `\n\n==== CAPTURE ${_eja829CaptureCount} @ ${new Date().toISOString()} ====\n${xmlText}`); } catch (e) {}
}

function handleMessage(xmlText) {
    _captureEja829(xmlText);
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
        let hasRelevant = NETJETS_RESEARCH_MODE && xmlText.includes('EJA');
        if (!hasRelevant) for (const cs of _relevantCallsigns) {
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
    dumpFltdSample(xmlText);
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

module.exports = { connect, getFlightData, getFlightTimes, getAllLegTimes, routeDest, getAirportConfig, splitRunwayConf, setRelevantCallsigns, setRelevantOrigins, isEnabled: () => TFMS_ENABLED };
