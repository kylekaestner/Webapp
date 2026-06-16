#!/usr/bin/env node
// One-shot script: pulls crew intel from prod and imports into local server.
// Usage: node scripts/import-intel.js https://your-prod-url.com

const PROD_URL = process.argv[2];
const LOCAL_URL = process.argv[3] || 'http://localhost:3000';

if (!PROD_URL) {
    console.error('Usage: node scripts/import-intel.js <prod-url> [local-url]');
    console.error('  e.g. node scripts/import-intel.js https://crewsync.up.railway.app');
    process.exit(1);
}

async function run() {
    console.log(`Fetching intel from ${PROD_URL}/api/intel ...`);
    const res = await fetch(`${PROD_URL}/api/intel`);
    if (!res.ok) throw new Error(`Prod fetch failed: ${res.status} ${res.statusText}`);
    const rows = await res.json();
    console.log(`Got ${rows.length} entries. Importing into ${LOCAL_URL} ...`);

    let inserted = 0, skipped = 0;
    for (const row of rows) {
        const body = {
            airport_code: row.airport_code,
            category:     row.category,
            title:        row.title,
            body:         row.body || '',
            pilot_key:    row.added_by || 'kyle',
        };
        const r = await fetch(`${LOCAL_URL}/api/intel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (r.ok) {
            inserted++;
            console.log(`  ✓ [${row.airport_code}] ${row.category} — ${row.title}`);
        } else {
            skipped++;
            console.warn(`  ✗ Failed [${row.airport_code}] ${row.title}: ${r.status}`);
        }
    }

    console.log(`\nDone. ${inserted} imported, ${skipped} failed.`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
