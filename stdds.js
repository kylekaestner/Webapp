// stdds.js — FAA SWIM STDDS surface/ground-movement feed (ASDE-X and related).
//
// Separate feed from swim.js/SFDPS: different Solace VPN, different message family entirely
// (surface-movement tracks, not FIXM flight messages). Covers aircraft on the ground at
// airports that have ASDE-X (or similar surface surveillance) installed — nothing is
// hardcoded about which airports those are; coverage is just whatever the feed actually
// publishes, same as SFDPS naturally only covers domestic en-route airspace.
//
// Field mapping below is a first pass, unverified against a live feed — same situation swim.js
// started in. Expect this to need correction once connected to real messages.

const solace = require('solclientjs');
const { XMLParser } = require('fast-xml-parser');

const STDDS_HOST  = process.env.SCDSCONNECTION__HOST;
const STDDS_VPN   = process.env.SCDSCONNECTION__MESSAGEVPN;
const STDDS_USER  = process.env.SCDSCONNECTION__USERNAME;
const STDDS_PASS  = process.env.SCDSCONNECTION__PASSWORD;
const STDDS_QUEUE = process.env.SCDSCONNECTION__QUEUENAME;

const STDDS_ENABLED = !!(STDDS_HOST && STDDS_VPN && STDDS_USER && STDDS_PASS && STDDS_QUEUE);

let _connected = false;
let _relevantCallsigns = null; // same pattern as swim.js — set from CrewSync's own scheduled flights

const _latest = {}; // callsign -> { airport, lat, lon, altFt, speedKts, heading, lastMsg, trail }
const _watched = new Set(); // same lazy-trail-start pattern as swim.js

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
        if (!_relevantCallsigns.has(cs)) { delete _latest[cs]; _watched.delete(cs); }
    }
}

let _unmappedWarnings = 0;
const WARN_CAP = 20;

const swim = require('./swim');

// Confirmed against real messages (three message families share this one queue):
//   TATrackAndFlightPlan (TAIS)  — terminal-area radar tracks. Each <record> pairs a <track>
//     (position) with a <flightPlan> (acid = callsign) directly — no GUFI correlation needed.
//   asdexMsg (SMES)              — surface/near-surface contacts, batched many-per-message,
//     two sub-shapes: <adsbReport><report><basicReport> (lean, lat/lon only, no identity) and
//     <positionReport> (richer: speed/heading/status, occasionally <flightId>, often an
//     <enhancedData><eramGufi>). Most reports carry NO usable identity directly — GUFI
//     correlation against swim.js's SFDPS-derived GUFI map is how most of these get attributed
//     to a real CrewSync pilot; anything with neither a real aircraftId nor a resolvable GUFI
//     is simply not attributable and is skipped (not a loss — we only care about our own
//     pilots' flights anyway).
//   SurfaceMovementEventMessage  — rare, event-driven (runway entry/exit etc.), but carries a
//     direct <callsign> and runway/status/event fields. Good supplementary milestone data.
//   SafetyLogicHoldBar           — runway hold-bar light status, not aircraft data. Ignored.

function mergeEntry(cs, fields) {
    const entry = _latest[cs] || (_latest[cs] = {});
    entry.lastMsg = Date.now();
    for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined && v !== null) entry[k] = v;
    }
    // Trail accumulation only for callsigns someone's actually asked about (getGroundPosition
    // starts watching lazily) — same reasoning as swim.js: don't build deep history for every
    // callsign STDDS happens to mention, only the ones CrewSync actually looks up.
    if (_watched.has(cs) && fields.lat != null && fields.lon != null) {
        entry.trail = entry.trail || [];
        entry.trail.push([fields.lat, fields.lon, Date.now()]);
        if (entry.trail.length > 4000) entry.trail.splice(0, entry.trail.length - 4000);
    }
}

function processTais(root) {
    const recordsRaw = root.record;
    if (recordsRaw === undefined) return;
    const records = Array.isArray(recordsRaw) ? recordsRaw : [recordsRaw];
    for (const rec of records) {
        const acid = textOf(findDeep(rec, 'acid'));
        if (!acid) continue;
        const cs = String(acid).trim().toUpperCase();
        if (_relevantCallsigns && !_relevantCallsigns.has(cs)) continue;

        const track = rec.track;
        if (!track) continue;
        const lat = parseFloat(textOf(findDeep(track, 'lat')));
        const lon = parseFloat(textOf(findDeep(track, 'lon')));
        if (isNaN(lat) || isNaN(lon)) continue;
        const altFt = parseFloat(textOf(findDeep(track, 'reportedAltitude')));
        const vx = parseFloat(textOf(findDeep(track, 'vx')));
        const vy = parseFloat(textOf(findDeep(track, 'vy')));
        let heading = null, speedKts = null;
        if (!isNaN(vx) && !isNaN(vy) && (vx !== 0 || vy !== 0)) {
            heading = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360; // same axis assumption as swim.js, equally unverified
            speedKts = Math.sqrt(vx * vx + vy * vy);
        }
        const airport = textOf(findDeep(rec, 'airport'));

        mergeEntry(cs, { lat, lon, altFt: isNaN(altFt) ? undefined : altFt, heading, speedKts, airport, source: 'tais' });
    }
}

function processAsdex(root) {
    const airport = textOf(findDeep(root, 'airport'));

    // <adsbReport><report><basicReport> — lean shape, position only, no identity ever seen.
    // Kept for completeness but in practice these can't be attributed without a GUFI, which
    // this shape doesn't carry either — so these are read but will almost always be skipped.
    const adsbReportsRaw = root.adsbReport;
    const positionReportsRaw = root.positionReport;
    const allReports = []
        .concat(adsbReportsRaw ? (Array.isArray(adsbReportsRaw) ? adsbReportsRaw : [adsbReportsRaw]).map(r => ({ r, kind: 'adsb' })) : [])
        .concat(positionReportsRaw ? (Array.isArray(positionReportsRaw) ? positionReportsRaw : [positionReportsRaw]).map(r => ({ r, kind: 'position' })) : []);

    for (const { r, kind } of allReports) {
        let lat, lon, altFt, speedKts, heading, aircraftId, gufi;

        if (kind === 'adsb') {
            const basic = findDeep(r, 'basicReport');
            if (!basic) continue;
            const pos = basic.position;
            lat = parseFloat(textOf(findDeep(pos, 'lat')));
            lon = parseFloat(textOf(findDeep(pos, 'lon')));
        } else {
            const pos = r.position;
            lat = parseFloat(textOf(findDeep(pos, 'latitude')));
            lon = parseFloat(textOf(findDeep(pos, 'longitude')));
            altFt = parseFloat(textOf(findDeep(pos, 'altitude')));
            const move = r.movement;
            if (move) {
                speedKts = parseFloat(textOf(findDeep(move, 'speed')));
                heading = parseFloat(textOf(findDeep(move, 'heading')));
            }
            aircraftId = textOf(findDeep(r, 'aircraftId'));
            gufi = textOf(findDeep(r, 'eramGufi'));
        }
        if (isNaN(lat) || isNaN(lon)) continue;

        let cs = null;
        if (aircraftId && aircraftId !== 'UNKN') cs = String(aircraftId).trim().toUpperCase();
        else if (gufi) cs = swim.callsignForGufi(gufi);
        if (!cs) continue; // not attributable to any known CrewSync flight
        if (_relevantCallsigns && !_relevantCallsigns.has(cs)) continue;

        mergeEntry(cs, {
            lat, lon,
            altFt: isNaN(altFt) ? undefined : altFt,
            speedKts: isNaN(speedKts) ? undefined : speedKts,
            heading: isNaN(heading) ? undefined : heading,
            airport, source: 'asdex',
        });
    }
}

function processSurfaceMovementEvent(root) {
    const callsign = textOf(findDeep(root, 'callsign'));
    if (!callsign) return;
    const cs = String(callsign).trim().toUpperCase();
    if (_relevantCallsigns && !_relevantCallsigns.has(cs)) return;

    const pos = root.position;
    const lat = parseFloat(textOf(findDeep(pos, 'latitude')));
    const lon = parseFloat(textOf(findDeep(pos, 'longitude')));
    const altFt = parseFloat(textOf(findDeep(root, 'altitude')));
    const airport = textOf(findDeep(root, 'airport'));
    const runway = textOf(findDeep(root, 'runway'));
    const status = textOf(findDeep(root, 'status'));
    const event = textOf(findDeep(root, 'event'));

    const fields = { airport, runway, status, event, source: 'smes' };
    if (!isNaN(lat) && !isNaN(lon)) { fields.lat = lat; fields.lon = lon; }
    if (!isNaN(altFt)) fields.altFt = altFt;
    mergeEntry(cs, fields);
}

function handleMessage(xmlText) {
    // Same fix as swim.js's handleMessage -- see its comment for the full incident writeup (this
    // unfiltered full-parse-per-message pattern pegged the production droplet's CPU at 100% and
    // took the whole server down, not just this feed). Skips the expensive xmlParser.parse() call
    // when the raw text contains none of our watched callsigns as plain text.
    //
    // One real tradeoff accepted here, not present in swim.js: `asdexMsg` surface contacts are
    // sometimes identified only by GUFI (cross-referenced to a callsign via swim.callsignForGufi()
    // AFTER parsing, see processAsdex), not by callsign text directly -- a message like that could
    // in principle be relevant without this substring check ever seeing it. In practice this was
    // already a best-effort path (the existing code comments note these "can't be attributed
    // without a GUFI" and "will almost always be skipped" regardless), so this doesn't meaningfully
    // change what was already a lossy fallback -- but it's a real, conscious tradeoff, not a free one.
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
        if (_unmappedWarnings++ < WARN_CAP) console.warn('[STDDS] XML parse failed:', e.message);
        return;
    }
    const rootKey = Object.keys(parsed).find(k => k !== '?xml');
    const root = parsed[rootKey];
    if (!root) return;

    if (rootKey === 'TATrackAndFlightPlan') processTais(root);
    else if (rootKey === 'asdexMsg') processAsdex(root);
    else if (rootKey === 'SurfaceMovementEventMessage') processSurfaceMovementEvent(root);
    // TAStatus (heartbeat) and SafetyLogicHoldBar (runway light status) carry no aircraft data — ignored.
}

let session = null;
let messageConsumer = null;

function connect() {
    if (!STDDS_ENABLED) {
        console.log('[STDDS] SCDSCONNECTION__* env vars not set — surface/taxi tracking disabled');
        return;
    }

    try {
        const factoryProps = new solace.SolclientFactoryProperties();
        factoryProps.profile = solace.SolclientFactoryProfiles.version10;
        // Only init the factory once — swim.js may have already done this in the same process.
        if (!solace.SolclientFactory._crewsyncInitDone) {
            solace.SolclientFactory.init(factoryProps);
            solace.SolclientFactory.setLogLevel(solace.LogLevel.WARN);
            solace.SolclientFactory._crewsyncInitDone = true;
        }
    } catch (e) {
        console.error('[STDDS] Solace factory init failed:', e.message);
        return;
    }

    try {
        session = solace.SolclientFactory.createSession({
            url: STDDS_HOST,
            vpnName: STDDS_VPN,
            userName: STDDS_USER,
            password: STDDS_PASS,
            connectRetries: 5,
            reconnectRetries: -1,
        });
    } catch (e) {
        console.error('[STDDS] session creation failed:', e.message);
        return;
    }

    session.on(solace.SessionEventCode.UP_NOTICE, () => {
        console.log('[STDDS] session up, binding to queue', STDDS_QUEUE);
        startConsumer();
    });
    session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
        console.error('[STDDS] connect failed:', e?.message || e);
    });
    session.on(solace.SessionEventCode.DISCONNECTED, () => {
        console.warn('[STDDS] session disconnected');
        _connected = false;
    });

    try {
        session.connect();
    } catch (e) {
        console.error('[STDDS] session.connect() threw:', e.message);
    }
}

function startConsumer() {
    try {
        messageConsumer = session.createMessageConsumer({
            queueDescriptor: { name: STDDS_QUEUE, type: solace.QueueType.QUEUE },
            acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
        });
    } catch (e) {
        console.error('[STDDS] message consumer creation failed:', e.message);
        return;
    }

    messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
        console.log('[STDDS] message consumer up — live surface messages flowing');
        _connected = true;
    });
    messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (e) => {
        console.error('[STDDS] consumer connect failed:', e?.message || e);
        _connected = false;
    });
    messageConsumer.on(solace.MessageConsumerEventName.DOWN, () => {
        console.warn('[STDDS] message consumer down');
        _connected = false;
    });

    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
        try {
            const xmlText = message.getXmlContent(); // confirmed accessor from swim.js — trying same one first
            if (xmlText) handleMessage(xmlText);
        } catch (e) {
            if (_unmappedWarnings++ < WARN_CAP) console.warn('[STDDS] message handling error:', e.message);
        } finally {
            try { message.acknowledge(); } catch (_) {}
        }
    });

    try {
        messageConsumer.connect();
    } catch (e) {
        console.error('[STDDS] messageConsumer.connect() threw:', e.message);
    }
}

// Same response shape swim.js/fetchAdsbPosition already produce, so fetchLivePosition() in
// server.js can treat all three sources interchangeably.
function getGroundPosition(callsign) {
    if (!_connected) return null;
    const cs = String(callsign || '').trim().toUpperCase();
    if (!cs) return null;
    _watched.add(cs); // lazy: begin keeping trail history now that someone's asked

    const f = _latest[cs];
    if (!f || f.lat == null || f.lon == null) return null;
    if (Date.now() - (f.lastMsg || 0) > 10 * 60 * 1000) return null;

    return {
        found: true,
        lat: f.lat,
        lon: f.lon,
        altFt: f.altFt ?? null,
        speedKts: f.speedKts ?? null,
        heading: f.heading ?? null,
        onGround: f.status === 'onsurface' || (f.speedKts != null && f.speedKts < 50 && (f.altFt == null || f.altFt < 100)),
        trail: f.trail || [],
        hadTrail: !!(f.trail && f.trail.length),
        parked: false,
        airport: f.airport, runway: f.runway, status: f.status, event: f.event, // STDDS-specific extras, harmless if unused
        source: 'stdds',
    };
}

// TEMP — same purpose as swim.js's _testSeedFlight: creates a synthetic ground/taxi position for
// a test callsign. Needed specifically because swim.js's SFDPS-sourced positions always report
// onGround:false (not yet mapped from FIXM, see its file header) — a believable "taxiing" test
// flight has to come through here instead, since getGroundPosition() is the only source that
// actually derives a real onGround value (from speed/altitude/status).
function _testSeedFlight(callsign, { lat, lon, speedKts, altFt, heading, status, airport }) {
    const cs = String(callsign).trim().toUpperCase();
    const entry = _latest[cs] || (_latest[cs] = {});
    entry.lastMsg = Date.now();
    if (lat != null) entry.lat = lat;
    if (lon != null) entry.lon = lon;
    if (speedKts != null) entry.speedKts = speedKts;
    if (altFt != null) entry.altFt = altFt;
    if (heading != null) entry.heading = heading;
    if (status) entry.status = status;
    if (airport) entry.airport = airport;
    return true;
}

module.exports = { connect, getGroundPosition, setRelevantCallsigns, _testSeedFlight, isEnabled: () => STDDS_ENABLED };
