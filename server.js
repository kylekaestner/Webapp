require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const { getDB, generateToken } = require('./db');
const { DEMO_PILOTS, DEMO_SEGMENTS } = require('./demo-data');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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

// Parser for RosterBuster ICS subscription format (Drew)
function parseRosterBusterICS(text) {
    const events = [];
    // Unfold RFC-5545 line continuations (CRLF + space/tab)
    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    const blocks = unfolded.split(/BEGIN:VEVENT/gi).slice(1);

    for (const b of blocks) {
        const lines = b.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const getField = (prefix) => {
            const up = prefix.toUpperCase();
            const ln = lines.find(l => { const u = l.toUpperCase(); return u.startsWith(up + ':') || u.startsWith(up + ';'); });
            if (!ln) return '';
            const colonIdx = ln.indexOf(':');
            return colonIdx >= 0 ? ln.slice(colonIdx + 1).replace(/\\,/g, ',').trim() : '';
        };

        const summary  = getField('SUMMARY');
        const dtstart  = getField('DTSTART');
        const dtend    = getField('DTEND');
        const location = getField('LOCATION');
        const desc     = getField('DESCRIPTION');

        // ✈️ STL - ORD  or  ➡️ (DH) ORD - FAR
        const flightM = summary.match(/✈️\s*([A-Z]{3})\s*-\s*([A-Z]{3})/);
        const dhM     = summary.match(/➡️\s*\(DH\)\s*([A-Z]{3})\s*-\s*([A-Z]{3})/);
        const match   = flightM || dhM;
        if (!match) continue;

        const dep  = match[1].toUpperCase();
        const arr  = match[2].toUpperCase();
        const isDH = !!dhM;

        const depTime = dtstart ? formatICSDatetime(dtstart) : null;
        const arrTime = dtend   ? formatICSDatetime(dtend)   : null;
        if (!depTime || !arrTime) continue;

        // Flight number: last space-separated token after the closing paren in LOCATION
        // e.g. "(2010Z-2148Z) G74536"  or  "(2125Z-2341Z) UA5618"
        const flightNumM = location.match(/\)\s+([A-Z0-9]{3,7})\s*$/i);
        const flightNumber = flightNumM ? flightNumM[1].toUpperCase() : '';

        // Aircraft type: first token after local time parens in DESCRIPTION (skip for DH)
        // e.g. "(1510L-1648L) CR7 cockpit ..."
        const acM = !isDH && desc.match(/\(\d{4}L-\d{4}L\)\s+([A-Z0-9]{2,4})\b/i);
        const tail = acM ? acM[1].toUpperCase() : '';

        events.push({ type: 'flight', departureTime: depTime, arrivalTime: arrTime,
            departureAirport: dep, arrivalAirport: arr, flightNumber, tail, trip: null, dh: isDH });
    }

    // Sort by departure time, then assign trip numbers.
    // A new trip starts when departing the home base on a different day — same-day
    // returns (turns) don't end the trip.
    events.sort((a, b) => (a.departureTime || '').localeCompare(b.departureTime || ''));
    let tripNum = 1;
    for (let i = 0; i < events.length; i++) {
        if (i > 0 && events[i].departureAirport === 'STL') {
            const prevDay = (events[i - 1].departureTime || '').substring(0, 10);
            const thisDay = (events[i].departureTime || '').substring(0, 10);
            if (thisDay !== prevDay) tripNum++;
        }
        events[i].trip = String(tripNum);
    }

    return events;
}

function formatICSDatetime(s) {
    if (/^\d{8}T\d{6}Z$/.test(s)) {
        const y = s.substring(0, 4), m = s.substring(4, 6), d = s.substring(6, 8);
        const hh = s.substring(9, 11), mm = s.substring(11, 13), ss = s.substring(13, 15);
        return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
    }
    if (/^\d{8}T\d{6}$/.test(s)) {
        // Local time without Z — store as-is in UTC (times in ICS are already UTC for GoJet)
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

const IATA_TO_ICAO = {
    'AA': 'AAL', 'DL': 'DAL', 'UA': 'UAL', 'WN': 'SWA', 'B6': 'JBU',
    'AS': 'ASA', 'F9': 'FFT', 'NK': 'NKS', 'G4': 'AAY', 'SY': 'SCX',
    'HA': 'HAL', 'OO': 'SKW', 'YV': 'MES', 'OH': 'COM', 'CP': 'GWY',
    'G7': 'GJS', 'YX': 'RPA', 'MQ': 'ENY', 'ZW': 'AWI', 'PT': 'PDT',
    'C5': 'FFT', 'QX': 'QXE', 'KS': 'PGS', 'EM': 'EGF', 'XP': 'CXA',
};

function parseBlockToMinutes(raw) {
    if (!raw) return null;
    const s = raw.trim();
    if (s.includes('.')) {
        const val = parseFloat(s);
        return isNaN(val) ? null : Math.round(val * 60);
    }
    const digits = s.replace(/\D/g, '').padStart(4, '0');
    const h = parseInt(digits.slice(0, -2), 10);
    const m = parseInt(digits.slice(-2), 10);
    if (isNaN(h) || isNaN(m) || m >= 60) return null;
    return h * 60 + m;
}

function parseCSV(text, defaultAirlineCode = '') {
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
    const idxBlock = findIdx(['BLOCK', 'BLOCK TIME', 'BLOCKTIME', 'BLOCK_TIME']);
    const idxFlightNum = findIdx(['FLIGHT', 'FLT', 'FLIGHT NUMBER', 'FLIGHT#', 'FLT#', 'FLIGHTNUM']);
    const idxRawTail = header.indexOf('TAIL'); // separate from FCVTAIL — holds carrier code on DH rows

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
        const blockRaw = idxBlock >= 0 ? (cols[idxBlock] || '').replace(/"/g, '').trim() : '';
        const blockMinutes = parseBlockToMinutes(blockRaw);
        const rawFlightNum = idxFlightNum >= 0 ? (cols[idxFlightNum] || '').replace(/"/g, '').trim() : '';
        const rawTailCode = idxRawTail >= 0 ? (cols[idxRawTail] || '').replace(/"/g, '').trim() : '';
        const isDH = dh && (dh.toUpperCase() === 'DH' || dh === '1' || dh.toLowerCase() === 'true');
        let flightNum = rawFlightNum;
        if (rawFlightNum && /^\d+$/.test(rawFlightNum)) {
            if (isDH && /^[A-Z]{2,3}$/.test(rawTailCode)) {
                flightNum = (IATA_TO_ICAO[rawTailCode] || rawTailCode) + rawFlightNum;
            } else if (defaultAirlineCode) {
                flightNum = defaultAirlineCode + rawFlightNum;
            }
        }

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
            events.push({ type: 'flight', departureTime: isoStart, arrivalTime: isoEnd, departureAirport: dep, arrivalAirport: arr, tail, flightNumber: flightNum, dh: isDH, blockMinutes });
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
        const blockMinutes = parseBlockToMinutes(blockRaw);

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

// ===== NetLine/Crew PDF Parser (GoJet / Drew) =====
const pdfParse = require('pdf-parse');
const tzlookup = require('tz-lookup');

// Build airport code → [lat, lon] and IATA↔ICAO maps from bundled airports.dat (OpenFlights format)
const _aptCoords = {};
const _iataToIcaoApt = {};
const _icaoToIataApt = {};
try {
    const lines = fs.readFileSync(path.join(__dirname, 'airports.dat'), 'utf8').split('\n');
    for (const line of lines) {
        const p = line.split(',').map(s => s.replace(/^"|"$/g, ''));
        const iata = p[4]?.trim(), icao = p[5]?.trim();
        const lat = parseFloat(p[6]), lon = parseFloat(p[7]);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        if (iata && iata !== '\\N' && iata !== 'N/A') _aptCoords[iata.toUpperCase()] = [lat, lon];
        if (icao && icao !== '\\N' && icao !== 'N/A') _aptCoords[icao.toUpperCase()] = [lat, lon];
        if (iata && iata !== '\\N' && icao && icao !== '\\N') {
            _iataToIcaoApt[iata.toUpperCase()] = icao.toUpperCase();
            _icaoToIataApt[icao.toUpperCase()] = iata.toUpperCase();
        }
    }
    console.log(`Airport DB loaded: ${Object.keys(_aptCoords).length} codes`);
} catch (e) {
    console.error('Could not load airports.dat:', e.message);
}

function iataToIcaoAirport(iata) {
    if (!iata) return null;
    const up = iata.toUpperCase();
    return _iataToIcaoApt[up] || (up.length === 3 ? 'K' + up : up);
}
function icaoToIataAirport(icao) {
    if (!icao) return null;
    const up = icao.toUpperCase();
    if (_icaoToIataApt[up]) return _icaoToIataApt[up];
    if (up.length === 4 && up.startsWith('K')) return up.slice(1); // US heuristic
    return up;
}

// Returns the UTC offset in minutes for an airport on a given YYYY-MM-DD date (handles DST)
function airportUTCOffset(dateStr, airport) {
    const coords = _aptCoords[airport?.toUpperCase()];
    if (!coords) return 0;
    let tz;
    try { tz = tzlookup(coords[0], coords[1]); } catch (e) { return 0; }
    const refUTC = new Date(`${dateStr}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false
    }).formatToParts(refUTC);
    const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '12');
    const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
    return (h * 60 + m) - 720;
}

async function parseNetlinePDF(buffer) {
    const data = await pdfParse(buffer);
    const text = data.text;

    // Extract period start month/year from "Period: 01Jun26 – 30Jun26"
    const periodMatch = text.match(/Period:\s*\d{2}([A-Za-z]{3})(\d{2})/);
    if (!periodMatch) throw new Error('Could not find Period line in PDF');
    const MONTH_ABBRS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    let baseMonth = MONTH_ABBRS[periodMatch[1].toLowerCase()];
    let baseYear  = 2000 + parseInt(periodMatch[2]);
    if (!baseMonth) throw new Error('Could not parse month from PDF header');

    const segments = [];

    // Find every duty-start header: "Mon01 C/I", "Fri08 OPR", etc.
    const ciRe = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{2})\s+(?:C\/I|OPR)/g;
    let m;
    const duties = [];
    while ((m = ciRe.exec(text)) !== null) {
        duties.push({ index: m.index, day: parseInt(m[1]) });
    }

    // Detect month rollover between duties (day numbers restart at 01 after ~28-31)
    let curMonth = baseMonth;
    let curYear  = baseYear;
    let prevDay  = 0;
    const resolvedDuties = duties.map(d => {
        if (d.day < prevDay - 15) { // rolled over to next month
            curMonth++;
            if (curMonth > 12) { curMonth = 1; curYear++; }
        }
        prevDay = d.day;
        return { ...d, month: curMonth, year: curYear };
    });

    for (let i = 0; i < resolvedDuties.length; i++) {
        const { index, day, month, year } = resolvedDuties[i];
        const blockEnd = i + 1 < resolvedDuties.length ? resolvedDuties[i + 1].index : text.length;
        const block = text.slice(index, blockEnd);

        // Track the current date as we walk through legs in this duty
        let trackDate = new Date(year, month - 1, day);

        // Match G7 and DH legs in document order
        // G7 4567 STL 0810 !0945 ORD CR7  |  DH/UA 6213 STL 1110 1325 IAH
        // Handles: /NN day-suffix on flt num (G7 4545 /07), +N next-day marker on arr (0136+1)
        const legRe = /(?:(G7)\s+(\d{4})(?:\s*\/\d+)?|(DH)\/([A-Z0-9]+)\s+(\d+))\s+([A-Z]{2,4})\s+!?(\d{4})\s+!?(\d{4})(?:\+\d+)?\s+([A-Z]{2,4})/g;
        let lm;
        while ((lm = legRe.exec(block)) !== null) {
            const isDH    = !!lm[3];
            const carrier = isDH ? lm[4] : 'G7';
            const fltNum  = isDH ? lm[5] : lm[2];
            const depApt  = lm[6];
            const depHH   = lm[7].slice(0, 2), depMM = lm[7].slice(2);
            const arrHH   = lm[8].slice(0, 2), arrMM = lm[8].slice(2);
            const arrApt  = lm[9];

            const depInt = parseInt(lm[7]);
            const arrInt = parseInt(lm[8]);

            const yy = trackDate.getFullYear();
            const mo = String(trackDate.getMonth() + 1).padStart(2, '0');
            const dd = String(trackDate.getDate()).padStart(2, '0');
            const depTime = `${yy}-${mo}-${dd}T${depHH}:${depMM}:00`;

            // If arrival HHMM is before departure HHMM, the flight crosses midnight
            if (arrInt < depInt) {
                trackDate = new Date(trackDate.getTime() + 86400000);
            }
            const ay = trackDate.getFullYear();
            const am = String(trackDate.getMonth() + 1).padStart(2, '0');
            const ad = String(trackDate.getDate()).padStart(2, '0');
            const arrTime = `${ay}-${am}-${ad}T${arrHH}:${arrMM}:00`;

            // Times are airport-local, so correct for timezone difference between airports
            const depOffset = airportUTCOffset(`${yy}-${mo}-${dd}`, depApt);
            const arrOffset = airportUTCOffset(`${ay}-${am}-${ad}`, arrApt);
            const blockMins = Math.round((new Date(arrTime) - new Date(depTime)) / 60000) + (depOffset - arrOffset);

            segments.push({
                type: 'flight',
                departureTime: depTime,
                arrivalTime:   arrTime,
                departureAirport: depApt,
                arrivalAirport:   arrApt,
                flightNumber: `${carrier} ${fltNum}`,
                tail: '', trip: '',
                dh: isDH,
                blockMinutes: blockMins > 0 ? blockMins : null
            });
        }
    }

    return segments;
}

// Pilot parser configuration
const pilotParsers = {
    kyle: 'schedaero',
    adam: 'csv',
    sam: 'csv',
    logan: 'csv_skywest',
    drew: 'ics_rosterbuster'
};

const pilotAirlineCodes = {
    kyle: 'SJJ',
    adam: 'RPA',
    sam: 'RPA',
    logan: 'SKW',
    drew: 'GJS'
};

function getParserForPilot(pilotKey, pilotRow) {
    // Prefer hardcoded config for existing pilots; use DB value for new ones
    return pilotParsers[pilotKey] || (pilotRow?.parser_type) || 'csv';
}

function autoDetectParser(filename, fileContent) {
    if (filename.endsWith('.ics')) {
        const rbEvents  = parseRosterBusterICS(fileContent);
        const stdEvents = parseICS(fileContent);
        if (rbEvents.length > 0 && rbEvents.length >= stdEvents.length)
            return { parser: 'ics_rosterbuster', events: rbEvents };
        return { parser: 'ics', events: stdEvents };
    }
    if (filename.endsWith('.csv')) {
        let swEvents = [], csvEvents = [];
        try { swEvents  = parseCSV_skywest(fileContent); } catch (_) {}
        try { csvEvents = parseCSV(fileContent, '');     } catch (_) {}
        if (swEvents.length > csvEvents.length) return { parser: 'csv_skywest', events: swEvents };
        if (csvEvents.length > 0)               return { parser: 'csv',         events: csvEvents };
    }
    return { parser: null, events: [] };
}

// ===== API Routes =====

// GET all pilots
app.get('/api/pilots', (req, res) => {
    const db = getDB();
    db.all(`SELECT * FROM pilots WHERE pilot_key != 'admin' ORDER BY name`, (err, rows) => {
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

    db.get('SELECT id, pilot_key, name, base, role, parser_type, airline_code FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
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
app.post('/api/pilots/:pilotKey/upload', upload.single('file'), async (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;

    if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
    }

    let events = [];

    // Get pilot first so we can use their parser_type and airline_code from DB
    db.get('SELECT id, parser_type, airline_code FROM pilots WHERE pilot_key = ?', [pilotKey], async (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        // Detect file type and parse using pilot's stored parser_type + airline_code
        const filename = req.file.originalname.toLowerCase();
        let parserType = getParserForPilot(pilotKey, pilot);
        const airlineCode = pilotAirlineCodes[pilotKey] || pilot.airline_code || '';

        try {
            if (filename.endsWith('.pdf')) {
                events = await parseNetlinePDF(req.file.buffer);
                if (parserType === 'other') {
                    parserType = 'pdf_netline';
                    db.run('UPDATE pilots SET parser_type = ? WHERE pilot_key = ?', [parserType, pilotKey]);
                }
            } else {
                const fileContent = req.file.buffer.toString('utf-8');
                if (parserType === 'other') {
                    const detected = autoDetectParser(filename, fileContent);
                    if (!detected.parser) {
                        db.run('UPDATE pilots SET parser_type = ? WHERE pilot_key = ?', ['pending', pilotKey]);
                        return res.status(422).json({ error: 'Unrecognized schedule format. Your account was created — contact your admin to get your format supported.', pending: true });
                    }
                    events = detected.events;
                    parserType = detected.parser;
                    db.run('UPDATE pilots SET parser_type = ? WHERE pilot_key = ?', [parserType, pilotKey]);
                } else if (filename.endsWith('.ics')) {
                    events = parserType === 'ics_rosterbuster'
                        ? parseRosterBusterICS(fileContent)
                        : parseICS(fileContent);
                } else if (filename.endsWith('.csv')) {
                    events = parserType === 'csv_skywest'
                        ? parseCSV_skywest(fileContent)
                        : parseCSV(fileContent, airlineCode);
                } else {
                    return res.status(400).json({ error: 'Unsupported file type. Use .ics, .csv, or .pdf' });
                }
            }
        } catch (parseError) {
            return res.status(400).json({ error: `Parse error: ${parseError.message}` });
        }

        // Upsert all events — never delete existing data.
        // Match on (type, departure_time, departure_airport): same segment → UPDATE, new → INSERT.
        if (events.length === 0) {
            return res.json({ success: true, segmentsAdded: 0, parser: parserType });
        }

        db.all(
            'SELECT id, type, departure_time, departure_airport FROM segments WHERE pilot_id = ? AND (is_manual IS NULL OR is_manual = 0)',
            [pilot.id],
            (err, existing) => {
                if (err) return res.status(500).json({ error: err.message });

                const existingMap = {};
                existing.forEach(s => {
                    const key = `${s.type}|${s.departure_time || ''}|${s.departure_airport || ''}`;
                    existingMap[key] = s.id;
                });

                let completed = 0;
                const errors = [];
                const done = () => {
                    completed++;
                    if (completed === events.length) {
                        if (errors.length > 0)
                            return res.status(500).json({ error: 'Some segments failed', details: errors });
                        res.json({ success: true, segmentsAdded: events.length, parser: parserType });
                    }
                };

                events.forEach(event => {
                    const key = `${event.type}|${event.departureTime || ''}|${event.departureAirport || ''}`;
                    const existingId = existingMap[key];

                    if (existingId) {
                        db.run(
                            `UPDATE segments SET arrival_time=?, arrival_airport=?, tail=?, trip=?, flight_number=?, is_dh=?, block_minutes=? WHERE id=?`,
                            [event.arrivalTime || null, event.arrivalAirport || null, event.tail || null, event.trip || null, event.flightNumber || null, event.dh ? 1 : 0, event.blockMinutes || null, existingId],
                            err => { if (err) errors.push(err.message); done(); }
                        );
                    } else {
                        db.run(
                            `INSERT INTO segments (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, block_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [pilot.id, event.type, event.departureTime || null, event.arrivalTime || null, event.departureAirport || null, event.arrivalAirport || null, event.tail || null, event.trip || null, event.flightNumber || null, event.dh ? 1 : 0, event.blockMinutes || null],
                            err => { if (err) errors.push(err.message); done(); }
                        );
                    }
                });
            }
        );
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
    const { departure_time, arrival_time, departure_airport, arrival_airport, flight_number, tail, is_dh, is_personal, is_commute, block_minutes } = req.body;

    if (!departure_time || !departure_airport || !arrival_airport) {
        return res.status(400).json({ error: 'departure_time, departure_airport, and arrival_airport are required' });
    }

    db.get('SELECT id FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        const tripValue = is_personal ? 'PERSONAL' : is_commute ? 'COMMUTE' : null;
        const blockMin = (block_minutes != null && block_minutes > 0) ? Math.round(block_minutes) : null;

        db.run(
            `INSERT INTO segments (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, flight_number, tail, trip, is_dh, is_manual, block_minutes)
             VALUES (?, 'flight', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [pilot.id, departure_time, arrival_time || null,
             departure_airport.trim().toUpperCase(), arrival_airport.trim().toUpperCase(),
             flight_number || null, tail || null, tripValue, is_dh ? 1 : 0, blockMin],
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
    const { departure_time, arrival_time, departure_airport, arrival_airport, flight_number, tail, is_dh, is_personal, is_commute, block_minutes } = req.body;

    if (!departure_time || !departure_airport || !arrival_airport) {
        return res.status(400).json({ error: 'departure_time, departure_airport, and arrival_airport are required' });
    }

    db.get('SELECT id FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        const tripValue = is_personal ? 'PERSONAL' : is_commute ? 'COMMUTE' : null;
        const blockMin = (block_minutes != null && block_minutes > 0) ? Math.round(block_minutes) : null;

        db.run(
            `UPDATE segments SET departure_time=?, arrival_time=?, departure_airport=?, arrival_airport=?,
             flight_number=?, tail=?, trip=?, is_dh=?, is_manual=1, block_minutes=?
             WHERE id=? AND pilot_id=?`,
            [departure_time, arrival_time || null,
             departure_airport.trim().toUpperCase(), arrival_airport.trim().toUpperCase(),
             flight_number || null, tail || null, tripValue, is_dh ? 1 : 0, blockMin,
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

// Update pilot info (admin)
app.put('/api/pilots/:pilotKey', (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;
    if (pilotKey === 'admin') return res.status(400).json({ error: 'Cannot modify admin' });
    const { name, base, homeAirport, role, parserType, airlineCode } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    db.run(
        `UPDATE pilots SET name=?, base=?, home_airport=?, role=?, parser_type=?, airline_code=? WHERE pilot_key=?`,
        [name.trim(), (base || '').toUpperCase().trim(), (homeAirport || '').toUpperCase().trim(),
         (role || '').trim(), (parserType || 'csv').trim(), (airlineCode || '').toUpperCase().trim(), pilotKey],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Pilot not found' });
            res.json({ success: true });
        }
    );
});

// Delete pilot and their segments (admin)
app.delete('/api/pilots/:pilotKey', (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;
    if (pilotKey === 'admin') return res.status(400).json({ error: 'Cannot delete admin' });
    db.run(`DELETE FROM pilots WHERE pilot_key=?`, [pilotKey], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Pilot not found' });
        res.json({ success: true });
    });
});

// Regenerate login token (admin)
app.post('/api/pilots/:pilotKey/regenerate-token', (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;
    if (pilotKey === 'admin') return res.status(400).json({ error: 'Cannot modify admin' });
    const token = generateToken();
    db.run(`UPDATE pilots SET token=? WHERE pilot_key=?`, [token, pilotKey], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Pilot not found' });
        res.json({ success: true, token });
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

// RosterBuster ICS sync — fetch subscription URL and import into Drew's schedule
app.post('/api/pilots/drew/sync-ics', async (req, res) => {
    const db = getDB();
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Persist the URL for future use
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        ['drew_ics_url', JSON.stringify({ url })]);

    let icsText;
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) return res.status(resp.status).json({ error: `ICS fetch returned ${resp.status}` });
        icsText = await resp.text();
    } catch (err) {
        return res.status(500).json({ error: `Could not fetch ICS: ${err.message}` });
    }

    const events = parseRosterBusterICS(icsText);

    db.get('SELECT id FROM pilots WHERE pilot_key = ?', ['drew'], (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        const nowIso = new Date().toISOString();

        db.all(
            'SELECT id, type, departure_time, departure_airport FROM segments WHERE pilot_id = ? AND (is_manual IS NULL OR is_manual = 0)',
            [pilot.id],
            (err, existing) => {
            if (err) return res.status(500).json({ error: err.message });

            const existingMap = {};
            existing.forEach(s => {
                const key = `${s.type}|${s.departure_time || ''}|${s.departure_airport || ''}`;
                existingMap[key] = s.id;
            });

            // Track which existing IDs the new feed accounts for
            const matchedIds = new Set();
            const incomingKeys = new Set(events.map(ev =>
                `${ev.type}|${ev.departureTime || ''}|${ev.departureAirport || ''}`
            ));
            existing.forEach(s => {
                const key = `${s.type}|${s.departure_time || ''}|${s.departure_airport || ''}`;
                if (incomingKeys.has(key)) matchedIds.add(s.id);
            });

            // Delete future segments that are no longer in the feed
            const staleIds = existing
                .filter(s => !matchedIds.has(s.id) && (s.departure_time || '') >= nowIso)
                .map(s => s.id);

            const doUpsert = () => {
                if (events.length === 0) return res.json({ success: true, segmentsAdded: 0 });
                let completed = 0;
                const errors = [];
                const done = () => {
                    completed++;
                    if (completed === events.length) {
                        if (errors.length > 0) return res.status(500).json({ error: 'Some segments failed', details: errors });
                        res.json({ success: true, segmentsAdded: events.length });
                    }
                };
                events.forEach(ev => {
                    const key = `${ev.type}|${ev.departureTime || ''}|${ev.departureAirport || ''}`;
                    const existingId = existingMap[key];
                    if (existingId) {
                        db.run(
                            `UPDATE segments SET arrival_time=?, arrival_airport=?, tail=?, trip=?, flight_number=?, is_dh=?, block_minutes=? WHERE id=?`,
                            [ev.arrivalTime || null, ev.arrivalAirport || null, ev.tail || null, ev.trip || null, ev.flightNumber || null, ev.dh ? 1 : 0, null, existingId],
                            err => { if (err) errors.push(err.message); done(); }
                        );
                    } else {
                        db.run(
                            `INSERT INTO segments (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, block_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [pilot.id, ev.type, ev.departureTime || null, ev.arrivalTime || null, ev.departureAirport || null, ev.arrivalAirport || null, ev.tail || null, ev.trip || null, ev.flightNumber || null, ev.dh ? 1 : 0, null],
                            err => { if (err) errors.push(err.message); done(); }
                        );
                    }
                });
            };

            if (staleIds.length > 0) {
                const placeholders = staleIds.map(() => '?').join(',');
                db.run(`DELETE FROM segments WHERE id IN (${placeholders})`, staleIds, err => {
                    if (err) return res.status(500).json({ error: err.message });
                    doUpsert();
                });
            } else {
                doUpsert();
            }
        });
    });
});

// ── Schedaero helpers ────────────────────────────────────────────────────────

async function fetchSchedaeroMonth(cookie, schedaeroUrl, apiToken, month, year) {
    const url = `${schedaeroUrl}?month=${month}&year=${year}`;
    const origin = new URL(schedaeroUrl).origin;
    const csrfMatch = cookie.match(/(?:^|;\s*)(?:__Host-)?AviCSRF=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1].trim() : null;
    const headers = {
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
    if (csrf)     headers['X-AviCSRF'] = csrf;
    if (apiToken) headers['X-Avinode-ApiToken'] = apiToken;
    const response = await fetch(url, { headers });
    if (!response.ok) {
        const err = new Error(`Schedaero returned ${response.status} — session may be expired`);
        err.status = response.status;
        err.sessionExpired = response.status === 401 || response.status === 403;
        throw err;
    }
    const json = await response.json();
    return parseSchedaeroData(json.data || json, month, year);
}

function importSchedaeroEvents(db, pilotId, events, month, year) {
    return new Promise((resolve, reject) => {
        const startDate = `${year}-${String(month).padStart(2,'0')}-01T00:00:00`;
        const lastDay   = new Date(year, month, 0).getDate();
        const endDate   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}T23:59:59`;
        db.run(
            'DELETE FROM segments WHERE pilot_id=? AND (is_manual IS NULL OR is_manual=0) AND departure_time>=? AND departure_time<=?',
            [pilotId, startDate, endDate],
            (err) => {
                if (err) return reject(err);
                if (events.length === 0) return resolve(0);
                const stmt = db.prepare(`INSERT INTO segments (pilot_id,type,departure_time,arrival_time,departure_airport,arrival_airport,tail,trip,flight_number,is_dh,block_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
                let done = 0; const errs = [];
                events.forEach(ev => {
                    stmt.run([pilotId, ev.type, ev.departureTime||null, ev.arrivalTime||null, ev.departureAirport||null, ev.arrivalAirport||null, ev.tail||null, ev.trip||null, null, 0, null], e => {
                        if (e) errs.push(e.message);
                        if (++done === events.length) { stmt.finalize(); errs.length ? reject(new Error(errs.join('; '))) : resolve(events.length); }
                    });
                });
            }
        );
    });
}

// Schedaero sync — fetch one month using credentials from request body
app.post('/api/pilots/kyle/sync-schedaero', async (req, res) => {
    const { cookie, schedaeroUrl, apiToken, month, year } = req.body;
    if (!cookie || !schedaeroUrl || !apiToken) {
        return res.status(400).json({ error: 'cookie, schedaeroUrl, and apiToken are required' });
    }
    const targetMonth = parseInt(month) || (new Date().getMonth() + 1);
    const targetYear  = parseInt(year)  || new Date().getFullYear();
    let events;
    try {
        events = await fetchSchedaeroMonth(cookie, schedaeroUrl, apiToken, targetMonth, targetYear);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message, sessionExpired: err.sessionExpired || false });
    }
    const db = getDB();
    db.get('SELECT id FROM pilots WHERE pilot_key=?', ['kyle'], async (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });
        try {
            const added = await importSchedaeroEvents(db, pilot.id, events, targetMonth, targetYear);
            res.json({ success: true, segmentsAdded: added });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

// Quick sync — uses saved server-side credentials, no body needed (for mobile)
app.post('/api/pilots/kyle/quick-sync-schedaero', async (req, res) => {
    const db = getDB();
    db.get(`SELECT value FROM settings WHERE key='schedaero-creds'`, async (err, row) => {
        if (err || !row) return res.status(400).json({ error: 'No credentials saved. Use the full sync form first to save your credentials.' });
        const creds = JSON.parse(row.value);
        if (!creds.cookie || !creds.url || !creds.apiToken) {
            return res.status(400).json({ error: 'Incomplete saved credentials.' });
        }
        const now = new Date();
        const months = [];
        const back  = parseInt(creds.monthsBack)  || 0;
        const ahead = parseInt(creds.monthsAhead) || 3;
        for (let i = -back; i < ahead; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
            months.push({ month: d.getMonth() + 1, year: d.getFullYear() });
        }
        db.get('SELECT id FROM pilots WHERE pilot_key=?', ['kyle'], async (err2, pilot) => {
            if (err2 || !pilot) return res.status(500).json({ error: 'Pilot not found' });
            let totalAdded = 0;
            for (const { month, year } of months) {
                try {
                    const events = await fetchSchedaeroMonth(creds.cookie, creds.url, creds.apiToken, month, year);
                    totalAdded += await importSchedaeroEvents(db, pilot.id, events, month, year);
                } catch (e) {
                    return res.status(e.status || 500).json({ error: e.message, sessionExpired: e.sessionExpired || false });
                }
            }
            res.json({ success: true, segmentsAdded: totalAdded });
        });
    });
});

// Live flight tracking — position + accumulated trail
const _liveCache = {};
const LIVE_TTL = 5000; // 5s cache; client polls every 8s

const _posTrail = {};  // hex → [[lat, lon], ...]
const _trailLastTime = {}; // hex → Date.now() of last appended trail point
const _trailSeeded = new Set(); // hexes whose adsb.lol/OpenSky history has been fetched
const _trailSeedTime = {}; // hex → timestamp of last adsb.lol fetch
const TRAIL_RESEED_MS = 5 * 1000; // re-fetch adsb.lol trace every 5 seconds

// Trail persistence — survives server restarts so the full flight path accumulates
const TRAIL_CACHE_FILE = path.join(__dirname, '.trail_cache.json');

function loadTrailCache() {
    try {
        const data = JSON.parse(fs.readFileSync(TRAIL_CACHE_FILE, 'utf8'));
        const cutoff = Date.now() - 24 * 60 * 60 * 1000; // drop entries older than 24h
        for (const [hex, entry] of Object.entries(data)) {
            if (entry.ts > cutoff && Array.isArray(entry.coords) && entry.coords.length >= 2) {
                _posTrail[hex] = entry.coords;
                // Don't mark as seeded — let the adsb.lol fetch run and prepend denser historical points
            }
        }
        const n = Object.keys(_posTrail).length;
        if (n > 0) console.log(`Trail cache loaded: ${n} aircraft`);
    } catch (_) {} // file missing or corrupt — start fresh
}

let _saveTrailTimer = null;
function scheduleTrailSave() {
    clearTimeout(_saveTrailTimer);
    _saveTrailTimer = setTimeout(() => {
        const data = {};
        for (const [hex, coords] of Object.entries(_posTrail)) {
            data[hex] = { ts: Date.now(), coords };
        }
        try { fs.writeFileSync(TRAIL_CACHE_FILE, JSON.stringify(data)); } catch (_) {}
    }, 5000); // batch writes — save 5s after the last update
}

loadTrailCache();

async function seedTrailFromOpenSky(hex) {
    const now = Date.now();
    const alreadySeeded = _trailSeeded.has(hex);
    const lastSeed = _trailSeedTime[hex] || 0;
    // Skip if seeded recently — but always re-fetch from adsb.lol every 90s for active flights
    if (alreadySeeded && (now - lastSeed) < TRAIL_RESEED_MS) return;
    _trailSeeded.add(hex);
    _trailSeedTime[hex] = now;
    try {
        let coords = null;

        // Try adsb.lol trace files — re-fetched every 90s to get dense live data
        try {
            const zz = hex.slice(-2).toLowerCase();
            const h = hex.toLowerCase();
            const traceUrls = [
                `https://globe.adsb.lol/data/traces/${zz}/trace_full_${h}.json`,
                `https://globe.adsb.lol/data/traces/${zz}/trace_recent_${h}.json`,
                `https://globe.adsb.lol/trace/recent/${zz}/${h}.json`,
            ];
            for (const traceUrl of traceUrls) {
                if (coords) break;
                try {
                    const tr = await fetch(traceUrl, { signal: AbortSignal.timeout(8000) });
                    if (!tr.ok) { console.log(`Trace ${traceUrl}: HTTP ${tr.status}`); continue; }
                    const tj = await tr.json();
                    if (tj?.trace && tj.trace.length >= 2) {
                        const pts = tj.trace
                            .filter(p => p[1] != null && p[2] != null)
                            .map(p => [p[1], p[2]]);
                        if (pts.length >= 2) {
                            coords = pts;
                            console.log(`${alreadySeeded ? 'Refreshed' : 'Seeded'} trail for ${hex}: ${coords.length} pts from ${traceUrl}`);
                        }
                    }
                } catch (e) { console.log(`Trace ${traceUrl}: ${e.message}`); }
            }
        } catch (_) {}

        // Fall back to OpenSky on first seed only (no point polling OpenSky every 90s)
        if (!coords && !alreadySeeded) {
            const osUser = process.env.OPENSKY_USER, osPass = process.env.OPENSKY_PASS;
            const headers = osUser ? { Authorization: 'Basic ' + Buffer.from(`${osUser}:${osPass}`).toString('base64') } : {};
            const url = `https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`;
            const resp = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
            if (resp.ok) {
                const json = await resp.json();
                const path = json?.path;
                if (path && path.length >= 2) {
                    coords = path
                        .filter(p => p[1] != null && p[2] != null && !p[5])
                        .map(p => [p[1], p[2]]);
                    if (coords.length < 2) coords = null;
                    else console.log(`Seeded trail for ${hex}: ${coords.length} OpenSky points`);
                }
            }
        }

        if (!coords) { if (!alreadySeeded) _trailSeeded.delete(hex); return; }

        // Replace trail with fresh adsb.lol data — it's denser than our polled accumulation
        _posTrail[hex] = coords;
        if (_posTrail[hex].length > 3000) _posTrail[hex].splice(0, _posTrail[hex].length - 3000);
        scheduleTrailSave();
    } catch (e) {
        if (!alreadySeeded) _trailSeeded.delete(hex);
        console.warn(`Trail seed error for ${hex}:`, e.message);
    }
}

// Per-hex flight phase tracking for parked detection
const _flightState = {}; // hex → { hasBeenAirborne, groundStillCount }
const _callsignToHex = {}; // callsign → last-known hex (survives cache expiry)
const _parkedCallsigns = new Set(); // suppress background polling after flight completes

function parseAdsbAircraft(s, callsign) {
    const onGround = s.alt_baro === 'ground' || (typeof s.alt_baro === 'number' && s.alt_baro < 200);
    return s.lat != null && s.lon != null
        ? { found: true, lat: s.lat, lon: s.lon,
            altFt: typeof s.alt_baro === 'number' ? s.alt_baro : null,
            onGround, speedKts: s.gs ?? null, heading: s.track ?? null,
            callsign: (s.flight || callsign).trim(), type: s.t ?? null, hex: s.hex ?? null }
        : null;
}

// Shared position processing — called by both the API endpoint and background poller.
// Mutates `data` to attach `trail` and `parked` fields.
function processPositionUpdate(data) {
    if (!data.found || data.lat == null || !data.hex) return;
    const hex = data.hex;
    if (data.callsign) { _callsignToHex[data.callsign] = hex; _parkedCallsigns.delete(data.callsign); }
    if (!_flightState[hex]) _flightState[hex] = { hasBeenAirborne: false, groundStillCount: 0 };
    const state = _flightState[hex];
    const moving = (data.speedKts ?? 0) > 5;

    if (!data.onGround) {
        // Airborne
        state.hasBeenAirborne = true;
        state.groundStillCount = 0;
        if (!_posTrail[hex]) _posTrail[hex] = [];
        seedTrailFromOpenSky(hex); // async, fire-and-forget — rate-limited to TRAIL_RESEED_MS
    } else if (state.hasBeenAirborne) {
        // On ground after being airborne — taxiing in or parked
        if (moving) {
            state.groundStillCount = 0; // rolling — not parked yet
        } else {
            state.groundStillCount++;
            if (state.groundStillCount >= 3) {
                // Three consecutive slow/stopped ground readings → parked
                data.parked = true;
                delete _posTrail[hex];
                delete _flightState[hex];
                delete _trailLastTime[hex];
                delete _trailSeedTime[hex];
                _trailSeeded.delete(hex);
                if (data.callsign) _parkedCallsigns.add(data.callsign);
                scheduleTrailSave();
                return; // no trail to attach
            }
        }
    } else if (data.onGround && moving && _posTrail[hex] === undefined) {
        // Taxi-out: plane is rolling before first takeoff — start breadcrumb trail now
        _posTrail[hex] = [];
    }

    // Accumulate trail when airborne OR rolling on ground (taxi-out/taxi-in breadcrumbs)
    if (_posTrail[hex] !== undefined && (!data.onGround || moving)) {
        const trail = _posTrail[hex];
        const last = trail[trail.length - 1];
        const now = Date.now();
        if (!last || (now - (_trailLastTime[hex] || 0)) >= 5000) {
            trail.push([data.lat, data.lon]);
            _trailLastTime[hex] = now;
            if (trail.length > 3000) trail.splice(0, trail.length - 3000);
            scheduleTrailSave();
        }
        data.trail = [...trail];
    }
}

// Fetch live position from ADS-B sources, racing for the fastest response.
async function fetchAdsbPosition(callsign) {
    const ADSB_SOURCES = [
        `https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`,
        `https://api.airplanes.live/v2/callsign/${encodeURIComponent(callsign)}`
    ];
    const trySource = async (url) => {
        const resp = await fetch(url, { signal: AbortSignal.timeout(7000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).hostname}`);
        const json = await resp.json();
        const aircraft = json?.ac;
        if (!aircraft || aircraft.length === 0) throw new Error(`no aircraft at ${new URL(url).hostname}`);
        const s = aircraft.sort((a, b) => (a.seen_pos ?? 999) - (b.seen_pos ?? 999))[0];
        const parsed = parseAdsbAircraft(s, callsign);
        if (!parsed) throw new Error(`no position at ${new URL(url).hostname}`);
        return parsed;
    };
    return Promise.any(ADSB_SOURCES.map(trySource));
}

app.get('/api/live-position', async (req, res) => {
    const callsign = (req.query.callsign || '').toUpperCase().replace(/\s/g, '');
    if (!callsign) return res.json({ found: false });

    const cached = _liveCache[callsign];
    if (cached && Date.now() - cached.ts < LIVE_TTL) return res.json(cached.data);

    let data;
    try {
        data = await fetchAdsbPosition(callsign);
    } catch (e) {
        const details = e instanceof AggregateError
            ? e.errors.map(err => err.message).join(' | ')
            : e.message;
        // "no aircraft" is normal for landed/pre-departure flights — don't spam the log
        const isNoAircraft = details.includes('no aircraft');
        if (!isNoAircraft) console.warn(`live-position [${callsign}]: all sources failed: ${details}`);
        // Tell the client whether this flight has been tracked (has a trail) even though
        // we can't find it live — this lets the client know the flight already flew.
        const lastHex = _callsignToHex[callsign] || _liveCache[callsign]?.data?.hex;
        const hadTrail = !!(lastHex && Array.isArray(_posTrail[lastHex]) && _posTrail[lastHex].length >= 2);
        return res.json({ found: false, hadTrail });
    }

    processPositionUpdate(data);
    _liveCache[callsign] = { ts: Date.now(), data };
    res.json(data);
});

// ── Background flight poller ────────────────────────────────────────────
// Polls ADS-B every 45 s for any scheduled flight whose departure window is
// active. Builds the trail whether or not any client is connected.
async function runActiveFlightPoller() {
    const db = getDB();
    const now = new Date();
    // Wide window: up to 8 h past departure (long flights) and 30 min in future (pre-departure)
    const pastCutoff   = new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
    const futureCutoff = new Date(now.getTime() + 30 * 60 * 1000).toISOString().slice(0, 16);

    db.all(
        `SELECT s.flight_number, s.departure_time, s.pilot_id,
                COALESCE(p.airline_code, '') AS airline_code, p.pilot_key
         FROM segments s
         JOIN pilots p ON s.pilot_id = p.id
         WHERE s.type = 'flight'
           AND s.flight_number IS NOT NULL AND trim(s.flight_number) != ''
           AND s.departure_time >= ? AND s.departure_time <= ?`,
        [pastCutoff, futureCutoff],
        async (err, rows) => {
            if (err || !rows || rows.length === 0) return;
            const polled = new Set();
            for (const row of rows) {
                const airlineCode = (pilotAirlineCodes[row.pilot_key] || row.airline_code || '').toUpperCase();
                let flightNum = (row.flight_number || '').replace(/\s/g, '').toUpperCase();
                // Strip airline prefix if the DB already stores it (e.g. "SKW5613" → "5613")
                if (airlineCode && flightNum.startsWith(airlineCode)) flightNum = flightNum.slice(airlineCode.length);
                if (!airlineCode || !flightNum) continue;
                const callsign = airlineCode + flightNum;
                if (polled.has(callsign)) continue;
                if (_parkedCallsigns.has(callsign)) continue; // already completed this flight
                polled.add(callsign);
                try {
                    const data = await fetchAdsbPosition(callsign);
                    processPositionUpdate(data);
                    // Update the live cache so the next client poll gets pre-built data
                    _liveCache[callsign] = { ts: Date.now(), data };
                    if (data.found && !data.parked) console.log(`Poller: ${callsign} ${data.onGround ? (data.speedKts > 5 ? 'taxiing' : 'ground') : `${data.altFt ? Math.round(data.altFt) + 'ft' : 'airborne'}`} trail=${_posTrail[data.hex]?.length ?? 0}pts`);
                } catch (_) {} // flight not yet airborne or ADS-B unavailable
            }
        }
    );
}

setInterval(runActiveFlightPoller, 15000);
// Run once at startup so the first client poll already has trail data
setTimeout(runActiveFlightPoller, 3000);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Page routes ────────────────────────────────────────────────────────
const ROSTER_LOGIN_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CrewSync · Roster</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px 28px;width:100%;max-width:340px}h2{margin:0 0 24px;font-size:18px;font-weight:700;text-align:center}input{width:100%;padding:10px 14px;background:#09090b;border:1px solid #3f3f46;border-radius:8px;color:#e4e4e7;font-size:15px;outline:none;margin-bottom:12px}input:focus{border-color:#6366f1}button{width:100%;padding:11px;background:#6366f1;border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}button:hover{background:#4f46e5}.err{color:#f87171;font-size:13px;text-align:center;margin-bottom:10px;display:none}</style></head><body><div class="card"><h2>CrewSync</h2><form method="POST" action="/crew-roster/login"><p class="err" id="e">Incorrect password</p><input type="password" name="password" placeholder="Password" autofocus><button type="submit">Sign In</button></form></div><script>if(location.search.includes('err'))document.getElementById('e').style.display='block'</script></body></html>`;

const ROSTER_PW = process.env.ROSTER_PASSWORD || 'crewsync2026';

function rosterAuth(req, res, next) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/roster_auth=([^;]+)/);
    if (match && match[1] === ROSTER_PW) return next();
    res.send(ROSTER_LOGIN_PAGE);
}

app.post('/crew-roster/login', express.urlencoded({ extended: false }), (req, res) => {
    if (req.body.password === ROSTER_PW) {
        res.setHeader('Set-Cookie', `roster_auth=${ROSTER_PW}; Path=/crew-roster; HttpOnly; Max-Age=2592000`);
        return res.redirect('/crew-roster');
    }
    res.redirect('/crew-roster?err=1');
});

// Admin user list — password-protected HTML page
app.get('/crew-roster', rosterAuth, (req, res) => {
    const db = getDB();
    db.all(`SELECT pilot_key, name, base, home_airport, role, token, last_active FROM pilots ORDER BY pilot_key='admin' DESC, name`, (err, rows) => {
        if (err) return res.status(500).send(err.message);
        const origin = req.headers.host ? `${req.protocol}://${req.headers.host}` : '';
        const fmtActive = (iso) => {
            if (!iso) return 'Never';
            const diff = Date.now() - new Date(iso).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 2)   return 'Just now';
            if (mins < 60)  return `${mins}m ago`;
            const hrs = Math.floor(mins / 60);
            if (hrs < 24)   return `${hrs}h ago`;
            const days = Math.floor(hrs / 24);
            if (days < 7)   return `${days}d ago`;
            return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        };
        const cards = rows.map(r => {
            const link = `${origin}/app?u=${r.token}`;
            const initials = r.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const sub = [r.pilot_key, r.base && `base ${r.base}`, r.home_airport && r.home_airport !== r.base && `home ${r.home_airport}`, r.role].filter(Boolean).join(' · ');
            const activeStr = fmtActive(r.last_active);
            const activeColor = !r.last_active ? '#52525b' : (Date.now() - new Date(r.last_active).getTime()) < 86400000 ? '#22c55e' : '#71717a';
            return `<div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:16px 20px;display:flex;flex-direction:column;gap:8px">
  <div style="display:flex;align-items:center;gap:12px">
    <div style="width:40px;height:40px;border-radius:50%;background:#312e81;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0">${initials}</div>
    <div style="flex:1"><div style="font-weight:600;font-size:15px">${r.name}</div><div style="font-size:12px;color:#71717a">${sub}</div></div>
    <div style="font-size:11px;color:${activeColor};white-space:nowrap">${activeStr}</div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;background:#09090b;border:1px solid #27272a;border-radius:8px;padding:8px 12px">
    <span style="flex:1;font-size:12px;color:#a1a1aa;word-break:break-all">${link}</span>
    <button onclick="copyText('${link}',this)" style="background:#27272a;border:none;color:#e4e4e7;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;white-space:nowrap">Copy</button>
    <a href="${link}" target="_blank" style="background:#27272a;color:#e4e4e7;border-radius:6px;padding:4px 10px;font-size:12px;text-decoration:none;white-space:nowrap">Open</a>
  </div>
</div>`;
        }).join('');
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CrewSync · Roster</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto}</style></head><body>
<h2 style="margin:0 0 20px;font-size:20px;font-weight:700">CrewSync · Pilot Links</h2>
<div style="display:flex;flex-direction:column;gap:12px">${cards}</div>
<script>function copyText(t,btn){if(navigator.clipboard&&location.protocol==='https:'){navigator.clipboard.writeText(t).then(()=>{btn.textContent='✓';setTimeout(()=>btn.textContent='Copy',1500)});}else{var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');btn.textContent='✓';setTimeout(()=>btn.textContent='Copy',1500);}catch(e){}document.body.removeChild(ta);}}</script>
</body></html>`);
    });
});

app.get('/admin/users', (req, res) => {
    const db = getDB();
    const { token } = req.query;
    if (!token) return res.status(401).send('Token required');

    db.get(`SELECT token FROM pilots WHERE pilot_key='admin'`, (err, admin) => {
        if (err || !admin || admin.token !== token) return res.status(403).send('Invalid token');

        db.all(`SELECT pilot_key, name, base, home_airport, role, token FROM pilots WHERE pilot_key != 'admin' ORDER BY name`, (err, rows) => {
            if (err) return res.status(500).send(err.message);

            const host = req.headers.host || `localhost:${PORT}`;
            const proto = req.headers['x-forwarded-proto'] || 'http';
            const origin = `${proto}://${host}`;
            const adminLink = `${origin}/admin/users?token=${token}`;

            const cards = rows.map(u => {
                const link = `${origin}/app?u=${u.token}`;
                const initials = (u.name || '').split(' ').map(w => w[0]).join('').slice(0, 2);
                const sub = [u.base, u.home_airport && u.home_airport !== u.base ? `home ${u.home_airport}` : null, u.role].filter(Boolean).join(' · ');
                return `<div class="card">
  <div class="card-header">
    <div class="avatar">${initials}</div>
    <div>
      <div class="name">${u.name}</div>
      <div class="sub">${sub || u.pilot_key}</div>
    </div>
  </div>
  <div class="link-row">
    <div class="link-box" id="link-${u.pilot_key}">${link}</div>
    <button class="btn-copy" onclick="copy('${u.pilot_key}','${link}',this)">Copy</button>
    <a class="btn-open" href="${link}" target="_blank">Open</a>
  </div>
</div>`;
            }).join('');

            res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CrewSync · Users</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#e4e4e7;min-height:100vh;padding:2rem 1rem}
.wrap{max-width:640px;margin:0 auto}
.header{display:flex;align-items:center;gap:12px;margin-bottom:2rem}
.logo{font-size:1.1rem;font-weight:900;color:#3b82f6;text-transform:uppercase;letter-spacing:.05em;font-style:italic}
.header-sub{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#52525b;margin-top:2px}
.cards{display:flex;flex-direction:column;gap:12px}
.card{background:#111113;border:1px solid #27272a;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}
.card-header{display:flex;align-items:center;gap:12px}
.avatar{width:40px;height:40px;border-radius:10px;background:#1e3a5f;color:#60a5fa;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:900;flex-shrink:0}
.name{font-size:.95rem;font-weight:800;color:#fff}
.sub{font-size:.7rem;color:#52525b;font-weight:600;margin-top:2px}
.link-row{display:flex;gap:8px;align-items:center}
.link-box{flex:1;background:#09090b;border:1px solid #1c1c1f;border-radius:8px;padding:8px 10px;font-family:ui-monospace,'SF Mono',monospace;font-size:.7rem;color:#71717a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.btn-copy,.btn-open{flex-shrink:0;padding:7px 14px;border-radius:8px;font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;border:none;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;transition:background .15s}
.btn-copy{background:#1d4ed8;color:#fff}.btn-copy:hover{background:#2563eb}
.btn-open{background:#18181b;color:#a1a1aa;border:1px solid #27272a}.btn-open:hover{color:#fff;border-color:#3f3f46}
.my-link{margin-top:2.5rem;padding:14px 16px;background:#111113;border:1px solid #27272a;border-radius:12px}
.my-link-label{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#3f3f46;margin-bottom:6px}
.my-link-box{display:flex;gap:8px;align-items:center}
.my-link-url{flex:1;font-family:ui-monospace,monospace;font-size:.65rem;color:#3f3f46;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head><body>
<div class="wrap">
  <div class="header">
    <div>
      <div class="logo">CrewSync</div>
      <div class="header-sub">User Links</div>
    </div>
  </div>
  <div class="cards">${cards}</div>
  <div class="my-link">
    <div class="my-link-label">This page (bookmark it)</div>
    <div class="my-link-box">
      <div class="my-link-url">${adminLink}</div>
      <button class="btn-copy" onclick="copyText('${adminLink}',this)">Copy</button>
    </div>
  </div>
</div>
<script>
function copyText(t,btn){if(navigator.clipboard&&location.protocol==='https:'){navigator.clipboard.writeText(t).then(()=>{btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',2000)});}else{var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',2000);}catch(e){}document.body.removeChild(ta);}}
function copy(key,link,btn){copyText(link,btn);}
</script>
</body></html>`);
        });
    });
});

// Landing page at root (unauthenticated entry point)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Dynamic manifest — embeds ?u=TOKEN into start_url so iOS PWA shortcut preserves auth
app.get('/manifest.json', (req, res) => {
    const token = req.query.u;
    const manifest = {
        name: 'CrewSync', short_name: 'CrewSync',
        description: 'Flight crew scheduling and tracking',
        start_url: token ? `/app?u=${encodeURIComponent(token)}` : '/app',
        display: 'standalone',
        background_color: '#09090b', theme_color: '#09090b',
        orientation: 'portrait-primary',
        icons: [
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
    };
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json(manifest);
});

// Main app
app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Join / onboarding
app.get('/join', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// Demo — read-only view, no token required
app.get('/demo', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Demo API — returns fake data, never touches the real DB
app.get('/api/demo/pilots/:pilotKey', (req, res) => {
    const key = req.params.pilotKey;
    const pilot = DEMO_PILOTS[key];
    if (!pilot) return res.status(404).json({ error: 'Demo pilot not found' });
    res.json({ ...pilot, segments: DEMO_SEGMENTS[key] || [] });
});

// ── Token auth API ──────────────────────────────────────────────────────
// Resolve a token → pilot info (used on app load)
app.get('/api/pilots/by-token/:token', (req, res) => {
    const db = getDB();
    const token = req.params.token;
    db.get(`SELECT pilot_key, name, base FROM pilots WHERE token=?`, [token], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Invalid token' });
        db.run(`UPDATE pilots SET last_active=? WHERE token=?`, [new Date().toISOString(), token]);
        res.json({ pilotKey: row.pilot_key, name: row.name, base: row.base });
    });
});

// Get token for a pilot (admin only — used to display links)
app.get('/api/pilots/:pilotKey/token', (req, res) => {
    const db = getDB();
    db.get(`SELECT token FROM pilots WHERE pilot_key=?`, [req.params.pilotKey], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Pilot not found' });
        res.json({ token: row.token });
    });
});

// Join: create a new pilot
app.post('/api/join', async (req, res) => {
    const { firstName, lastName, base, homeAirport, role, parserType, airlineCode } = req.body;
    if (!firstName || !lastName) return res.status(400).json({ error: 'Name required' });

    const db = getDB();
    const name = `${firstName.trim()} ${lastName.trim()}`;
    // Derive a unique pilot_key from first name, add number suffix if collision
    const baseKey = firstName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const token = generateToken();
    const safeRole    = (role || '').trim();
    const safeParser  = (parserType || 'csv').trim();
    const safeCode    = (airlineCode || '').trim().toUpperCase();
    const safeHome    = (homeAirport || base || '').toUpperCase().trim();

    const tryInsert = (key, attempt) => {
        const finalKey = attempt === 0 ? key : `${key}${attempt}`;
        db.run(
            `INSERT INTO pilots (pilot_key, name, base, home_airport, role, parser_type, airline_code, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [finalKey, name, (base || '').toUpperCase().trim(), safeHome, safeRole, safeParser, safeCode, token],
            function(err) {
                if (err && err.message.includes('UNIQUE')) return tryInsert(key, attempt + 1);
                if (err) return res.status(500).json({ error: err.message });
                // Append new pilot's links to PILOT_LINKS.md
                try {
                    const linksPath = path.join(__dirname, 'PILOT_LINKS.md');
                    const prodHost = '167.71.107.245:3000';
                    const prodRow  = `| ${name} | http://${prodHost}/app?u=${token} |`;
                    const localRow = `| ${name} | http://localhost:3000/app?u=${token} |`;
                    let content = fs.readFileSync(linksPath, 'utf8');
                    // Insert before the first Admin row (Production table), then the second (Local table)
                    let insertedProd = false;
                    content = content.replace(/^(\| \*\*Admin\*\* \|.*)$/gm, (match) => {
                        if (!insertedProd) { insertedProd = true; return `${prodRow}\n${match}`; }
                        return `${localRow}\n${match}`;
                    });
                    fs.writeFileSync(linksPath, content, 'utf8');
                } catch (e) {
                    console.error('Could not update PILOT_LINKS.md:', e.message);
                }
                res.json({ success: true, pilotKey: finalKey, token, link: `/app?u=${token}` });
            }
        );
    };
    tryInsert(baseKey, 0);
});

// Keep the process alive — log unhandled errors instead of crashing silently
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});

// Settings — generic key/value store for persisting app config across devices
app.get('/api/settings/:key', (req, res) => {
    const db = getDB();
    db.get(`SELECT value FROM settings WHERE key=?`, [req.params.key], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row ? JSON.parse(row.value) : {});
    });
});

app.post('/api/settings/:key', (req, res) => {
    const db = getDB();
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        [req.params.key, JSON.stringify(req.body)],
        err => err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
    );
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Print all pilot links on startup so tokens are always recoverable from logs
    const db = getDB();
    db.all(`SELECT pilot_key, name, token FROM pilots ORDER BY pilot_key='admin' DESC, name`, (err, rows) => {
        if (err || !rows) return;
        console.log('  ── Login links ──────────────────────────────');
        rows.forEach(r => {
            if (!r.token) return;
            const label = r.pilot_key === 'admin' ? 'Admin' : r.name;
            console.log(`  ${label.padEnd(20)} http://localhost:${PORT}/app?u=${r.token}`);
        });
        const adminRow = rows.find(r => r.pilot_key === 'admin');
        if (adminRow && adminRow.token)
            console.log(`  Users page: http://localhost:${PORT}/admin/users?token=${adminRow.token}`);
        console.log('  ─────────────────────────────────────────────');
    });
});

// Keepalive — ping Schedaero every 20 min with stored creds so the session never expires
setInterval(async () => {
    const db = getDB();
    db.get(`SELECT value FROM settings WHERE key='schedaero-creds'`, async (err, row) => {
        if (err || !row) return;
        const creds = JSON.parse(row.value);
        if (!creds.cookie || !creds.url || !creds.apiToken) return;
        const now = new Date();
        try {
            await fetchSchedaeroMonth(creds.cookie, creds.url, creds.apiToken, now.getMonth() + 1, now.getFullYear());
            console.log('[SchedAero keepalive] session still active');
        } catch (e) {
            console.log(`[SchedAero keepalive] ${e.message}`);
        }
    });
}, 20 * 60 * 1000);
