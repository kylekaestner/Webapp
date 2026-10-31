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
        // Flight log: one row per callsign per UTC day, recording when it was first seen airborne and when
        // it parked. Kept for a week so flight state survives restarts and can be checked afterwards.
        db.run(`CREATE TABLE IF NOT EXISTS flight_log (
            callsign TEXT NOT NULL,
            day TEXT NOT NULL,
            origin TEXT,
            dest TEXT,
            airborne_at INTEGER,
            parked_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (callsign, day)
        )`);
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

        // A pilot's airline base can change over time (a regional reassignment, e.g. Sam's
        // LGA -> ORD move effective Nov 2026) -- pilots.base is still the CURRENT/forward-looking
        // value (admin panel, My Info, map "here now" pin all want "today's" base), but any
        // date-sensitive logic over past segments (buildGroundPeriods's base-skip rule,
        // inferAwayLayovers) must judge an old arrival against whichever base actually applied
        // back then, not today's. One row per base period; effective_from is inclusive and rows
        // are read in ascending order to find the one in effect on a given date. A pilot who's
        // never had a recorded base change simply has no rows here, and every call site falls
        // back to pilots.base untouched -- this table is purely additive.
        db.run(`CREATE TABLE IF NOT EXISTS pilot_base_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pilot_id INTEGER NOT NULL,
            base TEXT NOT NULL,
            effective_from TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_pilot_base_history_pilot ON pilot_base_history(pilot_id)`);

        // NetJets-style manual tracking (parser_type 'manual_netjets' -- no feed exists, see
        // CLAUDE.md's "FAA SWIM integration"/memory netjets_tracking_plan for the full design).
        // Rotation cadence is history-preserving like pilot_base_history above -- a pilot's
        // schedule pattern itself can change (7&7 -> 8&6, etc.), and past dates must keep
        // resolving against whatever cadence was actually in effect then, not today's current one.
        db.run(`CREATE TABLE IF NOT EXISTS pilot_duty_rotation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pilot_id INTEGER NOT NULL,
            anchor_date TEXT NOT NULL,
            days_on INTEGER NOT NULL,
            days_off INTEGER NOT NULL,
            effective_from TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE,
            UNIQUE(pilot_id, effective_from)
        )`);
        // Migration for a table that may already exist (pre-dates the UNIQUE constraint above) --
        // real duplicate rows were found live (several test saves on the same day, all sharing
        // the same effective_from with no tie-breaker, which made the "most recent" row
        // ambiguous and could resolve to a stale one). Keep only the latest (highest id) per
        // (pilot_id, effective_from) before adding the index, or the index creation itself would
        // fail against the existing duplicates.
        db.run(`DELETE FROM pilot_duty_rotation WHERE id NOT IN (
            SELECT MAX(id) FROM pilot_duty_rotation GROUP BY pilot_id, effective_from
        )`, () => {
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pilot_duty_rotation_unique ON pilot_duty_rotation(pilot_id, effective_from)`, () => {});
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_pilot_duty_rotation_pilot ON pilot_duty_rotation(pilot_id)`);

        // One tail per tour instance, keyed by that tour's own on-duty start date (not per-leg --
        // explicitly rejected as too much manual entry). UNIQUE so re-saving the same tour's tail
        // (a correction, or a mid-tour swap recorded after the fact) updates via ON CONFLICT
        // instead of stacking a duplicate row.
        db.run(`CREATE TABLE IF NOT EXISTS pilot_tour_tail (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pilot_id INTEGER NOT NULL,
            tour_start_date TEXT NOT NULL,
            tail TEXT NOT NULL,
            start_airport TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE,
            UNIQUE(pilot_id, tour_start_date)
        )`);
        // Covers a table that may have already been created (locally, pre-deploy) without this
        // column -- harmless no-op once the column already exists.
        db.run(`ALTER TABLE pilot_tour_tail ADD COLUMN start_airport TEXT`, () => {});
        db.run(`CREATE INDEX IF NOT EXISTS idx_pilot_tour_tail_pilot ON pilot_tour_tail(pilot_id)`);

        // A line-to-line switch (7&7<->8&6 or within the same family) isn't a clean cutover --
        // confirmed directly from the real "Seam Visualizer" tool's own source: there's a real
        // 28-day day-by-day transition pattern (data/seam-table-a.txt/seam-table-b.txt, parsed
        // into public/seam-tables.json by scripts/build-seam-tables.js) that overrides the normal
        // on/off formula during that window. One row per switch (history-preserving, same spirit
        // as pilot_duty_rotation) -- only ever inserted when there WAS a previous rotation to
        // switch FROM; a first-time setup has nothing to seam from.
        db.run(`CREATE TABLE IF NOT EXISTS pilot_duty_rotation_seam (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pilot_id INTEGER NOT NULL,
            window_start_date TEXT NOT NULL,
            from_key TEXT NOT NULL,
            to_key TEXT NOT NULL,
            table_letter TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_pilot_duty_rotation_seam_pilot ON pilot_duty_rotation_seam(pilot_id)`);

        // CC52/60/72/76 schedules aren't a formula at all -- confirmed directly from a real
        // pilot's monthly schedule email: NetJets sends a literal day-by-day export (Date,
        // Status), bid monthly, with no feed CrewSync can pull. A CC pilot pastes that email text
        // in and it's parsed into one row per day here. Explicit day records are the highest-
        // precedence signal for on-duty/off-duty -- they override both the Line-formula rotation
        // AND any seam transition for the same date, since this is literally what NetJets says is
        // actually happening that day, not an inference.
        db.run(`CREATE TABLE IF NOT EXISTS pilot_cc_schedule_day (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pilot_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE,
            UNIQUE(pilot_id, date)
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_pilot_cc_schedule_day_pilot ON pilot_cc_schedule_day(pilot_id)`);
        // Which CC program (52/60/72/76 -- the trimester day-count) a pilot bids, e.g. "72".
        // Purely informational/display -- the real on/off-duty truth always comes from
        // pilot_cc_schedule_day's actual uploaded day records, never computed from this number
        // (requested directly: shows on the Family/Line-equivalent picker in My Info, "the Line
        // should be 52/60/72/76, not 1-14" when Family=CC).
        db.run(`ALTER TABLE pilots ADD COLUMN cc_variant TEXT`, () => {});

        // Dedup for the "tour starts tomorrow, add your tail" reminder (server.js's
        // checkNetjetsTourReminders) -- without this, a pilot who hasn't entered a tail yet would
        // get re-notified every time that check runs (every few hours) until they do, instead of
        // once per tour. UNIQUE lets a repeat check just INSERT OR IGNORE with no extra query.
        db.run(`CREATE TABLE IF NOT EXISTS pilot_tour_reminder_sent (
            pilot_id INTEGER NOT NULL,
            tour_start_date TEXT NOT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (pilot_id, tour_start_date),
            FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE
        )`);

        // Indexes — none existed anywhere in this schema before (only the implicit ones SQLite
        // creates for PRIMARY KEY/UNIQUE columns, e.g. pilots.pilot_key). Every one of these is a
        // real, frequently-hit query pattern that was doing a full table scan: a pilot's segments
        // (GET /api/pilots/:key, every page load), the auth token lookup (_resolvePilotToken, on
        // every single authenticated request), the 15s background flight poller's departure-time
        // range scan across ALL pilots' segments, a pilot's own notification feed, and a friend
        // lookup in either direction (friend_requests has no canonical requester/recipient
        // ordering — see its declaration comment above — so both columns need their own index to
        // serve a query checking "either direction"). Purely additive and behavior-neutral: these
        // only speed up existing queries, never change what they return. IF NOT EXISTS makes this
        // safe to run on every startup.
        db.run(`CREATE INDEX IF NOT EXISTS idx_segments_pilot_id ON segments(pilot_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_segments_departure_time ON segments(departure_time)`);
        // Supports the NetJets ETA-estimate fallback's cross-operator lookup (any tracked
        // pilot's real block_minutes for the same city pair) -- without this, that query is a
        // full table scan. Rare query (cached per route, only consulted when NetJets' own
        // history has nothing), but cheap to index anyway.
        db.run(`CREATE INDEX IF NOT EXISTS idx_segments_route ON segments(departure_airport, arrival_airport)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_pilots_token ON pilots(token)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_pilot_key ON notifications(pilot_key)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_friend_requests_requester ON friend_requests(requester_key)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient ON friend_requests(recipient_key)`);

        // Migrations: add columns if they don't exist yet
        db.run(`ALTER TABLE segments ADD COLUMN is_manual BOOLEAN DEFAULT 0`, () => {});
        db.run(`ALTER TABLE segments ADD COLUMN block_minutes INTEGER`, () => {});
        // NetJets auto-leg-creation marker (server.js's _pollNetjetsLegCreation) -- non-null means
        // this row was created/is maintained by that system, never a real upload/sync/manual entry.
        // Lets it safely find-and-update its own rows without ever touching anything it didn't
        // create itself. Format: "<callsign>|<tourStartDate>|<legNumber>". Deliberately NOT kept
        // in server-side memory as the source of truth for "what leg is currently open" -- a pm2
        // restart would silently wipe an in-memory cache and risk a duplicate row for a leg that
        // was already partially recorded; querying this column back out of the DB on every poll
        // makes the whole thing restart-safe by construction instead.
        db.run(`ALTER TABLE segments ADD COLUMN auto_leg_key TEXT`, () => {});
        // Set once the leg is confirmed landed/parked -- lets the next poll know to open a NEW
        // leg rather than keep refining this one, and survives a restart (same reasoning above).
        db.run(`ALTER TABLE segments ADD COLUMN auto_leg_complete INTEGER DEFAULT 0`, () => {});
        // Set the moment a human edits an auto-created row (server.js's segment-edit endpoint) --
        // once set, _pollNetjetsLegCreation never automatically touches this row's fields again,
        // only reads its arrival_airport back out as the next leg's expected origin. Protects a
        // pilot's manual correction from being silently overwritten by the next poll.
        db.run(`ALTER TABLE segments ADD COLUMN auto_leg_edited INTEGER DEFAULT 0`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN role TEXT DEFAULT ''`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN parser_type TEXT DEFAULT 'other'`, () => {});
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

        // parser_type 'csv' was renamed to 'csv_republic' (2026-10-02) -- it was always
        // specifically Republic's column format (DATE/DEP/ARR/DEPTIME/ARRTIME), not a generic
        // catch-all, and the bare name made that easy to mistake. Naturally idempotent (a second
        // run matches nothing, since no code path writes the old bare 'csv' value anymore -- the
        // unset-parser_type fallback changed to 'other' in the same pass), so no settings flag
        // needed to guard it.
        db.run(`UPDATE pilots SET parser_type='csv_republic' WHERE parser_type='csv'`);
    });
}

function pruneFlightLog() {
    getDB().run('DELETE FROM flight_log WHERE updated_at < ?', [Date.now() - 7 * 24 * 60 * 60 * 1000]);
}

module.exports = { getDB, DB_PATH, generateToken, pruneFlightLog };
