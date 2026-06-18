#!/usr/bin/env node
// Regenerates data/airports.json (city lookup) and public/airports.json (coord lookup)
// from data/airports_raw.csv (OurAirports full dataset, ~85k airports).
//
// Usage: node scripts/build-airports.js

const fs   = require('fs');
const path = require('path');

const CSV_PATH      = path.join(__dirname, '..', 'data', 'airports_raw.csv');
const CITIES_PATH   = path.join(__dirname, '..', 'data', 'airports.json');
const COORDS_PATH   = path.join(__dirname, '..', 'public', 'airports.json');

// Parse one CSV line, handling quoted fields with commas
function parseLine(line) {
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

function stateAbbr(isoRegion) {
    // "US-AZ" → "AZ", "CA-ON" → "ON", etc.
    if (!isoRegion) return null;
    const parts = isoRegion.split('-');
    return parts.length > 1 ? parts[1] : null;
}

function cityLabel(muni, isoRegion, isoCountry) {
    if (!muni) return null;
    const abbr = stateAbbr(isoRegion);
    if (abbr) return `${muni}, ${abbr}`;
    // International: append country code for clarity
    if (isoCountry && isoCountry !== 'US') return `${muni}, ${isoCountry}`;
    return muni;
}

const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n');
// id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,
// iso_country,iso_region,municipality,scheduled_service,
// icao_code,iata_code,gps_code,local_code,...
const HEADER = lines[0];

const cities  = {};  // code → "City, ST"
const coords  = {};  // code → [lat, lon]

// Track which IATA codes are "real" (assigned by IATA to a specific airport)
// vs local FAA codes that happen to be 3 letters. We use scheduled_service as
// a signal, but also prefer proper iata_code field over local_code for 3-letter keys.
const iataAssigned = new Set(); // IATA codes that appear in the iata_code field

let processed = 0, skipped = 0;

for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseLine(line);
    const ident     = cols[1]?.trim();
    const type      = cols[2]?.trim();
    const lat       = parseFloat(cols[4]);
    const lon       = parseFloat(cols[5]);
    const country   = cols[8]?.trim();
    const region    = cols[9]?.trim();
    const muni      = cols[10]?.trim();
    const icao      = cols[12]?.trim();
    const iata      = cols[13]?.trim();
    const gps       = cols[14]?.trim();
    const local     = cols[15]?.trim();

    if (!ident) { skipped++; continue; }

    const hasCoords = isFinite(lat) && isFinite(lon);
    const label = cityLabel(muni, region, country);

    // Collect all codes that should point to this airport
    const allCodes = new Set();
    if (ident) allCodes.add(ident.toUpperCase());
    if (icao  && icao  !== 'N/A' && icao  !== '\\N') allCodes.add(icao.toUpperCase());
    if (gps   && gps   !== 'N/A' && gps   !== '\\N') allCodes.add(gps.toUpperCase());
    // Only add iata_code (proper IATA assignment) for 3-letter entries — never local_code
    if (iata  && iata  !== 'N/A' && iata  !== '\\N' && iata.length === 3) {
        allCodes.add(iata.toUpperCase());
        iataAssigned.add(iata.toUpperCase());
    }

    for (const code of allCodes) {
        if (hasCoords && !coords[code]) coords[code] = [lat, lon];
        if (label    && !cities[code]) cities[code] = label;
    }

    processed++;
}

// Remove 3-letter city/coord entries where the code is actually a proper IATA code
// assigned to a DIFFERENT airport (the one with local_code matching but a different ident).
// We do this by a second pass: if a 3-letter code appears in iataAssigned, keep only
// the entry that was written when iata_code === that code (not from local_code).
// (Already handled by writing iata_code entries vs skipping local_code entries above.)

console.log(`Processed ${processed} airports, skipped ${skipped}`);
console.log(`City entries: ${Object.keys(cities).length}`);
console.log(`Coord entries: ${Object.keys(coords).length}`);

// Verify our problem airports
['KPAN','KBPG','KSXU','PAN','BPG','SXU'].forEach(k => {
    const c = cities[k], r = coords[k];
    console.log(`  ${k}: city=${c||'—'} coords=${r ? r.map(v=>v.toFixed(3)).join(',') : '—'}`);
});

fs.writeFileSync(CITIES_PATH, JSON.stringify(cities));
fs.writeFileSync(COORDS_PATH, JSON.stringify(coords));
console.log(`\nWrote ${CITIES_PATH}`);
console.log(`Wrote ${COORDS_PATH}`);
