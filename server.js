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

// Parser for RosterBuster ICS subscription format (Drew)
function parseRosterBusterICS(text) {
    const events = [];
    // Unfold RFC-5545 line continuations (CRLF + space/tab)
    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    const blocks = unfolded.split(/BEGIN:VEVENT/gi).slice(1);

    for (const b of blocks) {
        const lines = b.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const getField = (prefix) => {
            const ln = lines.find(l => l.toUpperCase().startsWith(prefix.toUpperCase() + ':'));
            return ln ? ln.split(/:(.+)/)[1]?.replace(/\\,/g, ',').trim() || '' : '';
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

    // Sort by departure time, then assign trip numbers
    // A new trip starts whenever departure airport is STL (Drew's home base)
    events.sort((a, b) => (a.departureTime || '').localeCompare(b.departureTime || ''));
    let tripNum = 1;
    for (let i = 0; i < events.length; i++) {
        if (i > 0 && events[i].departureAirport === 'STL') tripNum++;
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
const fs = require('fs');

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
    kyle: 'ics',
    adam: 'csv',
    sam: 'csv',
    logan: 'csv_skywest',
    drew: 'ics_rosterbuster'
};

const pilotAirlineCodes = {
    adam: 'RPA',
    sam: 'RPA',
    logan: 'SKW',
    drew: 'GJS'
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
app.post('/api/pilots/:pilotKey/upload', upload.single('file'), async (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;

    if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
    }

    let events = [];

    // Detect file type and parse
    const filename = req.file.originalname.toLowerCase();
    const parserType = getParserForPilot(pilotKey);

    try {
        if (filename.endsWith('.pdf')) {
            events = await parseNetlinePDF(req.file.buffer);
        } else {
            const fileContent = req.file.buffer.toString('utf-8');
            if (filename.endsWith('.ics')) {
                events = parserType === 'ics_rosterbuster'
                    ? parseRosterBusterICS(fileContent)
                    : parseICS(fileContent);
            } else if (filename.endsWith('.csv')) {
                if (parserType === 'csv_skywest') {
                    events = parseCSV_skywest(fileContent);
                } else {
                    events = parseCSV(fileContent, pilotAirlineCodes[pilotKey] || '');
                }
            } else {
                return res.status(400).json({ error: 'Unsupported file type. Use .ics, .csv, or .pdf' });
            }
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

        // Delete only the months covered by this upload so other months are preserved
        const uploadedMonths = [...new Set(
            events
                .map(e => (e.departureTime || '').substring(0, 7))
                .filter(m => /^\d{4}-\d{2}$/.test(m))
        )];
        const doInsert = (err) => {
            if (err) return res.status(500).json({ error: err.message });

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
                    if (err) errors.push(err.message);
                    completed++;
                    if (completed === events.length) {
                        stmt.finalize();
                        if (errors.length > 0)
                            return res.status(500).json({ error: 'Some segments failed to insert', details: errors });
                        res.json({ success: true, segmentsAdded: events.length, parser: parserType });
                    }
                });
            });

            if (events.length === 0) {
                stmt.finalize();
                res.json({ success: true, segmentsAdded: 0, parser: parserType });
            }
        };

        if (uploadedMonths.length > 0) {
            const placeholders = uploadedMonths.map(() => "departure_time LIKE ? || '%'").join(' OR ');
            db.run(
                `DELETE FROM segments WHERE pilot_id = ? AND (is_manual IS NULL OR is_manual = 0) AND (${placeholders})`,
                [pilot.id, ...uploadedMonths],
                doInsert
            );
        } else {
            // No date info (e.g. hard-day-only upload) — fall back to full replace
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
        }
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

        // Replace all non-manual Drew segments
        db.run('DELETE FROM segments WHERE pilot_id = ? AND (is_manual IS NULL OR is_manual = 0)', [pilot.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            if (events.length === 0) return res.json({ success: true, segmentsAdded: 0 });

            const stmt = db.prepare(`
                INSERT INTO segments
                (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, block_minutes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            let completed = 0;
            const errors = [];
            events.forEach(ev => {
                stmt.run([
                    pilot.id, ev.type,
                    ev.departureTime || null, ev.arrivalTime || null,
                    ev.departureAirport || null, ev.arrivalAirport || null,
                    ev.tail || null, ev.trip || null,
                    ev.flightNumber || null, ev.dh ? 1 : 0, null
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
const _trailSeeded = new Set(); // hexes whose OpenSky history has been fetched

async function seedTrailFromOpenSky(hex) {
    if (_trailSeeded.has(hex)) return;
    _trailSeeded.add(hex);
    try {
        const url = `https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!resp.ok) return;
        const json = await resp.json();
        const path = json?.path;
        if (!path || path.length < 2) return;
        const coords = path
            .filter(p => p[1] != null && p[2] != null && !p[5])
            .map(p => [p[1], p[2]]);
        if (coords.length < 2) return;
        // Prepend OpenSky history; our live points (if any) go after
        _posTrail[hex] = [...coords, ...(_posTrail[hex] || [])];
        if (_posTrail[hex].length > 2000) _posTrail[hex].splice(0, _posTrail[hex].length - 2000);
        console.log(`Seeded trail for ${hex}: ${coords.length} OpenSky points`);
    } catch (e) {
        _trailSeeded.delete(hex); // allow retry
        console.warn(`OpenSky seed error for ${hex}:`, e.message);
    }
}

function parseAdsbAircraft(s, callsign) {
    const onGround = s.alt_baro === 'ground' || (typeof s.alt_baro === 'number' && s.alt_baro < 200);
    return s.lat != null && s.lon != null
        ? { found: true, lat: s.lat, lon: s.lon,
            altFt: typeof s.alt_baro === 'number' ? s.alt_baro : null,
            onGround, speedKts: s.gs ?? null, heading: s.track ?? null,
            callsign: (s.flight || callsign).trim(), type: s.t ?? null, hex: s.hex ?? null }
        : null;
}

app.get('/api/live-position', async (req, res) => {
    const callsign = (req.query.callsign || '').toUpperCase().replace(/\s/g, '');
    if (!callsign) return res.json({ found: false });

    const cached = _liveCache[callsign];
    if (cached && Date.now() - cached.ts < LIVE_TTL) return res.json(cached.data);

    // Race adsb.lol and airplanes.live — use whichever responds first with data
    const sources = [
        `https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`,
        `https://api.airplanes.live/v2/callsign/${encodeURIComponent(callsign)}`
    ];

    const trySource = async (url) => {
        const resp = await fetch(url, { signal: AbortSignal.timeout(7000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).hostname}`);
        const json = await resp.json();
        const aircraft = json?.ac;
        if (!aircraft || aircraft.length === 0) throw new Error(`no aircraft at ${new URL(url).hostname}`);
        // Sort ascending by seen_pos so the freshest fix is first
        const s = aircraft.sort((a, b) => (a.seen_pos ?? 999) - (b.seen_pos ?? 999))[0];
        const parsed = parseAdsbAircraft(s, callsign);
        if (!parsed) throw new Error(`no position at ${new URL(url).hostname}`);
        return parsed;
    };

    let data;
    try {
        data = await Promise.any(sources.map(trySource));
    } catch (e) {
        const details = e instanceof AggregateError
            ? e.errors.map(err => err.message).join(' | ')
            : e.message;
        console.warn(`live-position [${callsign}]: all sources failed: ${details}`);
        data = { found: false };
        // Don't cache failures — retry on the next client poll
        return res.json(data);
    }

    // Accumulate position trail keyed by ICAO hex
    if (data.found && data.hex) {
        const hex = data.hex;
        if (data.onGround) {
            // Flight landed — clear trail so next flight starts fresh
            delete _posTrail[hex];
            _trailSeeded.delete(hex);
        } else {
            if (!_posTrail[hex]) {
                _posTrail[hex] = [];
                seedTrailFromOpenSky(hex); // async, fire-and-forget
            }
            const trail = _posTrail[hex];
            const last = trail[trail.length - 1];
            // Add point only if aircraft has moved meaningfully (~0.35 mi)
            if (!last || Math.abs(last[0] - data.lat) > 0.005 || Math.abs(last[1] - data.lon) > 0.005) {
                trail.push([data.lat, data.lon]);
                if (trail.length > 2000) trail.splice(0, trail.length - 2000);
            }
            data.trail = [...trail];
        }
    }

    _liveCache[callsign] = { ts: Date.now(), data };
    res.json(data);
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all other routes (SPA)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
