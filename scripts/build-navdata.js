#!/usr/bin/env node
// Regenerates data/nasr/*.json from FAA NASR 28-Day Subscription CSV data (public domain,
// same license posture as the OurAirports data build-airports.js already uses — not a
// licensed product like Navigraph).
//
// Source files expected under the directory passed as argv[2] (default: scratch/), extracted
// from the FAA's per-category CSV zips (FIX, NAV, DP, STAR, AWY) — see
// https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/ for the
// current 28-day cycle's download links:
//   FIX/FIX_BASE.csv   — named fixes/waypoints (lat/lon)
//   NAV/NAV_BASE.csv   — navaids: VOR/VORTAC/NDB (lat/lon)
//   DP/DP_RTE.csv      — SID (departure procedure) fix sequences
//   STAR/STAR_RTE.csv  — STAR (arrival procedure) fix sequences
//   AWY/AWY_BASE.csv   — airway fix sequences (space-separated AIRWAY_STRING)
//
// Usage: node scripts/build-navdata.js [sourceDir]

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || path.join(__dirname, '..', 'scratch');
const OUT_DIR = path.join(__dirname, '..', 'data', 'nasr');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Same quoted-CSV-field parser as build-airports.js (NASR's remark/text fields can contain commas).
function parseCsvLine(line) {
    const cols = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
        cur += ch;
    }
    cols.push(cur);
    return cols;
}

function readCsv(relPath) {
    const full = path.join(SRC, relPath);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean);
    const header = parseCsvLine(lines[0]);
    return lines.slice(1).map(line => {
        const cols = parseCsvLine(line);
        const row = {};
        header.forEach((h, i) => { row[h] = cols[i]; });
        return row;
    });
}

// ── FIX_BASE.csv → data/nasr/fixes.json: { "BROKE": [{lat, lon, state, region}, ...] } ──
// Array per identifier since fix names are NOT globally unique — disambiguation by proximity
// happens at lookup time, not here.
console.log('Parsing FIX_BASE.csv...');
const fixRows = readCsv('FIX/FIX_BASE.csv');
const fixes = {};
for (const r of fixRows) {
    const id = r.FIX_ID;
    const lat = parseFloat(r.LAT_DECIMAL), lon = parseFloat(r.LONG_DECIMAL);
    if (!id || isNaN(lat) || isNaN(lon)) continue;
    // FIX_USE_CODE distinguishes a classic airway intersection/reporting point ("RP", the
    // pre-RNAV convention pilots report position over) from an RNAV waypoint ("WP", the
    // overwhelming majority — 47k of ~70k fixes). Kept as the map-marker-symbol distinction
    // the map asks for: fix/intersection vs waypoint.
    (fixes[id] = fixes[id] || []).push({ lat, lon, state: r.STATE_CODE || null, region: r.ICAO_REGION_CODE || null, useCode: r.FIX_USE_CODE?.trim() || null });
}
fs.writeFileSync(path.join(OUT_DIR, 'fixes.json'), JSON.stringify(fixes));
console.log(`  ${Object.keys(fixes).length} unique fix identifiers, ${fixRows.length} rows`);

// ── NAV_BASE.csv → data/nasr/navaids.json: { "CKW": [{lat, lon, type, state}, ...] } ──
console.log('Parsing NAV_BASE.csv...');
const navRows = readCsv('NAV/NAV_BASE.csv');
const navaids = {};
for (const r of navRows) {
    const id = r.NAV_ID;
    const lat = parseFloat(r.LAT_DECIMAL), lon = parseFloat(r.LONG_DECIMAL);
    if (!id || isNaN(lat) || isNaN(lon)) continue;
    (navaids[id] = navaids[id] || []).push({ lat, lon, type: r.NAV_TYPE || null, state: r.STATE_CODE || null });
}
fs.writeFileSync(path.join(OUT_DIR, 'navaids.json'), JSON.stringify(navaids));
console.log(`  ${Object.keys(navaids).length} unique navaid identifiers, ${navRows.length} rows`);

// ── DP_RTE.csv / STAR_RTE.csv → data/nasr/procedures.json ──
// Keyed by "BASENAME" (e.g. "FORPE1", stripped of any ".transition" suffix the computer code
// carries) → { sid: true/false, transitions: { "ABQ": ["SPRKY","FORPE",...,"ABQ"], ... },
// bodies: [["JINOL","SPRKY",...], ...] }. A procedure can have MULTIPLE distinct body segments
// (e.g. runway-specific initial legs) grouped by ROUTE_NAME+BODY_SEQ — these must be kept
// separate, not flattened into one list, since each one's own POINT_SEQ restarts independently
// and interleaving them produces a jumbled, wrong sequence (caught by spot-checking FORPE1
// against a real route before trusting this). TRANSITION rows are the transition-specific tail
// appended after whichever body segment applies; a route string only ever names the procedure +
// (sometimes) one transition fix, so the resolver picks the transition whose key matches.
function buildProcedures(rows, codeField, isSid) {
    const procs = {};
    const bodyGroups = {}; // baseName -> { "ROUTE_NAME|BODY_SEQ": [{seq,point}, ...] }
    for (const r of rows) {
        const code = r[codeField];
        if (!code) continue;
        // Confirmed against real rows: SIDs format the computer code as "NAME.transition" (e.g.
        // "ACCRA5.ACCRA") — name first. STARs do the OPPOSITE: "transition.NAME" (e.g.
        // "KOLTS.KOLTS2", "USIRE.KOLTS2") — the real STAR name is the SECOND segment, not the
        // first. Missing this entirely silently keyed every STAR under its transition/body-group
        // name instead of its real identifier — caught by testing KOLTS2 against a real route
        // and finding it simply wasn't in the table at all.
        const baseName = isSid ? code.split('.')[0] : (code.includes('.') ? code.split('.')[1] : code);
        const proc = procs[baseName] || (procs[baseName] = { sid: isSid, transitions: {} });
        const seq = parseInt(r.POINT_SEQ, 10);
        const point = r.POINT;
        if (!point) continue;
        if (r.ROUTE_PORTION_TYPE === 'BODY') {
            const groups = bodyGroups[baseName] || (bodyGroups[baseName] = {});
            const groupKey = `${r.ROUTE_NAME || ''}|${r.BODY_SEQ || ''}`;
            (groups[groupKey] = groups[groupKey] || []).push({ seq, point });
        } else {
            // TRANSITION_COMPUTER_CODE follows the same name-order convention as above: SID
            // transitions are "NAME.transition" (strip the prefix), STAR transitions are
            // "transition.NAME" (the transition name is the part BEFORE the dot instead).
            const rawTrans = r.TRANSITION_COMPUTER_CODE || '';
            let transName;
            if (!rawTrans) transName = code.includes('.') ? code.split('.')[1] : 'default';
            else if (isSid) transName = rawTrans.includes('.') ? rawTrans.split('.').slice(1).join('.') : rawTrans;
            else transName = rawTrans.includes('.') ? rawTrans.split('.')[0] : rawTrans;
            const list = proc.transitions[transName] || (proc.transitions[transName] = []);
            list.push({ seq, point });
        }
    }
    for (const [baseName, proc] of Object.entries(procs)) {
        const groups = bodyGroups[baseName] || {};
        proc.bodies = Object.values(groups).map(list => list.sort((a, b) => a.seq - b.seq).map(p => p.point));
        for (const [k, list] of Object.entries(proc.transitions)) {
            list.sort((a, b) => a.seq - b.seq);
            proc.transitions[k] = list.map(p => p.point);
        }
    }
    return procs;
}

console.log('Parsing DP_RTE.csv (SIDs)...');
const dpRows = readCsv('DP/DP_RTE.csv');
const sids = buildProcedures(dpRows, 'DP_COMPUTER_CODE', true);
console.log(`  ${Object.keys(sids).length} unique SIDs, ${dpRows.length} rows`);

console.log('Parsing STAR_RTE.csv...');
const starRows = readCsv('STAR/STAR_RTE.csv');
const stars = buildProcedures(starRows, 'STAR_COMPUTER_CODE', false);
console.log(`  ${Object.keys(stars).length} unique STARs, ${starRows.length} rows`);

fs.writeFileSync(path.join(OUT_DIR, 'procedures.json'), JSON.stringify({ sids, stars }));

// ── AWY_BASE.csv → data/nasr/airways.json: { "J217": ["fix1","fix2",...] } ──
console.log('Parsing AWY_BASE.csv...');
const awyRows = readCsv('AWY/AWY_BASE.csv');
const airways = {};
for (const r of awyRows) {
    const id = r.AWY_ID;
    if (!id || !r.AIRWAY_STRING) continue;
    airways[id] = r.AIRWAY_STRING.trim().split(/\s+/);
}
fs.writeFileSync(path.join(OUT_DIR, 'airways.json'), JSON.stringify(airways));
console.log(`  ${Object.keys(airways).length} unique airways, ${awyRows.length} rows`);

console.log('Done. Output in data/nasr/');
