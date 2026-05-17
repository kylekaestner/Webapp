const express = require('express');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const { getDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// ===== ICS & CSV Parsing Functions =====
function parseICS(text) {
    const events = [];
    const blocks = text.split(/BEGIN:VEVENT/gi).slice(1);
    
    for (const b of blocks) {
        const lines = b.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        
        const getLine = (prefix) => {
            const ln = lines.find(l => l.toUpperCase().startsWith(prefix));
            return ln ? ln.split(/:(.+)/)[1] || '' : '';
        };
        
        const rawDTSTART = lines.find(l => l.toUpperCase().startsWith('DTSTART')) || '';
        const isAllDay = /VALUE=DATE/i.test(rawDTSTART);
        const dtstart = rawDTSTART.split(/:(.+)/)[1] || '';
        const dtend = (lines.find(l => l.toUpperCase().startsWith('DTEND')) || '').split(/:(.+)/)[1] || '';
        const summary = getLine('SUMMARY') || '';
        const desc = getLine('DESCRIPTION') || '';

        if (/^HARD$/i.test(summary) || isAllDay) {
            const date = isAllDay ? dtstart : dtstart.substring(0, 8);
            const y = date.substring(0, 4), m = date.substring(4, 6), d = date.substring(6, 8);
            events.push({ type: 'hard', departureTime: `${y}-${m}-${d}T00:00:00` });
            continue;
        }

        if (/^AWAY$/i.test(summary)) {
            const arrival = (desc.match(/AWAY\s*-\s*(\w+)/i) || [])[1] || null;
            if (dtstart) {
                const isoStart = formatICSDatetime(dtstart);
                const isoEnd = dtend ? formatICSDatetime(dtend) : '';
                events.push({ type: 'away', departureTime: isoStart, arrivalTime: isoEnd, arrivalAirport: arrival });
            }
            continue;
        }

        const flightMatch = summary.match(/(?:✈️|\u2708)?\s*([A-Z0-9]{3,4})\s*(?:->|→|–|—|-|to)\s*([A-Z0-9]{3,4})/i);
        const tailMatch = desc.match(/Tail:\s*([A-Z0-9]+)/i);
        const tripMatch = desc.match(/Trip\s*[:#]?\s*(\d+)/i);
        const flightNumMatch = desc.match(/(?:Flight|Flt|FLT)\s*[:#]?\s*([A-Z]{2,3}\d{1,4})/i) || desc.match(/\b([A-Z]{2,3}\d{1,4})\b/i);

        if (flightMatch) {
            const dep = flightMatch[1];
            const arr = flightMatch[2];
            const isoStart = dtstart ? formatICSDatetime(dtstart) : '';
            const isoEnd = dtend ? formatICSDatetime(dtend) : '';
            events.push({
                type: 'flight',
                departureTime: isoStart,
                arrivalTime: isoEnd,
                departureAirport: dep,
                arrivalAirport: arr,
                tail: tailMatch ? tailMatch[1] : '',
                trip: tripMatch ? tripMatch[1] : '',
                flightNumber: (flightNumMatch && flightNumMatch[1] && !/^N/i.test(flightNumMatch[1])) ? flightNumMatch[1].toUpperCase() : ''
            });
        }
    }
    return events;
}

function formatICSDatetime(s) {
    if (/^\d{8}T\d{6}Z$/.test(s)) {
        const y = s.substring(0, 4), m = s.substring(4, 6), d = s.substring(6, 8);
        const hh = s.substring(9, 11), mm = s.substring(11, 13), ss = s.substring(13, 15);
        return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
    }
    if (/^\d{8}$/.test(s)) {
        const y = s.substring(0, 4), m = s.substring(4, 6), d = s.substring(6, 8);
        return `${y}-${m}-${d}T00:00:00`;
    }
    return s;
}

function normalizeTime(time) {
    if (!time) return '00:00';
    const txt = time.trim().replace(/[^\d:]/g, '');
    if (txt.includes(':')) {
        const parts = txt.split(':');
        const hh = String(parts[0] || '00').padStart(2, '0').slice(-2);
        const mm = String(parts[1] || '00').padStart(2, '0').slice(-2);
        return `${hh}:${mm}`;
    }
    const s = txt.padStart(4, '0');
    return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const headerRaw = lines.shift();
    const header = headerRaw.split(',').map(h => h.trim().toUpperCase());

    const findIdx = (aliases) => {
        for (const a of aliases) {
            const up = a.toUpperCase();
            const i = header.indexOf(up);
            if (i >= 0) return i;
        }
        return -1;
    };

    const idxDate = findIdx(['DATE', 'FLIGHTDATE', 'SCHEDULEDATE']);
    const idxDep = findIdx(['DEP', 'DEPARTURE', 'ORIG', 'ORIGIN', 'FROM']);
    const idxArr = findIdx(['ARR', 'ARRIVAL', 'DEST', 'DESTINATION', 'TO']);
    const idxDepTime = findIdx(['DEPTIME', 'DEP_TIME', 'DEPARTURETIME', 'DEP TIME', 'DEP/TIME', 'DEPT']);
    const idxArrTime = findIdx(['ARRTIME', 'ARR_TIME', 'ARRIVALTIME', 'ARR TIME', 'ARR/TIME', 'ARRT']);
    const idxTail = findIdx(['FCVTAIL', 'TAIL', 'AIRCRAFT', 'REGISTRATION', 'TAILNUMBER']);
    const idxDh = findIdx(['DH', 'DUTY', 'IS_DH']);

    const events = [];

    const toMinutes = (time) => {
        if (!time) return 0;
        const norm = normalizeTime(time.replace(/"/g, '').trim());
        const [hh, mm] = norm.split(':').map(Number);
        return hh * 60 + mm;
    };

    const addDays = (year, month, day, extraDays) => {
        const d = new Date(Number(year), Number(month) - 1, Number(day) + extraDays);
        const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
        return { y, m, dd };
    };

    for (const row of lines) {
        const cols = row.split(',');
        const date = idxDate >= 0 ? (cols[idxDate] || '').replace(/"/g, '').trim() : '';
        const dep = idxDep >= 0 ? (cols[idxDep] || '').replace(/"/g, '').trim() : '';
        const arr = idxArr >= 0 ? (cols[idxArr] || '').replace(/"/g, '').trim() : '';
        const deptime = idxDepTime >= 0 ? (cols[idxDepTime] || '').replace(/"/g, '').trim() : '';
        const arrtime = idxArrTime >= 0 ? (cols[idxArrTime] || '').replace(/"/g, '').trim() : '';
        const tail = idxTail >= 0 ? (cols[idxTail] || '').replace(/"/g, '').trim() : '';
        const dh = idxDh >= 0 ? (cols[idxDh] || '').replace(/"/g, '').trim() : '';

        if (!date) continue;

        let ym = '', mm = '', dd = '';
        if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(date)) {
            const parts = date.split('/');
            mm = String(parts[0]).padStart(2, '0');
            dd = String(parts[1]).padStart(2, '0');
            ym = String(parts[2]).padStart(4, '0');
        } else if (/\d{4}-\d{2}-\d{2}/.test(date)) {
            const parts = date.split('-');
            ym = parts[0];
            mm = parts[1];
            dd = parts[2];
        } else {
            const d = new Date(date);
            if (isNaN(d)) continue;
            ym = d.getFullYear();
            mm = String(d.getMonth() + 1).padStart(2, '0');
            dd = String(d.getDate()).padStart(2, '0');
        }

        if (dep && arr) {
            const dt = normalizeTime(deptime);
            const at = normalizeTime(arrtime);
            let arrivalDate = { y: ym, m: mm, dd: dd };
            const depMinutes = toMinutes(deptime);
            const arrMinutes = toMinutes(arrtime);
            if (arrMinutes <= depMinutes) arrivalDate = addDays(ym, mm, dd, 1);
            const isoStart = `${ym}-${mm}-${dd}T${dt}:00`;
            const isoEnd = `${arrivalDate.y}-${arrivalDate.m}-${arrivalDate.dd}T${at}:00`;
            const isDH = dh && (dh.toUpperCase() === 'DH' || dh === '1' || dh.toLowerCase() === 'true');
            events.push({ type: 'flight', departureTime: isoStart, arrivalTime: isoEnd, departureAirport: dep, arrivalAirport: arr, tail, dh: isDH });
            continue;
        }

        if (dh && dh.toUpperCase() === 'DH') {
            const isoDate = `${ym}-${mm}-${dd}T00:00:00`;
            events.push({ type: 'hard', departureTime: isoDate });
            continue;
        }
    }

    return events;
}

function parseCSV_skywest(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return [];
    const headerRaw = lines.shift();
    const header = headerRaw.split(',').map(h => h.trim().toUpperCase());

    const findIdx = (aliases) => {
        for (const a of aliases) {
            const i = header.indexOf(a.toUpperCase());
            if (i >= 0) return i;
        }
        return -1;
    };

    const idxDate     = findIdx(['DATE', 'FLIGHTDATE', 'SCHEDULEDATE']);
    const idxDep      = findIdx(['ORIGIN', 'ORIG', 'DEP', 'DEPARTURE', 'FROM']);
    const idxArr      = findIdx(['DEST', 'DESTINATION', 'ARR', 'ARRIVAL', 'TO']);
    const idxDepTime  = findIdx(['DEPART', 'DEPTIME', 'DEP_TIME', 'DEPARTURETIME', 'DEP TIME', 'DEP/TIME', 'DEPT']);
    const idxArrTime  = findIdx(['ARRIVE', 'ARRTIME', 'ARR_TIME', 'ARRIVALTIME', 'ARR TIME', 'ARR/TIME', 'ARRT']);
    const idxTail     = findIdx(['TAIL', 'FCVTAIL', 'AIRCRAFT', 'REGISTRATION']);
    const idxFlightNum = findIdx(['FLIGHT', 'FLT', 'FLIGHT NUMBER', 'FLIGHT#', 'FLT#']);
    const idxDh       = findIdx(['DH', 'DUTY', 'IS_DH']);
    const idxBlock    = findIdx(['BLOCK', 'BLOCK TIME', 'BLOCKTIME', 'BLOCK_TIME']);

    const events = [];

    const toMinutes = (time) => {
        if (!time) return 0;
        const norm = normalizeTime(time.replace(/"/g, '').trim());
        const [hh, mm] = norm.split(':').map(Number);
        return hh * 60 + mm;
    };

    const addDays = (year, month, day, extraDays) => {
        const d = new Date(Number(year), Number(month) - 1, Number(day) + extraDays);
        return { y: d.getFullYear(), m: String(d.getMonth() + 1).padStart(2, '0'), dd: String(d.getDate()).padStart(2, '0') };
    };

    for (const row of lines) {
        const cols = row.split(',');
        const date      = idxDate     >= 0 ? (cols[idxDate]     || '').replace(/"/g, '').trim() : '';
        const dep       = idxDep      >= 0 ? (cols[idxDep]      || '').replace(/"/g, '').trim() : '';
        const arr       = idxArr      >= 0 ? (cols[idxArr]      || '').replace(/"/g, '').trim() : '';
        const deptime   = idxDepTime  >= 0 ? (cols[idxDepTime]  || '').replace(/"/g, '').trim() : '';
        const arrtime   = idxArrTime  >= 0 ? (cols[idxArrTime]  || '').replace(/"/g, '').trim() : '';
        const tail      = idxTail     >= 0 ? (cols[idxTail]     || '').replace(/"/g, '').trim() : '';
        const flightNum = idxFlightNum >= 0 ? (cols[idxFlightNum] || '').replace(/"/g, '').trim() : '';
        const dh        = idxDh       >= 0 ? (cols[idxDh]       || '').replace(/"/g, '').trim() : '';
        const blockRaw  = idxBlock    >= 0 ? (cols[idxBlock]    || '').replace(/"/g, '').trim() : '';
        const blockMinutes = blockRaw ? Math.round(parseFloat(blockRaw) * 60) : null;

        if (!date) continue;

        let ym = '', mm = '', dd = '';
        if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(date)) {
            const parts = date.split('/');
            mm = String(parts[0]).padStart(2, '0');
            dd = String(parts[1]).padStart(2, '0');
            ym = String(parts[2]).padStart(4, '0');
        } else if (/\d{4}-\d{2}-\d{2}/.test(date)) {
            const parts = date.split('-');
            ym = parts[0]; mm = parts[1]; dd = parts[2];
        } else {
            const d = new Date(date);
            if (isNaN(d)) continue;
            ym = String(d.getFullYear());
            mm = String(d.getMonth() + 1).padStart(2, '0');
            dd = String(d.getDate()).padStart(2, '0');
        }

        if (dep && arr) {
            const dt = normalizeTime(deptime);
            const at = normalizeTime(arrtime);
            const depMinutes = toMinutes(deptime);
            const arrMinutes = toMinutes(arrtime);
            let arrivalDate = { y: ym, m: mm, dd };
            if (arrtime && arrMinutes <= depMinutes) arrivalDate = addDays(ym, mm, dd, 1);
            const isoStart = `${ym}-${mm}-${dd}T${dt}:00`;
            const isoEnd   = `${arrivalDate.y}-${arrivalDate.m}-${arrivalDate.dd}T${at}:00`;
            const isDH = dh && (dh.toUpperCase() === 'DH' || dh === '1' || dh.toLowerCase() === 'true');
            events.push({ type: 'flight', departureTime: isoStart, arrivalTime: isoEnd, departureAirport: dep, arrivalAirport: arr, tail, flightNumber: flightNum, dh: isDH, blockMinutes });
            continue;
        }

        if (dh && dh.toUpperCase() === 'DH') {
            events.push({ type: 'hard', departureTime: `${ym}-${mm}-${dd}T00:00:00` });
            continue;
        }
    }

    return events;
}

// Schedaero returns UTC times without a Z — append it so JS parses them as UTC, not local
function asUtcIso(s) {
    if (!s || /Z$|[+-]\d{2}:?\d{2}$/.test(s)) return s;
    return s + 'Z';
}

function parseSchedaeroData(data, filterMonth, filterYear) {
    const crew = Array.isArray(data.crew) ? data.crew[0] : null;
    if (!crew) return [];

    const events = [];

    for (const seg of (crew.segments || [])) {
        if (!seg.departureAirport || !seg.arrivalAirport || !seg.departureTime) continue;
        // Filter uses UTC-aware Date so month boundary near midnight CDT is handled correctly
        if (filterMonth && filterYear) {
            const d = new Date(asUtcIso(seg.departureTime));
            if (d.getMonth() + 1 !== filterMonth || d.getFullYear() !== filterYear) continue;
        }
        events.push({
            type: 'flight',
            departureTime: asUtcIso(seg.departureTime),
            arrivalTime: seg.arrivalTime ? asUtcIso(seg.arrivalTime) : null,
            departureAirport: seg.departureAirport,
            arrivalAirport: seg.arrivalAirport,
            tail: seg.aircraftDescription || null,
            trip: seg.tripName || null,
            flightNumber: null
        });
    }

    for (const evt of (crew.events || [])) {
        if (evt.text !== 'HARD') continue;
        if (filterMonth && filterYear) {
            const d = new Date(asUtcIso(evt.startDate));
            if (d.getMonth() + 1 !== filterMonth || d.getFullYear() !== filterYear) continue;
        }
        const date = evt.startDate.substring(0, 10);
        events.push({ type: 'hard', departureTime: `${date}T00:00:00` });
    }

    return events;
}

// Pilot parser configuration
const pilotParsers = {
    kyle: 'ics',
    adam: 'csv',
    sam: 'csv',
    logan: 'csv_skywest'
};

function getParserForPilot(pilotKey) {
    return pilotParsers[pilotKey] || 'csv';
}

// ===== API Routes =====

// GET all pilots
app.get('/api/pilots', (req, res) => {
    const db = getDB();
    db.all('SELECT * FROM pilots ORDER BY name', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// GET pilot details with segments
app.get('/api/pilots/:pilotKey', (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;

    db.get('SELECT id, pilot_key, name, base FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!pilot) {
            return res.status(404).json({ error: 'Pilot not found' });
        }

        db.all('SELECT * FROM segments WHERE pilot_id = ? ORDER BY departure_time', [pilot.id], (err, segments) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ ...pilot, segments });
        });
    });
});

// POST upload schedule file
app.post('/api/pilots/:pilotKey/upload', upload.single('file'), (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;

    if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
    }

    const fileContent = req.file.buffer.toString('utf-8');
    let events = [];

    // Detect file type and parse
    const filename = req.file.originalname.toLowerCase();
    const parserType = getParserForPilot(pilotKey);

    try {
        if (filename.endsWith('.ics')) {
            events = parseICS(fileContent);
        } else if (filename.endsWith('.csv')) {
            // Route to appropriate CSV parser based on pilot
            if (parserType === 'csv_skywest') {
                events = parseCSV_skywest(fileContent);
            } else {
                events = parseCSV(fileContent);
            }
        } else {
            return res.status(400).json({ error: 'Unsupported file type. Use .ics or .csv' });
        }
    } catch (parseError) {
        return res.status(400).json({ error: `Parse error: ${parseError.message}` });
    }

    // Get pilot
    db.get('SELECT id FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!pilot) {
            return res.status(404).json({ error: 'Pilot not found' });
        }

        // Delete existing non-manual segments for this pilot (preserve manually-added flights)
        db.run('DELETE FROM segments WHERE pilot_id = ? AND (is_manual IS NULL OR is_manual = 0)', [pilot.id], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            // Insert new segments
            const stmt = db.prepare(`
                INSERT INTO segments
                (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, block_minutes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            let completed = 0;
            const errors = [];

            events.forEach((event) => {
                const params = [
                    pilot.id,
                    event.type,
                    event.departureTime || null,
                    event.arrivalTime || null,
                    event.departureAirport || null,
                    event.arrivalAirport || null,
                    event.tail || null,
                    event.trip || null,
                    event.flightNumber || null,
                    event.dh ? 1 : 0,
                    event.blockMinutes || null
                ];

                stmt.run(params, function (err) {
                    if (err) {
                        errors.push(err.message);
                    }
                    completed++;

                    if (completed === events.length) {
                        stmt.finalize();
                        if (errors.length > 0) {
                            return res.status(500).json({ error: 'Some segments failed to insert', details: errors });
                        }
                        res.json({ success: true, segmentsAdded: events.length, parser: parserType });
                    }
                });
            });

            if (events.length === 0) {
                stmt.finalize();
                res.json({ success: true, segmentsAdded: 0, parser: parserType });
            }
        });
    });
});

// DELETE all segments for a pilot
app.delete('/api/pilots/:pilotKey/segments', (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;

    db.get('SELECT id FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!pilot) {
            return res.status(404).json({ error: 'Pilot not found' });
        }

        db.run('DELETE FROM segments WHERE pilot_id = ?', [pilot.id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, deleted: this.changes });
        });
    });
});

// Manually add a single flight segment
app.post('/api/pilots/:pilotKey/add-segment', (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;
    const { departure_time, arrival_time, departure_airport, arrival_airport, flight_number, tail, is_dh, is_personal } = req.body;

    if (!departure_time || !departure_airport || !arrival_airport) {
        return res.status(400).json({ error: 'departure_time, departure_airport, and arrival_airport are required' });
    }

    db.get('SELECT id FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        const tripValue = is_personal ? 'PERSONAL' : null;

        db.run(
            `INSERT INTO segments (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, flight_number, tail, trip, is_dh, is_manual)
             VALUES (?, 'flight', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [pilot.id, departure_time, arrival_time || null,
             departure_airport.trim().toUpperCase(), arrival_airport.trim().toUpperCase(),
             flight_number || null, tail || null, tripValue, is_dh ? 1 : 0],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

// PUT update a manually-added segment
app.put('/api/pilots/:pilotKey/segments/:id', (req, res) => {
    const db = getDB();
    const { pilotKey, id } = req.params;
    const { departure_time, arrival_time, departure_airport, arrival_airport, flight_number, tail, is_dh, is_personal } = req.body;

    if (!departure_time || !departure_airport || !arrival_airport) {
        return res.status(400).json({ error: 'departure_time, departure_airport, and arrival_airport are required' });
    }

    db.get('SELECT id FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        const tripValue = is_personal ? 'PERSONAL' : null;

        db.run(
            `UPDATE segments SET departure_time=?, arrival_time=?, departure_airport=?, arrival_airport=?,
             flight_number=?, tail=?, trip=?, is_dh=?, is_manual=1
             WHERE id=? AND pilot_id=?`,
            [departure_time, arrival_time || null,
             departure_airport.trim().toUpperCase(), arrival_airport.trim().toUpperCase(),
             flight_number || null, tail || null, tripValue, is_dh ? 1 : 0,
             id, pilot.id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Segment not found' });
                res.json({ success: true });
            }
        );
    });
});

// DELETE a single manually-added segment
app.delete('/api/pilots/:pilotKey/segments/:id', (req, res) => {
    const db = getDB();
    const { pilotKey, id } = req.params;

    db.get('SELECT id FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        db.run(
            'DELETE FROM segments WHERE id=? AND pilot_id=?',
            [id, pilot.id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Segment not found' });
                res.json({ success: true });
            }
        );
    });
});

// GET segments by date range (optional filter)
app.get('/api/segments', (req, res) => {
    const db = getDB();
    const { pilotKey, startDate, endDate } = req.query;

    let query = 'SELECT s.*, p.name, p.base FROM segments s JOIN pilots p ON s.pilot_id = p.id WHERE 1=1';
    const params = [];

    if (pilotKey) {
        query += ' AND p.pilot_key = ?';
        params.push(pilotKey);
    }

    if (startDate) {
        query += ' AND s.departure_time >= ?';
        params.push(startDate);
    }

    if (endDate) {
        query += ' AND s.departure_time <= ?';
        params.push(endDate);
    }

    query += ' ORDER BY s.departure_time';

    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Schedaero sync — fetch one month from Schedaero and import into Kyle's schedule
app.post('/api/pilots/kyle/sync-schedaero', async (req, res) => {
    const { cookie, schedaeroUrl, apiToken, month, year } = req.body;

    if (!cookie || !schedaeroUrl || !apiToken) {
        return res.status(400).json({ error: 'cookie, schedaeroUrl, and apiToken are required' });
    }

    const targetMonth = parseInt(month) || (new Date().getMonth() + 1);
    const targetYear  = parseInt(year)  || new Date().getFullYear();

    let schedaeroData;
    try {
        const url = `${schedaeroUrl}?month=${targetMonth}&year=${targetYear}`;
        const parsed = new URL(schedaeroUrl);
        const origin = parsed.origin;

        // Extract CSRF token from cookie (Schedaero uses __Host-AviCSRF)
        const csrfMatch = cookie.match(/(?:^|;\s*)(?:__Host-)?AviCSRF=([^;]+)/);
        const csrf = csrfMatch ? csrfMatch[1].trim() : null;

        const reqHeaders = {
            'Cookie': cookie,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': origin,
            'Pragma': 'no-cache',
            'Referer': `${origin}/mvc/crewscheduling/calendar`,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'X-Avinode-SentTimestamp': new Date().toISOString()
        };
        if (csrf) reqHeaders['X-AviCSRF'] = csrf;
        if (apiToken) reqHeaders['X-Avinode-ApiToken'] = apiToken;

        const response = await fetch(url, { headers: reqHeaders });
        if (!response.ok) {
            return res.status(response.status).json({ error: `Schedaero returned ${response.status} — session may be expired` });
        }
        const json = await response.json();
        schedaeroData = json.data || json;
    } catch (err) {
        return res.status(500).json({ error: `Could not reach Schedaero: ${err.message}` });
    }

    const events = parseSchedaeroData(schedaeroData, targetMonth, targetYear);

    const db = getDB();
    db.get('SELECT id FROM pilots WHERE pilot_key = ?', ['kyle'], (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        const startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01T00:00:00`;
        const lastDay   = new Date(targetYear, targetMonth, 0).getDate();
        const endDate   = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59`;

        db.run(
            'DELETE FROM segments WHERE pilot_id = ? AND (is_manual IS NULL OR is_manual = 0) AND departure_time >= ? AND departure_time <= ?',
            [pilot.id, startDate, endDate],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                if (events.length === 0) return res.json({ success: true, segmentsAdded: 0 });

                const stmt = db.prepare(`
                    INSERT INTO segments
                    (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, block_minutes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                let completed = 0;
                const errors = [];

                events.forEach(event => {
                    stmt.run([
                        pilot.id, event.type,
                        event.departureTime || null, event.arrivalTime || null,
                        event.departureAirport || null, event.arrivalAirport || null,
                        event.tail || null, event.trip || null,
                        null, 0, null
                    ], function(err) {
                        if (err) errors.push(err.message);
                        completed++;
                        if (completed === events.length) {
                            stmt.finalize();
                            if (errors.length > 0) return res.status(500).json({ error: 'Some segments failed', details: errors });
                            res.json({ success: true, segmentsAdded: events.length });
                        }
                    });
                });
            }
        );
    });
});

// Airport coordinates — cache in SQLite, fetch from aviationapi.com on miss
app.get('/api/airport-coords', async (req, res) => {
    const codes = (req.query.codes || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!codes.length) return res.json({});

    const db = getDB();
    db.run(`CREATE TABLE IF NOT EXISTS airport_coords (
        code TEXT PRIMARY KEY,
        lat REAL NOT NULL,
        lon REAL NOT NULL
    )`);

    const result = {};
    const missing = [];

    await new Promise(resolve => {
        const ph = codes.map(() => '?').join(',');
        db.all(`SELECT code, lat, lon FROM airport_coords WHERE code IN (${ph})`, codes, (err, rows) => {
            if (!err && rows) rows.forEach(r => { result[r.code] = { lat: r.lat, lon: r.lon }; });
            codes.forEach(c => { if (!result[c]) missing.push(c); });
            resolve();
        });
    });

    for (const code of missing) {
        try {
            const icao = code.length === 3 ? `K${code}` : code;
            const resp = await fetch(`https://api.aviationapi.com/v1/airports?apt=${icao}`);
            const data = await resp.json();
            const info = data[icao];
            if (info?.latitude && info?.longitude) {
                const lat = parseFloat(info.latitude);
                const lon = parseFloat(info.longitude);
                result[code] = { lat, lon };
                db.run(`INSERT OR REPLACE INTO airport_coords (code, lat, lon) VALUES (?, ?, ?)`, [code, lat, lon]);
            }
        } catch (_) {}
    }

    res.json(result);
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all other routes (SPA)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
