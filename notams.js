// notams.js — FAA SWIM AIM_FNS feed (NOTAM Distribution Service).
//
// Separate feed again: its own Solace VPN (AIM_FNS), independent of SFDPS/STDDS/TFMS/TFDM. The FAA's
// own subscription-portal paperwork for this one uses JMS-flavored field names ("Connection Factory",
// "JMS Connection URL") that look like a different broker (TIBCO EMS) at a glance -- confirmed live
// with a plain connection test that it's an ordinary Solace session, same solclientjs client as every
// other feed here, so no new client library is needed. STDDS's subscription paperwork used the same
// JMS-style naming (SCDSCONNECTION__*) and turned out to be the same situation.
//
// Field mapping below is UNVERIFIED against a live message — same starting point every other module
// in this file began at. Starts in diagnostic mode: dump real messages to inspect the actual schema
// before trusting any specific field name.

const solace = require('solclientjs');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

const NOTAM_HOST  = process.env.NOTAM_HOST;
const NOTAM_VPN   = process.env.NOTAM_VPN;
const NOTAM_USER  = process.env.NOTAM_USER;
const NOTAM_PASS  = process.env.NOTAM_PASS;
const NOTAM_QUEUE = process.env.NOTAM_QUEUE;

const NOTAM_ENABLED = !!(NOTAM_HOST && NOTAM_VPN && NOTAM_USER && NOTAM_PASS && NOTAM_QUEUE);

// Diagnostic mode: dump the first N raw messages to disk for schema inspection, then stop. Same
// one-time pattern already used in tfdm.js/tfms.js/swim.js when each one was first connected.
const DUMP_DIR = path.join(__dirname, 'scratch', 'notam-samples');
let _dumpCount = 0;
const DUMP_CAP = 20;
function dumpSample(xmlText) {
    if (_dumpCount >= DUMP_CAP) return;
    try {
        fs.mkdirSync(DUMP_DIR, { recursive: true });
        fs.writeFileSync(path.join(DUMP_DIR, `sample-${Date.now()}-${_dumpCount}.xml`), xmlText);
        _dumpCount++;
        if (_dumpCount === DUMP_CAP) console.log(`[NOTAM] collected ${DUMP_CAP} raw sample messages in ${DUMP_DIR} — inspect these to confirm real field names`);
    } catch (e) {
        console.warn('[NOTAM] sample dump failed:', e.message);
    }
}

let _connected = false;

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

function handleMessage(xmlText) {
    // No cheap pre-filter yet: unlike the position/route feeds, NOTAMs aren't naturally a
    // nationwide-firehose-of-everything problem (far lower message rate), so full parsing
    // isn't the same CPU risk swim.js's handleMessage had to guard against. Revisit if the
    // real volume turns out to be heavier than expected once connected.
    dumpSample(xmlText);
}

let session = null;
let messageConsumer = null;

function connect() {
    if (!NOTAM_ENABLED) {
        console.log('[NOTAM] NOTAM_* env vars not set — NOTAM data disabled');
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
        console.error('[NOTAM] Solace factory init failed:', e.message);
        return;
    }

    try {
        session = solace.SolclientFactory.createSession({
            url: NOTAM_HOST,
            vpnName: NOTAM_VPN,
            userName: NOTAM_USER,
            password: NOTAM_PASS,
            connectRetries: 5,
            reconnectRetries: -1,
        });
    } catch (e) {
        console.error('[NOTAM] session creation failed:', e.message);
        return;
    }

    session.on(solace.SessionEventCode.UP_NOTICE, () => {
        console.log('[NOTAM] session up, binding to queue', NOTAM_QUEUE);
        startConsumer();
    });
    session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
        console.error('[NOTAM] connect failed:', e?.message || e);
    });
    session.on(solace.SessionEventCode.DISCONNECTED, () => {
        console.warn('[NOTAM] session disconnected');
        _connected = false;
    });

    try {
        session.connect();
    } catch (e) {
        console.error('[NOTAM] session.connect() threw:', e.message);
    }
}

function startConsumer() {
    try {
        messageConsumer = session.createMessageConsumer({
            queueDescriptor: { name: NOTAM_QUEUE, type: solace.QueueType.QUEUE },
            acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
        });
    } catch (e) {
        console.error('[NOTAM] message consumer creation failed:', e.message);
        return;
    }

    messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
        console.log('[NOTAM] message consumer up — live NOTAM messages flowing');
        _connected = true;
    });
    messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (e) => {
        console.error('[NOTAM] consumer connect failed:', e?.message || e);
        _connected = false;
    });
    messageConsumer.on(solace.MessageConsumerEventName.DOWN, () => {
        console.warn('[NOTAM] message consumer down');
        _connected = false;
    });

    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
        try {
            const xmlText = message.getXmlContent();
            if (xmlText) handleMessage(xmlText);
        } catch (e) {
            console.warn('[NOTAM] message handling error:', e.message);
        } finally {
            try { message.acknowledge(); } catch (_) {}
        }
    });

    try {
        messageConsumer.connect();
    } catch (e) {
        console.error('[NOTAM] messageConsumer.connect() threw:', e.message);
    }
}

// TEMP — nothing to query yet; real getters come once the message shape is confirmed from the
// dumped samples and a parser is written against it.
function getNotamsForAirport(_icao) {
    return [];
}

module.exports = { connect, getNotamsForAirport, isEnabled: () => NOTAM_ENABLED };
