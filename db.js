const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'dispatch.db');

function generateToken() {
    // 12-char URL-safe token — hard to guess, easy to share
    return crypto.randomBytes(9).toString('base64url').slice(0, 12);
}

let db = null;

function getDB() {
    if (!db) {
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('Error opening database:', err);
            } else {
                console.log('Connected to SQLite database at', DB_PATH);
                initDB();
            }
        });
    }
    return db;
}

function initDB() {
    const db = getDB();
    
    db.serialize(() => {
        // Pilots table
        db.run(`
            CREATE TABLE IF NOT EXISTS pilots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pilot_key TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                base TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Segments table (flights, hard days, away periods)
        db.run(`
            CREATE TABLE IF NOT EXISTS segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pilot_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                departure_time TEXT,
                arrival_time TEXT,
                departure_airport TEXT,
                arrival_airport TEXT,
                tail TEXT,
                trip TEXT,
                flight_number TEXT,
                is_dh BOOLEAN DEFAULT 0,
                is_manual BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE
            )
        `);
        // Settings table — generic key/value for persisting config across devices
        db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

        // Push notification subscriptions — one row per pilot+device
        db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pilot_key TEXT NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            subscription_json TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Notification history — deduped by crossing_key so re-uploads don't spam
        db.run(`CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pilot_key TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            url TEXT DEFAULT '/app?view=overlap',
            crossing_key TEXT UNIQUE,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Usage analytics — lightweight event log for feature adoption tracking
        db.run(`CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pilot_key TEXT NOT NULL,
            event TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Crew Intel — shared airport knowledge base (hotels, food, activities, tips)
        db.run(`CREATE TABLE IF NOT EXISTS crew_intel (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            airport_code TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'tip',
            title TEXT NOT NULL,
            body TEXT DEFAULT '',
            added_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Crew Intel votes — one row per (intel entry, pilot), UNIQUE enforces "one vote each,
        // can change it" rather than letting someone stack votes. vote is 1 or -1; a cleared
        // vote just deletes the row rather than storing a 0.
        db.run(`CREATE TABLE IF NOT EXISTS intel_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            intel_id INTEGER NOT NULL,
            pilot_key TEXT NOT NULL,
            vote INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(intel_id, pilot_key),
            FOREIGN KEY (intel_id) REFERENCES crew_intel(id) ON DELETE CASCADE
        )`);

        // Friend requests — one row per (requester, recipient) pair, UNIQUE enforces a single
        // request between any two pilots at a time (re-requesting after a decline just reuses
        // the same row rather than stacking a second one). status: 'pending' | 'accepted'.
        // A pair counts as friends when an accepted row exists in EITHER direction -- there's
        // no canonical ordering of requester/recipient, so every query checks both.
        db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_key TEXT NOT NULL,
            recipient_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            responded_at DATETIME,
            UNIQUE(requester_key, recipient_key)
        )`);

        // Migrations: add columns if they don't exist yet
        db.run(`ALTER TABLE segments ADD COLUMN is_manual BOOLEAN DEFAULT 0`, () => {});
        db.run(`ALTER TABLE segments ADD COLUMN block_minutes INTEGER`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN role TEXT DEFAULT ''`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN parser_type TEXT DEFAULT 'csv'`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN airline_code TEXT DEFAULT ''`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN home_airport TEXT DEFAULT ''`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN last_active TEXT`, () => {});
        // JSON array of strings describing anything the pilot's parser couldn't recognize on
        // its last run (new/unseen prefix, timezone abbreviation, line shape, etc.) — overwritten
        // each upload/sync, not accumulated, so it always reflects the most recent parse only.
        db.run(`ALTER TABLE pilots ADD COLUMN parser_warnings TEXT`, () => {});
        // One-time flag: has this pilot's pre-existing "Your Crew" visibility toggle (client-side
        // localStorage, never previously synced to the server) been imported as their starting
        // friend list yet? Prevents re-running the import after they've since customized their
        // real friend list by unfriending someone -- see POST /api/friends/seed.
        db.run(`ALTER TABLE pilots ADD COLUMN friends_seeded INTEGER DEFAULT 0`, () => {});
        // JSON array of pilot_keys this pilot has explicitly hidden from their "Your Crew"
        // display (map/pill bar/legend declutter). Replaces the old localStorage-only
        // crewVisible_<pilot> preference, which was per-browser and caused the same pilot to
        // show different visibility on desktop vs mobile for the same person. The new default
        // is "everyone allowed (self + friends) is visible unless explicitly hidden here" --
        // consistent with a friends-based model where befriending someone should show them
        // immediately, not require a second manual toggle. See GET/PUT /api/crew-visibility.
        db.run(`ALTER TABLE pilots ADD COLUMN hidden_crew TEXT DEFAULT '[]'`, () => {});
        // Pilot's brand color (hex), used for map arcs/legends/pill highlights throughout the
        // app. Previously hardcoded per pilot_key in app.html (PILOT_COLORS) with no DB backing
        // at all -- see the one-time coreRosterMigrated backfill below for where the original
        // values get copied in. NULL means "no assigned color yet"; the frontend falls back to
        // its auto-assigned rotating palette (_assignColor()) for any pilot without one.
        db.run(`ALTER TABLE pilots ADD COLUMN color TEXT`, () => {});

        // Backfill home_airport for known pilots where it hasn't been explicitly set.
        // home_airport = where the pilot LIVES; base = airline domicile (may differ for commuters).
        const knownHomes = { kyle: 'SUS', adam: 'TUL', sam: 'STL', logan: 'PHX', drew: 'STL' };
        Object.entries(knownHomes).forEach(([key, home]) => {
            db.run(
                `UPDATE pilots SET home_airport=? WHERE pilot_key=? AND (home_airport IS NULL OR home_airport='')`,
                [home, key]
            );
        });
        db.run(`ALTER TABLE pilots ADD COLUMN token TEXT`, () => {
            // Backfill tokens for any pilot that doesn't have one
            db.all(`SELECT id, pilot_key FROM pilots WHERE token IS NULL`, (err, rows) => {
                if (err || !rows) return;
                rows.forEach(row => {
                    db.run(`UPDATE pilots SET token=? WHERE id=?`, [generateToken(), row.id]);
                });
            });
        });

        // Seed initial pilots if not exists
        db.run(`
            INSERT OR IGNORE INTO pilots (pilot_key, name, base, home_airport)
            VALUES
                ('admin', 'Admin', '', ''),
                ('kyle',  'Kyle Kaestner', 'SUS', 'SUS'),
                ('adam',  'Adam Burke',    'LGA', 'TUL'),
                ('sam',   'Sam Byrne',     'LGA', 'STL'),
                ('logan', 'Logan Hine',    'PHX', 'PHX'),
                ('drew',  'Drew Sinelli',  'STL', 'STL')
        `, (err) => {
            if (err) {
                console.error('Error seeding pilots:', err);
            } else {
                console.log('Pilots table initialized');
            }
        });

        // One-time migration: copy the original hardcoded pilot config (server.js's old
        // pilotParsers/pilotAirlineCodes maps, and app.html's old PILOT_COLORS/PILOT_ROLES
        // objects) into the DB, then stop treating these 5-9 pilots as special. Before this,
        // the real values lived only in source code and silently overrode whatever was in these
        // DB columns -- which is exactly why the admin panel showed Drew as "Republic Airways"
        // (his real airline, GoJet, was never written to his DB row) and why editing these
        // pilots' airline through the admin panel didn't actually change their real parsing.
        // Guarded by settings.coreRosterMigrated so it only ever runs once -- after that, these
        // columns are normal, admin-editable pilot data like any other pilot's, and this block
        // must never overwrite a since-customized value.
        db.get(`SELECT value FROM settings WHERE key='coreRosterMigrated'`, (err, row) => {
            if (err || (row && row.value === '1')) return;
            const knownParsers = { kyle: 'schedaero', adam: 'csv', sam: 'csv', logan: 'vcs_skywest', drew: 'ics_rosterbuster' };
            const knownAirlineCodes = { kyle: 'SJJ', adam: 'RPA', sam: 'RPA', logan: 'SKW', drew: 'GJS' };
            const knownColors = {
                kyle: '#3b82f6', adam: '#2dd4bf', sam: '#f97316', logan: '#818cf8', drew: '#fb7185',
                brett: '#10b981', hunter: '#f59e0b', nick: '#e879f9', jack: '#38bdf8'
            };
            const knownRoles = {
                kyle: 'Corporate · SUS', adam: 'Regional · TUL', sam: 'Regional · STL',
                logan: 'Regional · PHX', drew: 'Regional · STL'
            };
            Object.entries(knownParsers).forEach(([key, parserType]) => {
                db.run(`UPDATE pilots SET parser_type=? WHERE pilot_key=?`, [parserType, key]);
            });
            Object.entries(knownAirlineCodes).forEach(([key, code]) => {
                db.run(`UPDATE pilots SET airline_code=? WHERE pilot_key=?`, [code, key]);
            });
            Object.entries(knownColors).forEach(([key, color]) => {
                db.run(`UPDATE pilots SET color=? WHERE pilot_key=? AND (color IS NULL OR color='')`, [color, key]);
            });
            Object.entries(knownRoles).forEach(([key, role]) => {
                db.run(`UPDATE pilots SET role=? WHERE pilot_key=? AND (role IS NULL OR role='')`, [role, key]);
            });
            db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('coreRosterMigrated', '1')`);
        });

        // One-time migration: view-only guests used to be exempt from the friends system
        // entirely (always saw every pilot, unconditionally). Gating them the same way real
        // pilots are gated means an existing viewer would otherwise instantly lose access to
        // everyone the moment this ships, with no friends yet to restore it. Seed each existing
        // viewer an already-accepted friendship with every real (non-viewer, non-admin) pilot,
        // preserving their current full access exactly -- admin can narrow it afterward via the
        // same per-user friend toggle already used for real pilots. Guarded by
        // settings.viewerFriendsSeeded so it only ever runs once; a viewer created after this
        // point starts with zero friends like any new pilot would, by design.
        db.get(`SELECT value FROM settings WHERE key='viewerFriendsSeeded'`, (err, row) => {
            if (err || (row && row.value === '1')) return;
            db.all(`SELECT pilot_key FROM pilots WHERE role = 'viewer'`, (err, viewers) => {
                if (err || !viewers || viewers.length === 0) {
                    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('viewerFriendsSeeded', '1')`);
                    return;
                }
                db.all(`SELECT pilot_key FROM pilots WHERE pilot_key != 'admin' AND (role IS NULL OR role != 'viewer')`, (err, pilotRows) => {
                    if (err) return;
                    viewers.forEach(v => {
                        (pilotRows || []).forEach(p => {
                            db.run(
                                `INSERT OR IGNORE INTO friend_requests (requester_key, recipient_key, status, responded_at) VALUES (?, ?, 'accepted', CURRENT_TIMESTAMP)`,
                                [v.pilot_key, p.pilot_key]
                            );
                        });
                    });
                    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('viewerFriendsSeeded', '1')`);
                });
            });
        });
    });
}

module.exports = { getDB, DB_PATH, generateToken };
