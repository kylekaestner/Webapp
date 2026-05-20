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

        // Migrations: add columns if they don't exist yet
        db.run(`ALTER TABLE segments ADD COLUMN is_manual BOOLEAN DEFAULT 0`, () => {});
        db.run(`ALTER TABLE segments ADD COLUMN block_minutes INTEGER`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN role TEXT DEFAULT ''`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN parser_type TEXT DEFAULT 'csv'`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN airline_code TEXT DEFAULT ''`, () => {});
        db.run(`ALTER TABLE pilots ADD COLUMN home_airport TEXT DEFAULT ''`, () => {});
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
            INSERT OR IGNORE INTO pilots (pilot_key, name, base)
            VALUES
                ('admin', 'Admin', ''),
                ('kyle', 'Kyle Kaestner', 'KSUS'),
                ('adam', 'Adam Burke', 'LGA'),
                ('sam', 'Sam Byrne', 'LGA'),
                ('logan', 'Logan Hine', 'SFO'),
                ('drew', 'Drew Sinelli', 'STL')
        `, (err) => {
            if (err) {
                console.error('Error seeding pilots:', err);
            } else {
                console.log('Pilots table initialized');
            }
        });
    });
}

module.exports = { getDB, DB_PATH, generateToken };
