const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'dispatch.db');

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
        // Migration: add is_manual column if it doesn't exist yet
        db.run(`ALTER TABLE segments ADD COLUMN is_manual BOOLEAN DEFAULT 0`, () => {});

        // Seed initial pilots if not exists
        db.run(`
            INSERT OR IGNORE INTO pilots (pilot_key, name, base) 
            VALUES 
                ('kyle', 'Kyle Kaestner', 'KSUS'),
                ('adam', 'Adam Burke', 'LGA'),
                ('sam', 'Sam Byrne', 'LGA'),
                ('logan', 'Logan Hine', 'SFO')
        `, (err) => {
            if (err) {
                console.error('Error seeding pilots:', err);
            } else {
                console.log('Pilots table initialized');
            }
        });
    });
}

module.exports = { getDB, DB_PATH };
