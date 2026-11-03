#!/usr/bin/env node
// Refreshes data/nasr/airports.json from the FAA's current NASR 28-day cycle -- every US airport's
// FAA ID, ICAO ID, coordinates, name/city/state, plus an IANA timezone computed from coordinates
// (tz-lookup, a devDependency: zones are baked into the output, so the server needs nothing new).
//
//   node scripts/update-nasr-airports.js            # download current cycle, check, write
//   node scripts/update-nasr-airports.js --dry-run  # same checks, writes nothing
//   node scripts/update-nasr-airports.js --force    # write even if the checks below fail
//
// Then rebuild the app's table (node scripts/build-airports.js), commit, and deploy. NASR has no
// timezone column and covers the US only -- see "Airport data" in CLAUDE.md for how the server and
// app use this file alongside OurAirports/OpenFlights for the rest of the world.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tzlookup = require('tz-lookup');

const OUT = path.join(__dirname, '..', 'data', 'nasr', 'airports.json');
const INDEX_URL = 'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/';
const UA = { 'User-Agent': 'Mozilla/5.0 (CrewSync NASR airport refresh)' };
const args = new Set(process.argv.slice(2));

// Airports that must never move or vanish: pilots' homes/bases and recent problem fields.
const WATCH = ['KSUS', 'KSTL', 'KLGA', 'KTUL', 'KPHX', 'KSFO', 'KDFW', 'KSAT', 'KCQF', 'KBKV', 'KDJT', 'E38', '27K'];

async function fetchText(url) {
    const r = await fetch(url, { headers: UA, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.text();
}

// Latest cycle whose effective date has arrived.
async function currentCycle() {
    const html = await fetchText(INDEX_URL);
    const today = new Date().toISOString().slice(0, 10);
    const dates = [...new Set([...html.matchAll(/NASR_Subscription\/(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]))]
        .filter(d => d <= today).sort();
    if (!dates.length) throw new Error('no NASR cycles found on the index page');
    return dates[dates.length - 1];
}

async function aptZipUrl(cycle) {
    const html = await fetchText(`${INDEX_URL}${cycle}/`);
    const m = html.match(/https:\/\/[^"']*APT[^"']*CSV[^"']*\.zip/);
    if (!m) throw new Error(`no APT CSV link on the ${cycle} cycle page`);
    return m[0];
}

// Minimal zip reader (central directory + inflateRaw) -- avoids a zip dependency.
function readZipEntry(buf, name) {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('not a zip file');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(p + 10), compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        const localOff = buf.readUInt32LE(p + 42);
        const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
        if (entryName === name) {
            const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
            const data = buf.subarray(localOff + 30 + lNameLen + lExtraLen, localOff + 30 + lNameLen + lExtraLen + compSize);
            return method === 0 ? data : zlib.inflateRawSync(data);
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error(`${name} not found in zip`);
}

// Quoted-CSV line parser (NASR text fields can contain commas) -- same as build-navdata.js.
function parseCsvLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

const kmBetween = (a, b) => {
    const dLat = a[0] - b[0], dLon = (a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon) * 111;
};

(async () => {
    const cycle = await currentCycle();
    const url = await aptZipUrl(cycle);
    console.log(`NASR cycle ${cycle}\n  ${url}`);
    const zip = Buffer.from(await (await fetch(url, { headers: UA })).arrayBuffer());
    const lines = readZipEntry(zip, 'APT_BASE.csv').toString('latin1').split(/\r?\n/).filter(Boolean);
    const head = parseCsvLine(lines[0]);
    const col = n => { const i = head.indexOf(n); if (i < 0) throw new Error(`APT_BASE.csv has no ${n} column`); return i; };
    const C = { faa: col('ARPT_ID'), icao: col('ICAO_ID'), name: col('ARPT_NAME'), city: col('CITY'), state: col('STATE_CODE'),
        lat: col('LAT_DECIMAL'), lon: col('LONG_DECIMAL'), type: col('SITE_TYPE_CODE'), use: col('FACILITY_USE_CODE') };

    const airports = [];
    for (const line of lines.slice(1)) {
        const r = parseCsvLine(line);
        const lat = parseFloat(r[C.lat]), lon = parseFloat(r[C.lon]);
        if (!r[C.faa] || !isFinite(lat) || !isFinite(lon)) continue;
        let tz = null;
        try { tz = tzlookup(lat, lon); } catch (_) {}
        airports.push({ faa: r[C.faa].trim(), icao: r[C.icao].trim() || null, lat: +lat.toFixed(6), lon: +lon.toFixed(6), tz,
            name: r[C.name].trim(), city: r[C.city].trim(), state: r[C.state].trim(), type: r[C.type].trim(), use: r[C.use].trim() });
    }
    console.log(`  ${airports.length} airports, ${airports.filter(a => a.icao).length} with an ICAO ID, ${airports.filter(a => !a.tz).length} without a timezone`);

    // Checks against the previous file: nothing important moved or vanished, no mass removal.
    const problems = [];
    const byCode = new Map();
    for (const a of airports) { byCode.set(a.faa, a); if (a.icao) byCode.set(a.icao, a); }
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
    for (const code of WATCH) {
        const a = byCode.get(code);
        if (!a) { problems.push(`${code} missing`); continue; }
        const old = prev && prev.airports.find(x => x.faa === code || x.icao === code);
        if (old && kmBetween([a.lat, a.lon], [old.lat, old.lon]) > 2) problems.push(`${code} moved ${kmBetween([a.lat, a.lon], [old.lat, old.lon]).toFixed(1)} km`);
        if (old && old.tz !== a.tz) problems.push(`${code} timezone ${old.tz} -> ${a.tz}`);
    }
    if (prev) {
        const now = new Set(airports.map(a => a.faa));
        const removed = prev.airports.filter(a => !now.has(a.faa));
        const added = airports.length - (prev.airports.length - removed.length);
        console.log(`  vs previous (cycle ${prev.cycle}): +${added} added, -${removed.length} removed`);
        if (removed.length > prev.airports.length * 0.03) problems.push(`${removed.length} airports removed (>3%)`);
        const renamed = airports.filter(a => { const o = prev.airports.find(x => x.faa === a.faa); return o && o.icao && a.icao && o.icao !== a.icao; });
        renamed.slice(0, 10).forEach(a => console.log(`  ICAO changed: ${a.faa} ${prev.airports.find(x => x.faa === a.faa).icao} -> ${a.icao}`));
    }
    if (problems.length) {
        console.log(`\nCHECKS FAILED:\n  - ${problems.join('\n  - ')}`);
        if (!args.has('--force')) { console.log('Nothing written (use --force to write anyway).'); process.exit(1); }
    } else console.log('  checks passed');

    if (args.has('--dry-run')) { console.log('Dry run -- nothing written.'); return; }
    fs.writeFileSync(OUT, JSON.stringify({ cycle, generated: new Date().toISOString(), source: url, airports }));
    console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);

    // Same cycle's fixes / navaids / SIDs / STARs / airways for the live map's route display
    // (data/nasr/{fixes,navaids,procedures,airways}.json via build-navdata.js). Previous files are
    // kept and restored if the rebuild fails or anything shrinks suspiciously.
    if (!args.has('--airports-only')) await refreshNavdata(cycle);
    console.log('\nNext: node scripts/build-airports.js, then commit and deploy (server restart needed).');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });

async function refreshNavdata(cycle) {
    const os = require('os');
    const { execFileSync } = require('child_process');
    const NAV_DIR = path.join(__dirname, '..', 'data', 'nasr');
    const FILES = ['fixes.json', 'navaids.json', 'procedures.json', 'airways.json'];
    const SETS = { FIX: 'FIX_BASE.csv', NAV: 'NAV_BASE.csv', DP: 'DP_RTE.csv', STAR: 'STAR_RTE.csv', AWY: 'AWY_BASE.csv' };
    const page = await fetchText(`${INDEX_URL}${cycle}/`);
    const src = fs.mkdtempSync(path.join(os.tmpdir(), `nasr-${cycle}-`));
    for (const [set, csv] of Object.entries(SETS)) {
        const m = page.match(new RegExp(`https://[^"']*_${set}_CSV\\.zip`));
        if (!m) throw new Error(`no ${set} CSV link on the ${cycle} cycle page`);
        const zip = Buffer.from(await (await fetch(m[0], { headers: UA })).arrayBuffer());
        fs.mkdirSync(path.join(src, set), { recursive: true });
        fs.writeFileSync(path.join(src, set, csv), readZipEntry(zip, csv));
        console.log(`  ${set}: ${csv}`);
    }
    const size = f => { try { const d = JSON.parse(fs.readFileSync(path.join(NAV_DIR, f), 'utf8')); return f === 'procedures.json' ? Object.keys(d.sids || {}).length + Object.keys(d.stars || {}).length : Object.keys(d).length; } catch (_) { return 0; } };
    const before = Object.fromEntries(FILES.map(f => [f, size(f)]));
    const backup = Object.fromEntries(FILES.map(f => { try { return [f, fs.readFileSync(path.join(NAV_DIR, f))]; } catch (_) { return [f, null]; } }));
    const restore = why => {
        for (const [f, buf] of Object.entries(backup)) if (buf) fs.writeFileSync(path.join(NAV_DIR, f), buf);
        console.log(`NAVDATA NOT UPDATED (${why}) -- previous files restored.`);
    };
    try { execFileSync(process.execPath, [path.join(__dirname, 'build-navdata.js'), src], { stdio: 'inherit' }); }
    catch (e) { return restore('build-navdata.js failed'); }
    const after = Object.fromEntries(FILES.map(f => [f, size(f)]));
    FILES.forEach(f => console.log(`  ${f}: ${before[f]} -> ${after[f]}`));
    const shrunk = FILES.filter(f => before[f] && after[f] < before[f] * 0.97);
    const procs = JSON.parse(fs.readFileSync(path.join(NAV_DIR, 'procedures.json'), 'utf8'));
    const missing = ['TBIRD8', 'ALISS7'].filter(p => !procs.sids?.[p] && !procs.stars?.[p]);
    if (shrunk.length && !args.has('--force')) return restore(`shrank >3%: ${shrunk.join(', ')}`);
    if (missing.length && !args.has('--force')) return restore(`missing procedures: ${missing.join(', ')}`);
    fs.rmSync(src, { recursive: true, force: true });
    console.log('  navdata checks passed');
}
