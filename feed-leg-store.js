// Per-leg feed history (TFMS leg times, TFDM legs) kept in SQLite, one row per leg.
//
// Replaces the .tfms_legtimes_cache.json / .tfdm_legs_cache.json files, which had to be rewritten
// whole on every change: with NetJets research mode that was a 13 MB + 3 MB rewrite about every
// 2 seconds, roughly a third of the droplet's only CPU (profiled 2026-11-16). Now only legs that
// changed are written, batched every FLUSH_MS in one transaction, on sqlite3's background thread.
//
// Its own database file (feed-cache.db), not dispatch.db: this is rebuildable feed data, and a
// separate connection means its write transactions never interleave with the app's own queries.
//
// The in-memory maps stay the source of truth for every reader; this only saves and restores them.
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

const FEED_DB_PATH = path.join(__dirname, 'feed-cache.db');
const FLUSH_MS = 10 * 1000;

let _db = null;
function feedDb(dbPath = FEED_DB_PATH) {
    if (_db) return _db;
    _db = new sqlite3.Database(dbPath, err => { if (err) console.error('[feed-store] open failed:', err.message); });
    _db.serialize(() => {
        _db.run('PRAGMA journal_mode = WAL');
        _db.run('PRAGMA synchronous = NORMAL');
        _db.run(`CREATE TABLE IF NOT EXISTS feed_leg (
            source TEXT NOT NULL,
            callsign TEXT NOT NULL,
            leg_key TEXT NOT NULL,
            data TEXT NOT NULL,
            last_msg INTEGER NOT NULL,
            PRIMARY KEY (source, callsign, leg_key)
        )`);
        _db.run('CREATE INDEX IF NOT EXISTS idx_feed_leg_last ON feed_leg (source, last_msg)');
    });
    return _db;
}

const all = (db, sql, args) => new Promise((ok, bad) => db.all(sql, args, (e, rows) => e ? bad(e) : ok(rows)));
const run = (db, sql, args) => new Promise((ok, bad) => db.run(sql, args, function (e) { e ? bad(e) : ok(this); }));
// One transaction at a time per connection: the TFMS and TFDM stores share it, and two BEGINs at once
// fail with 'cannot start a transaction within a transaction' (caught in testing, both importing at boot).
const _txChains = new WeakMap();
function inTx(db, fn) {
    const p = (_txChains.get(db) || Promise.resolve()).then(async () => {
        await run(db, 'BEGIN');
        try { await fn(); await run(db, 'COMMIT'); }
        catch (e) { await run(db, 'ROLLBACK').catch(() => {}); throw e; }
    });
    _txChains.set(db, p.catch(() => {}));
    return p;
}

// source: 'tfms' | 'tfdm'. legs: the module's { callsign: Map(legKey -> leg) } object.
// staleMsFor(cs): how long a leg is kept after its last message. maxStaleMs: the longest of those,
// for the database-side cleanup. legacyJsonPath: the old cache file, imported once if the table
// has nothing for this source yet, then renamed to .bak.
function createLegStore({ source, legs, staleMsFor, maxStaleMs, legacyJsonPath, db = null }) {
    const conn = db || feedDb();
    const dirty = new Set();      // `${cs}\t${key}`
    const goneCallsigns = new Set();
    let ready = false, flushing = false;
    let resolveReady;
    const whenReady = new Promise(r => { resolveReady = r; });

    // Saved data under whatever arrived since boot: a message processed before the restore finished
    // made a fresh, thinner record, and its newer fields win.
    function mergeIn(cs, key, saved) {
        if (Date.now() - (saved.lastMsg || 0) > staleMsFor(cs)) return;
        const map = legs[cs] || (legs[cs] = new Map());
        const cur = map.get(key);
        map.set(key, cur ? Object.assign(saved, cur) : saved);
        if (cur) dirty.add(cs + '\t' + key);
    }

    async function importLegacy() {
        if (!legacyJsonPath || !fs.existsSync(legacyJsonPath)) return 0;
        let saved;
        try { saved = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8')); }
        catch (e) { console.warn(`[feed-store] ${source}: legacy cache unreadable, skipped:`, e.message); return 0; }
        let n = 0;
        await inTx(conn, async () => {
            for (const [cs, entries] of Object.entries(saved)) for (const [key, leg] of entries) {
                await run(conn, 'INSERT OR REPLACE INTO feed_leg (source, callsign, leg_key, data, last_msg) VALUES (?,?,?,?,?)',
                    [source, cs, key, JSON.stringify(leg), leg.lastMsg || 0]);
                n++;
            }
        });
        try { fs.renameSync(legacyJsonPath, legacyJsonPath + '.bak'); } catch (_) {}
        console.log(`[feed-store] ${source}: imported ${n} legs from ${path.basename(legacyJsonPath)} (kept as .bak)`);
        return n;
    }

    async function load(attempt = 1) {
        try {
            const [{ c }] = await all(conn, 'SELECT COUNT(*) AS c FROM feed_leg WHERE source = ?', [source]);
            if (!c) await importLegacy();
            const rows = await all(conn, 'SELECT callsign, leg_key, data FROM feed_leg WHERE source = ? AND last_msg >= ?', [source, Date.now() - maxStaleMs]);
            for (const r of rows) { try { mergeIn(r.callsign, r.leg_key, JSON.parse(r.data)); } catch (_) {} }
            console.log(`[feed-store] ${source}: restored ${rows.length} legs`);
        } catch (e) {
            // Retried: ready gates the NetJets leg pass, and a pass on empty stores could hide legs. After
            // three tries it goes ready anyway so a broken cache can't stop leg creation for good. Saving
            // can't wipe stored history here the way rewriting a whole JSON file after a bad load did.
            console.error(`[feed-store] ${source}: restore failed (try ${attempt}/3):`, e.message);
            if (attempt < 3) { setTimeout(() => load(attempt + 1), 5000); return; }
        }
        ready = true; resolveReady();
    }

    async function flush() {
        if (!ready || flushing || (!dirty.size && !goneCallsigns.size)) return;
        flushing = true;
        const keys = [...dirty]; dirty.clear();
        const gone = [...goneCallsigns]; goneCallsigns.clear();
        try {
            await inTx(conn, async () => {
                for (const cs of gone) await run(conn, 'DELETE FROM feed_leg WHERE source = ? AND callsign = ?', [source, cs]);
                for (const k of keys) {
                    const [cs, key] = k.split('\t');
                    const leg = legs[cs] && legs[cs].get(key);
                    if (leg) await run(conn, 'INSERT OR REPLACE INTO feed_leg (source, callsign, leg_key, data, last_msg) VALUES (?,?,?,?,?)',
                        [source, cs, key, JSON.stringify(leg), leg.lastMsg || 0]);
                    else await run(conn, 'DELETE FROM feed_leg WHERE source = ? AND callsign = ? AND leg_key = ?', [source, cs, key]);
                }
                await run(conn, 'DELETE FROM feed_leg WHERE source = ? AND last_msg < ?', [source, Date.now() - maxStaleMs]);
            });
        } catch (e) {
            for (const k of keys) dirty.add(k);
            for (const cs of gone) goneCallsigns.add(cs);
            console.error(`[feed-store] ${source}: save failed, will retry:`, e.message);
        } finally { flushing = false; }
    }

    const timer = setInterval(flush, FLUSH_MS);
    if (timer.unref) timer.unref();
    load();

    return {
        markDirty(cs, key) { dirty.add(cs + '\t' + key); },
        markCallsignGone(cs) { goneCallsigns.add(cs); for (const k of dirty) if (k.startsWith(cs + '\t')) dirty.delete(k); },
        isReady: () => ready,
        whenReady,
        flush,
    };
}

module.exports = { createLegStore, feedDb, FEED_DB_PATH };
