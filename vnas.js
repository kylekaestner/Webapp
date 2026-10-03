// vnas.js — resolves a real ATC frequency for the sector/unit SFDPS hands us on a boundary
// crossing (see swim.js's processOneMessage: entry.sector = { unit, sectorId }, e.g.
// { unit: 'ZID', sectorId: '21' }), by cross-referencing VATSIM's own public vNAS data API.
//
// SFDPS itself carries no frequency field anywhere (confirmed against real captured messages,
// 2026-10-02) — only a facility+sector identifier. VATSIM's vNAS platform maintains a real,
// continuously-updated facility→position→frequency database modeled on actual FAA structure
// (VATSIM simulates real-world ATC for training/events, so its facility data mirrors the real
// NAS). Confirmed directly against the live API before writing any of this: GET
// https://data-api.vnas.vatsim.net/api/artccs/ returns every ARTCC's full facility tree, and
// ZID's sector 21 resolves to position "IND_21_CTR" at 124.625 MHz — matching reality.
//
// Two distinct linkage shapes, both confirmed against real downloaded data:
//   - Enroute (ARTCC, numeric sectorId, e.g. "21"): a position with
//     position.eramConfiguration.sectorId === sectorId carries the frequency directly.
//   - Terminal (TRACON/tower, lettered sectorId, e.g. "B"): the facility's own
//     starsConfiguration.tcps[] has { sectorId, id }; a position links to it via
//     position.starsConfiguration.tcpId === that tcps entry's id, and THAT position carries
//     the frequency.
// Not every real FAA facility SFDPS can name is actually modeled in vNAS — confirmed: "SDA"
// from a real handoff doesn't exist anywhere in vNAS's data at all (VATSIM doesn't necessarily
// simulate every small satellite TRACON). That's accepted as a real, known gap, not a bug to
// work around — getFrequency() just returns null for anything it can't find, same posture as
// navdata.js's own "anything unresolvable is omitted, not guessed at" rule.

const VNAS_URL = 'https://data-api.vnas.vatsim.net/api/artccs/';
// vNAS's own facility/frequency data is near-static (the one real ARTCC checked during
// development had an eramDataLastUpdatedAt from over a week prior) — refreshing every 6h keeps
// this reasonably current without re-downloading the full ~15MB nationwide payload needlessly
// often. The raw payload itself is never kept in memory past building the index below.
const REFRESH_MS = 6 * 60 * 60 * 1000;

// facilityId -> Map(sectorId string -> { frequency (Hz), callsign }). Built fresh on every
// refresh and swapped in atomically so a lookup mid-refresh never sees a half-built index.
let _index = {};
let _lastRefresh = 0;

function indexFacility(facility, index) {
    if (!facility) return;
    const positions = facility.positions || [];
    const map = new Map();

    // Enroute (ARTCC): position.eramConfiguration.sectorId -> this position's own frequency.
    for (const p of positions) {
        const sid = p.eramConfiguration?.sectorId;
        if (sid != null && p.frequency) map.set(String(sid), { frequency: p.frequency, callsign: p.callsign });
    }

    // Terminal (TRACON/tower): facility.starsConfiguration.tcps[] (sectorId -> tcp id) joined
    // against position.starsConfiguration.tcpId (tcp id -> this position's frequency). Doesn't
    // overwrite an enroute match already found above for the same sectorId string (shouldn't
    // collide in practice -- different facilities and ID shapes -- but enroute is the more
    // common/confirmed case, so it wins if it somehow did).
    const tcps = facility.starsConfiguration?.tcps || [];
    if (tcps.length) {
        const tcpIdToSector = new Map(tcps.map(t => [t.id, String(t.sectorId)]));
        for (const p of positions) {
            const tcpId = p.starsConfiguration?.tcpId;
            const sid = tcpId && tcpIdToSector.get(tcpId);
            if (sid != null && p.frequency && !map.has(sid)) map.set(sid, { frequency: p.frequency, callsign: p.callsign });
        }
    }

    if (map.size) index[facility.id] = map;

    for (const child of (facility.childFacilities || [])) indexFacility(child, index);
}

// Confirmed live: a direct curl of this ~15MB endpoint from the prod droplet takes under 2s on
// its own, but the very first refresh (fired from inside app.listen()'s callback, at the same
// moment the four SFDPS/STDDS/TFMS/TFDM Solace sessions are all also connecting) timed out at
// 30s anyway -- event-loop/network contention at cold start, not a real slowness in this
// endpoint. A generous 60s timeout plus a quick retry (rather than waiting the full 6h for the
// next scheduled attempt) makes a one-off startup hiccup self-heal instead of silently leaving
// the frequency feature dark until the next interval fires.
async function refresh(isRetry = false) {
    try {
        const resp = await fetch(VNAS_URL, { signal: AbortSignal.timeout(60000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const list = await resp.json();
        const newIndex = {};
        for (const artcc of list) indexFacility(artcc.facility, newIndex);
        _index = newIndex; // atomic swap
        _lastRefresh = Date.now();
        console.log(`[vNAS] frequency index refreshed: ${Object.keys(_index).length} facilities`);
    } catch (e) {
        console.warn(`[vNAS] frequency refresh failed${isRetry ? ' (retry)' : ''}, keeping previous data:`, e.message);
        if (!isRetry) setTimeout(() => refresh(true), 30000);
    }
}

function connect() {
    refresh();
    setInterval(refresh, REFRESH_MS);
}

// Returns { frequency (Hz), callsign } for a real resolved match, or null -- never a guess.
function getFrequency(facilityId, sectorId) {
    if (!facilityId || sectorId == null) return null;
    const map = _index[facilityId];
    if (!map) return null;
    return map.get(String(sectorId)) || null;
}

module.exports = { connect, getFrequency };
