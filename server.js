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

// Airport city lookup — loaded once at startup from OurAirports data
let _airportCities = {};
try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'airports.json'), 'utf8');
    _airportCities = JSON.parse(raw);
    console.log(`Airport lookup loaded: ${Object.keys(_airportCities).length} entries`);
} catch (e) {
    console.warn('Airport lookup not available — run scripts/fetch-airports.js to enable');
}

// Middleware
const compression = require('compression');
app.use(compression());
app.use(cors());
app.use(bodyParser.json());
// Prevent browsers (especially iOS PWA) from caching HTML pages
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/' || req.path === '/app' || req.path === '/landing' || req.path === '/join') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});
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

// Convert local datetime (YYYYMMDDTHHMMSS) in a named timezone to UTC ISO string.
// Works via the Intl.DateTimeFormat "TZ-as-display" offset trick — no DST tables needed.
function localTZToUTC(dtStr, tzid) {
    const y = dtStr.slice(0, 4), mo = dtStr.slice(4, 6), d = dtStr.slice(6, 8);
    const h = dtStr.slice(9, 11), mi = dtStr.slice(11, 13), s = dtStr.slice(13, 15) || '00';
    const asUTC = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`); // treat local as UTC first
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(asUTC);
    const p = {};
    parts.forEach(pt => { if (pt.type !== 'literal') p[pt.type] = pt.value; });
    const hh = p.hour === '24' ? '00' : p.hour;
    const tzDisplayed = new Date(`${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}Z`);
    const offsetMs = asUTC.getTime() - tzDisplayed.getTime();
    return new Date(asUTC.getTime() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// AIMS eCrew ICS parser — works for any airline using AIMS eCrew scheduling
// Each VEVENT is a duty period; individual legs are in the DESCRIPTION.
// airlineCode (ICAO) is used to prefix numeric-only operating flight codes (e.g. '3030' → 'SCX3030')
function parseECrewICS(text, airlineCode = '', iataAliases = []) {
    const events = [];
    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    const blocks = unfolded.split(/BEGIN:VEVENT/gi).slice(1);

    const cleanApt = (a) => /^[A-Z]{3}\d$/.test(a.toUpperCase()) ? a.slice(0, 3).toUpperCase() : a.toUpperCase();

    // Add N calendar days to a YYYYMMDD string
    const addDays = (yyyymmdd, n) => {
        const d = new Date(`${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0,10).replace(/-/g,'');
    };

    // Parse ⁺¹ / ⁺² day-offset suffix from a time field string (Unicode superscripts)
    const parseDayOffset = (s) => {
        const m = s.match(/[⁺+]([¹²³\d])/);
        if (!m) return 0;
        const sup = { '¹': 1, '²': 2, '³': 3 };
        return sup[m[1]] ?? parseInt(m[1], 10);
    };

    // Leg line: "CODE  - DEP  (HHMM[⁺¹]) - ARR  ([E]HHMM[⁺¹])"
    // The E prefix on arrival time means "estimated" (e.g. "E0237⁺¹")
    const LEG_RE = /^([A-Z0-9]+)\s{1,4}-\s+([A-Z]{3}\d?)\s*\([A-Z]?(\d{4}[^)]*)\)\s+-\s+([A-Z]{3}\d?)\s*\([A-Z]?(\d{4}[^)]*)\)/i;

    for (const b of blocks) {
        const lines = b.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        const getField = (prefix) => {
            const up = prefix.toUpperCase();
            const ln = lines.find(l => { const u = l.toUpperCase(); return u.startsWith(up + ':') || u.startsWith(up + ';'); });
            if (!ln) return '';
            const ci = ln.indexOf(':');
            return ci >= 0 ? ln.slice(ci + 1) : '';
        };

        const summary  = getField('SUMMARY');
        const location = getField('LOCATION');
        const rawDesc  = getField('DESCRIPTION').replace(/\\n/g, '\n');
        const rawStart = lines.find(l => /^DTSTART/i.test(l)) || '';
        const rawEnd   = lines.find(l => /^DTEND/i.test(l))   || '';

        if (!summary || !rawStart) continue;

        const dtStartVal = rawStart.split(':').slice(1).join(':');
        const dtEndVal   = rawEnd ? rawEnd.split(':').slice(1).join(':') : '';
        const tzMatch    = rawStart.match(/TZID=([^:;]+)/i);
        const tzid       = tzMatch ? tzMatch[1] : 'UTC';

        const toUTC = (val, tz) => tz !== 'UTC' ? localTZToUTC(val, tz) : formatICSDatetime(val);

        // Reserve duty: RESR / RESP / RESA / RAP (Reserve Alert Period) / LCR (Long Call Reserve)
        // DTSTART is the reporting/duty block time, NOT the actual reserve window.
        // Parse actual on-call window times from the DESCRIPTION leg line, e.g.:
        //   "RESR - CVG  (1700) - CVG  (0659⁺¹)" → window 5:00 PM → 6:59 AM
        //   "LCR  - CVG  (0201) - CVG  (0200⁺¹)" → window 2:01 AM → 2:00 AM next day
        const resMatch = summary.match(/^(RES[A-Z]|RAP|LCR)\b/i);
        if (resMatch) {
            const locApt  = cleanApt(location.split(')').pop().trim().replace(/\d+$/, '').trim() || '');
            const baseDate = dtStartVal.slice(0, 8);
            let depTime = toUTC(dtStartVal, tzid); // fallback
            let arrTime = dtEndVal ? toUTC(dtEndVal, tzid) : '';

            const descLines = rawDesc.split('\n').map(l => l.trim()).filter(Boolean);
            for (const line of descLines) {
                const m = line.match(LEG_RE);
                if (!m || !/^(RES|RAP|LCR)/i.test(m[1])) continue;
                const depField = m[3], arrField = m[5];
                const depHHMM  = depField.replace(/\D/g, '').slice(0, 4);
                const arrHHMM  = arrField.replace(/\D/g, '').slice(0, 4);
                const depDateStr = addDays(baseDate, parseDayOffset(depField));
                const arrDateStr = addDays(baseDate, parseDayOffset(arrField));
                const depTZ = _aptTimezone[cleanApt(m[2])] || tzid;
                const arrTZ = _aptTimezone[cleanApt(m[4])] || tzid;
                depTime = toUTC(`${depDateStr}T${depHHMM}00`, depTZ);
                arrTime = toUTC(`${arrDateStr}T${arrHHMM}00`, arrTZ);
                break;
            }

            events.push({
                type: 'reserve',
                departureTime: depTime,
                arrivalTime:   arrTime,
                departureAirport: locApt,
                arrivalAirport:   locApt,
                flightNumber: resMatch[1].toUpperCase(),
                tail: '', trip: null, dh: false, blockMinutes: null
            });
            continue;
        }

        // Trip ID: first word of SUMMARY (skip "RAP" prefix if present)
        const summaryParts = summary.trim().split(/\s+/);
        const tripId = (summaryParts[0].toUpperCase() === 'RAP' ? summaryParts[1] : summaryParts[0]) || summaryParts[0];

        // Base date = local date from DTSTART (e.g. "20260530" from "20260530T223000")
        const baseDate = dtStartVal.slice(0, 8);

        // Parse each individual leg from DESCRIPTION
        const descLines = rawDesc.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of descLines) {
            const m = line.match(LEG_RE);
            if (!m) continue;

            const code   = m[1].toUpperCase();
            const depApt = cleanApt(m[2]);
            const arrApt = cleanApt(m[4]);

            if (code === 'RAP' || depApt === arrApt) continue; // repositioning pay or same-airport

            const depField = m[3]; // e.g. "2330" or "0150⁺¹"
            const arrField = m[5];
            const depHHMM  = depField.replace(/\D/g, '').slice(0, 4);
            const arrHHMM  = arrField.replace(/\D/g, '').slice(0, 4);

            // Use each airport's own timezone for accurate UTC conversion
            const depTZ = _aptTimezone[depApt] || tzid;
            const arrTZ = _aptTimezone[arrApt] || tzid;

            // eCrew description offsets (⁺¹, ⁺²) are relative to the duty PERIOD start,
            // which may be in a prior VEVENT (e.g. a RAP on the previous day). When the
            // departure airport shares the same timezone as DTSTART AND the HHMM matches,
            // DTSTART is already on the correct calendar day and the offset has been
            // "consumed" — subtract it so we don't overshoot by a day.
            let depOffset = parseDayOffset(depField);
            let arrOffset = parseDayOffset(arrField);
            if (depOffset > 0 && depTZ === tzid) {
                const dtStartHHMM = dtStartVal.slice(9, 13);
                if (dtStartHHMM === depHHMM) { arrOffset -= depOffset; depOffset = 0; }
            }

            const depDateStr = addDays(baseDate, depOffset);
            const arrDateStr = addDays(baseDate, arrOffset);

            const depUTC = toUTC(`${depDateStr}T${depHHMM}00`, depTZ);
            const arrUTC = toUTC(`${arrDateStr}T${arrHHMM}00`, arrTZ);

            if (/^GRND/i.test(code)) {
                // Ground transport (van/bus) — store for map location tracking only
                events.push({
                    type: 'ground',
                    departureTime: depUTC,
                    arrivalTime:   arrUTC,
                    departureAirport: depApt,
                    arrivalAirport:   arrApt,
                    flightNumber: code,
                    tail: '', trip: tripId, dh: false, blockMinutes: null
                });
                continue;
            }

            const isOWN     = /^OWN/i.test(code);
            const isNumeric = /^\d+$/.test(code);
            // Code starts with the pilot's own main ICAO prefix (e.g. GTI789)
            const startsWithMain = !isNumeric && airlineCode &&
                code.toUpperCase().startsWith(airlineCode.toUpperCase()) &&
                /^\d+$/.test(code.slice(airlineCode.length));
            // Code starts with a known alias prefix (iataAliases is a {prefix: icaoPrefix} map)
            const aliasKeys = Object.keys(iataAliases);
            const matchedAlias = !isNumeric && !startsWithMain && aliasKeys.find(p =>
                code.toUpperCase().startsWith(p.toUpperCase()) && /^\d+$/.test(code.slice(p.length))
            );
            const isOperating = isNumeric || startsWithMain || !!matchedAlias;
            const isDH        = !isOperating || isOWN;

            let flightNumber = '';
            if (isOperating && !isOWN) {
                if (isNumeric) {
                    flightNumber = `${airlineCode}${code}`;
                } else if (startsWithMain) {
                    flightNumber = code.toUpperCase();
                } else if (matchedAlias) {
                    const digits = code.slice(matchedAlias.length);
                    const icaoPrefix = iataAliases[matchedAlias]; // mapped ICAO prefix
                    flightNumber = `${icaoPrefix}${digits}`;
                }
            } else if (!isOWN) {
                flightNumber = code;
            }

            const blockMinutes = depUTC && arrUTC
                ? Math.round((new Date(arrUTC) - new Date(depUTC)) / 60000)
                : null;

            events.push({
                type: 'flight',
                departureTime: depUTC,
                arrivalTime:   arrUTC,
                departureAirport: depApt,
                arrivalAirport:   arrApt,
                flightNumber,
                tail: '',
                trip: tripId,
                dh:   isDH,
                blockMinutes: blockMinutes > 0 ? blockMinutes : null
            });
        }
    }

    events.sort((a, b) => (a.departureTime || '').localeCompare(b.departureTime || ''));
    return events;
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

// SkyWest SkedPlus+ VCS parser (.vcs file from SkyWest scheduling)
function parseVCS_skywest(text) {
    // Decode a quoted-printable field value (handles soft line breaks and =XX escapes)
    function decodeQP(raw) {
        return raw
            .replace(/=\r?\n/g, '')                                          // soft line breaks
            .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }

    // Extract a single-line property value, joining QP-folded continuation lines
    function extractProp(block, key) {
        const re = new RegExp(`^${key}[^\r\n]*:([^\r\n]*)(\r?\n[ \t][^\r\n]*)*`, 'm');
        const m = block.match(re);
        if (!m) return '';
        return m[0].split(/\r?\n/).map((l, i) => i === 0 ? l.replace(/^[^:]+:/, '') : l.replace(/^[ \t]/, '')).join('');
    }

    // Extract DESCRIPTION, which uses ENCODING=QUOTED-PRINTABLE with physical line soft-wraps.
    // Lines MUST be joined with \n preserved so decodeQP can match =\n soft-break sequences.
    // VCS property keys are ALL_CAPS before the colon — use that to detect next-property lines.
    function extractDesc(block) {
        const start = block.search(/^DESCRIPTION/m);
        if (start < 0) return '';
        const chunk = block.slice(start);
        const lines = chunk.split(/\r?\n/);
        const rawLines = [lines[0].replace(/^DESCRIPTION[^:]*:/, '')];
        for (let i = 1; i < lines.length; i++) {
            if (/^[A-Z]+[;:]/.test(lines[i])) break;  // start of next VCS property (ALL_CAPS:)
            rawLines.push(lines[i]);
        }
        return decodeQP(rawLines.join('\n'));
    }

    const events = [];
    const seenUIDs = new Set();
    const blocks = text.split(/BEGIN:VEVENT/);

    for (const block of blocks.slice(1)) {
        const summary  = extractProp(block, 'SUMMARY').trim();
        const uid      = extractProp(block, 'UID').trim();
        const dtstart  = extractProp(block, 'DTSTART').trim();
        const dtend    = extractProp(block, 'DTEND').trim();

        if (summary === 'OFF') continue;
        if (summary.includes('(cont)')) continue;
        if (seenUIDs.has(uid)) continue;
        seenUIDs.add(uid);

        // RE2 / RE3 etc — reserve on-call window (floating local time, SFO base)
        if (/^RE\d*$/.test(summary)) {
            const parseLocal = s => s && s.length >= 13
                ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:00`
                : null;
            const dep = parseLocal(dtstart);
            const arr = parseLocal(dtend);
            if (dep) {
                events.push({
                    type: 'reserve',
                    departureTime:   dep,
                    arrivalTime:     arr || dep,
                    departureAirport: '',
                    arrivalAirport:   '',
                    flightNumber:    summary,
                    tail: '', trip: '', dh: false, blockMinutes: null
                });
            }
            continue;
        }

        // Pairing event — any "PREFIX PAIRING_CODE [AIRCRAFT]" summary (ADD, TRN, IOE, etc.)
        // Single-word events (NJM, MOV, PDS, PDE…) fall through here since they have no second token.
        const pairingM = summary.match(/^\S+\s+(\S+)(?:\s+(\S+))?/);
        if (!pairingM) continue;
        const tripName   = pairingM[1] || '';
        const defaultTail = pairingM[2] || '';

        const desc  = extractDesc(block);
        const lines = desc.split(/\n/);
        let currentDate = null;

        for (const line of lines) {
            // Day header: "Tuesday 06-02-2026   Report: 17:52"
            const dayM = line.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{2})-(\d{2})-(\d{4})/);
            if (dayM) {
                currentDate = `${dayM[3]}-${dayM[1]}-${dayM[2]}`;
                continue;
            }

            // New format (with tail#): "2. 5508  ER7  N84378  SFO  CLD  18:28  21:07  Block: 2:39"
            // acType identified by containing a digit (e.g. ER7); tail follows before airports
            const fullLegM = line.match(/^\s*\d+\.\s+(\*?\S+)\s+\S*\d\S*\s+(\S+)\s+([A-Z]{3,4})\s+([A-Z]{3,4})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})(?:.*?Block:\s*([\d:]+))?/);
            // Old format (no tail#): "2. 5508  ER7    SFO  CLD  18:37  20:27  Block: 1:50"
            const midLegM = !fullLegM && line.match(/^\s*\d+\.\s+(\*?\S+)\s+\S*\d\S*\s+([A-Z]{3,4})\s+([A-Z]{3,4})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})(?:.*?Block:\s*([\d:]+))?/);
            // DH/codeshare (no acType/tail): "3. 469  LAX  SFO  13:25  14:53"
            const shortLegM = !fullLegM && !midLegM && line.match(/^\s*\d+\.\s+(\S+)\s+([A-Z]{3,4})\s+([A-Z]{3,4})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})(?:.*?Block:\s*([\d:]+))?/);
            if ((!fullLegM && !midLegM && !shortLegM) || !currentDate) continue;

            let fltNum, tail, dep, arr, depT, arrT, blockStr;
            if (fullLegM) {
                [, fltNum, tail, dep, arr, depT, arrT, blockStr] = fullLegM;
            } else if (midLegM) {
                [, fltNum, dep, arr, depT, arrT, blockStr] = midLegM;
                tail = defaultTail;
            } else {
                [, fltNum, dep, arr, depT, arrT, blockStr] = shortLegM;
                tail = defaultTail;
            }
            fltNum = fltNum.replace(/^\*/, '');  // strip asterisk from amended flights
            if (dep === arr) continue;  // skip LCO/SHO/SBY/ground events

            const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
            const depMin = toMin(depT);
            const arrMin = toMin(arrT);
            let arrDate = currentDate;
            if (arrMin < depMin) {
                const d = new Date(currentDate + 'T12:00:00Z');
                d.setUTCDate(d.getUTCDate() + 1);
                arrDate = d.toISOString().slice(0, 10);
            }
            const blockMinutes = blockStr
                ? parseInt(blockStr.split(':')[0]) * 60 + parseInt(blockStr.split(':')[1])
                : null;

            events.push({
                type: 'flight',
                departureTime:    `${currentDate}T${depT.padStart(5,'0')}:00`,
                arrivalTime:      `${arrDate}T${arrT.padStart(5,'0')}:00`,
                departureAirport: dep,
                arrivalAirport:   arr,
                flightNumber:     fltNum,
                tail:             tail || defaultTail,
                trip:             tripName,
                dh:               false,
                blockMinutes
            });
        }
    }

    events.sort((a, b) => (a.departureTime || '').localeCompare(b.departureTime || ''));
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
        const text = (evt.text || '').trim().toUpperCase();
        if (text === 'HARD') {
            if (filterMonth && filterYear) {
                const d = new Date(asUtcIso(evt.startDate));
                if (d.getMonth() + 1 !== filterMonth || d.getFullYear() !== filterYear) continue;
            }
            const date = evt.startDate.substring(0, 10);
            events.push({ type: 'hard', departureTime: `${date}T00:00:00` });
        } else if (text.startsWith('VAC')) {
            const start = new Date((evt.startDate || '').substring(0, 10) + 'T12:00:00Z');
            const end   = new Date((evt.endDate || evt.end || evt.startDate || '').substring(0, 10) + 'T12:00:00Z');
            if (isNaN(start)) continue;
            for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
                if (filterMonth && filterYear) {
                    if (d.getUTCMonth() + 1 !== filterMonth || d.getUTCFullYear() !== filterYear) continue;
                }
                const dateStr = d.toISOString().substring(0, 10);
                events.push({ type: 'vacation', departureTime: `${dateStr}T00:00:00` });
            }
        }
    }

    return events;
}

// ===== NetLine/Crew PDF Parser (GoJet / Drew) =====
const pdfParse = require('pdf-parse');
const tzlookup = require('tz-lookup');

// Build airport code → [lat, lon], timezone, and IATA↔ICAO maps.
// Phase 1: airports.dat (OpenFlights) — used for timezone data which OurAirports lacks.
// Phase 2: airports_raw.csv (OurAirports, ~85k) — broader coverage for coords.
const _aptCoords = {};
const _aptTimezone = {};
const _iataToIcaoApt = {};
const _icaoToIataApt = {};
try {
    const lines = fs.readFileSync(path.join(__dirname, 'airports.dat'), 'utf8').split('\n');
    for (const line of lines) {
        const p = line.split(',').map(s => s.replace(/^"|"$/g, ''));
        const iata = p[4]?.trim(), icao = p[5]?.trim();
        const lat = parseFloat(p[6]), lon = parseFloat(p[7]);
        const tz = p[11]?.trim();
        if (!isFinite(lat) || !isFinite(lon)) continue;
        if (iata && iata !== '\\N' && iata !== 'N/A') {
            _aptCoords[iata.toUpperCase()] = [lat, lon];
            if (tz && tz !== '\\N') _aptTimezone[iata.toUpperCase()] = tz;
        }
        if (icao && icao !== '\\N' && icao !== 'N/A') _aptCoords[icao.toUpperCase()] = [lat, lon];
        if (iata && iata !== '\\N' && icao && icao !== '\\N') {
            _iataToIcaoApt[iata.toUpperCase()] = icao.toUpperCase();
            _icaoToIataApt[icao.toUpperCase()] = iata.toUpperCase();
        }
    }
    console.log(`Airport DB (OpenFlights): ${Object.keys(_aptCoords).length} codes`);
} catch (e) {
    console.error('Could not load airports.dat:', e.message);
}
// Phase 2: supplement with OurAirports full dataset (ident, icao_code, gps_code indexed)
try {
    const rawLines = fs.readFileSync(path.join(__dirname, 'data', 'airports_raw.csv'), 'utf8').split('\n');
    // columns: id,ident,type,name,lat,lon,elev,continent,country,region,muni,sched,icao,iata,gps,local,...
    for (let i = 1; i < rawLines.length; i++) {
        const cols = rawLines[i].split(',').map(s => s.replace(/^"|"$/g, '').trim());
        const ident = cols[1], icao = cols[12], iata = cols[13], gps = cols[14];
        const lat = parseFloat(cols[4]), lon = parseFloat(cols[5]);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        // Index by ident and gps_code (these are the ICAO-style identifiers pilots use)
        for (const code of [ident, icao, gps]) {
            if (code && code !== 'N/A' && !_aptCoords[code.toUpperCase()])
                _aptCoords[code.toUpperCase()] = [lat, lon];
        }
        // Only index by proper iata_code (3-letter), not local_code (avoids PAN→Thailand conflict)
        if (iata && iata !== 'N/A' && iata.length === 3 && !_aptCoords[iata.toUpperCase()])
            _aptCoords[iata.toUpperCase()] = [lat, lon];
        // Build IATA↔ICAO maps where both exist
        if (iata && iata !== 'N/A' && iata.length === 3 && icao && icao !== 'N/A') {
            if (!_iataToIcaoApt[iata.toUpperCase()]) _iataToIcaoApt[iata.toUpperCase()] = icao.toUpperCase();
            if (!_icaoToIataApt[icao.toUpperCase()]) _icaoToIataApt[icao.toUpperCase()] = iata.toUpperCase();
        }
    }
    console.log(`Airport DB (OurAirports supplement): ${Object.keys(_aptCoords).length} total codes`);
} catch (e) {
    console.error('Could not load airports_raw.csv:', e.message);
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
    logan: 'vcs_skywest',
    drew: 'ics_rosterbuster'
};

const pilotAirlineCodes = {
    kyle: 'SJJ',
    adam: 'RPA',
    sam: 'RPA',
    logan: 'SKW',
    drew: 'GJS'
};

// Operating code aliases for eCrew airlines, keyed by main ICAO code.
// Each alias maps a prefix found in the schedule → the ICAO prefix to store.
// Numeric-only codes always get the main ICAO prefix.
const ECREW_IATA_ALIASES = {
    'SCX': { 'SY': 'SCX' },                         // Sun Country: SY → SCX
    'GTI': { 'PAC': 'PAC', '5Y': 'GTI', 'PO': 'PAC' }, // Atlas: PAC stays PAC, 5Y→GTI, PO (Polar IATA)→PAC
};

function getParserForPilot(pilotKey, pilotRow) {
    // Prefer hardcoded config for existing pilots; use DB value for new ones
    return pilotParsers[pilotKey] || (pilotRow?.parser_type) || 'csv';
}

function autoDetectParser(filename, fileContent) {
    if (filename.endsWith('.vcs') || fileContent.includes('PRODID:SkyWest Inc SkedPlus+')) {
        const events = parseVCS_skywest(fileContent);
        if (events.length > 0) return { parser: 'vcs_skywest', events };
    }
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

    db.get('SELECT id, pilot_key, name, base, home_airport, role, parser_type, airline_code FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
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
            // Resolve parser and airline code — hardcoded map takes precedence over DB for existing pilots
            const resolvedParser = getParserForPilot(pilotKey, pilot);
            const resolvedCode   = pilotAirlineCodes[pilotKey] || pilot.airline_code || '';
            res.json({ ...pilot, parser_type: resolvedParser, airline_code: resolvedCode, segments });
        });
    });
});

// GET /api/pilots/:pilotKey/here-now — debug endpoint showing where the HERE-NOW pin resolves to and why
app.get('/api/pilots/:pilotKey/here-now', (req, res) => {
    const db = getDB();
    const { pilotKey } = req.params;

    db.get('SELECT id, name, base, home_airport FROM pilots WHERE pilot_key = ?', [pilotKey], (err, pilot) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!pilot) return res.status(404).json({ error: 'Pilot not found' });

        db.all('SELECT * FROM segments WHERE pilot_id = ? ORDER BY departure_time', [pilot.id], (err, segs) => {
            if (err) return res.status(500).json({ error: err.message });

            const now = new Date();
            const nowISO = now.toISOString();

            // Detect UTC pilot by Z suffix on first flight's departure_time
            const firstFlight = segs.find(s => s.type === 'flight' && s.departure_time);
            const isUTCPilot = !!(firstFlight && firstFlight.departure_time.endsWith('Z'));

            // Convert a stored time string to UTC Date. UTC pilots use Z times; others use local
            // stored times (no TZ suffix). For local times we use Intl to convert via airport tz.
            const aptTzCache = {};
            function aptTz(code) {
                if (!code) return null;
                if (aptTzCache[code]) return aptTzCache[code];
                const coords = _airportCities[code.toUpperCase()];
                if (!coords) return null;
                try {
                    // Use Intl to probe timezone from coordinates via a known-offset trick
                    // We can't map lat/lon → IANA tz server-side without a library, so fall back
                    // to null and use raw string comparison for non-UTC pilots.
                } catch(e) {}
                return null;
            }

            function toUTCDate(isoStr) {
                if (!isoStr) return null;
                if (isoStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(isoStr)) return new Date(isoStr);
                // For local-time strings, treat as UTC for comparison purposes in this debug endpoint.
                // This gives slight drift (hours) but is sufficient to identify which flight is "last completed".
                return new Date(isoStr + 'Z');
            }

            const flights = segs
                .filter(s => s.type === 'flight' && s.departure_time && s.arrival_time)
                .map(s => ({
                    id: s.id,
                    type: s.type,
                    trip: s.trip,
                    dep_airport: s.departure_airport,
                    arr_airport: s.arrival_airport,
                    dep_time: s.departure_time,
                    arr_time: s.arrival_time,
                    flight_number: s.flight_number,
                    dep_utc: toUTCDate(s.departure_time)?.toISOString() || null,
                    arr_utc: toUTCDate(s.arrival_time)?.toISOString() || null,
                    dep_past: toUTCDate(s.departure_time) ? toUTCDate(s.departure_time) <= now : null,
                    arr_past: toUTCDate(s.arrival_time) ? toUTCDate(s.arrival_time) <= now : null,
                    is_manual: !!s.is_manual,
                }))
                .sort((a, b) => a.dep_time.localeCompare(b.dep_time));

            // Completed = departure AND arrival both in the past
            const completedFlights = flights.filter(f => f.dep_past && f.arr_past);
            const lastFlight = completedFlights.length > 0 ? completedFlights[completedFlights.length - 1] : null;
            const lastArrival = lastFlight ? lastFlight.arr_airport : null;

            const home = pilot.home_airport || null;
            const base = pilot.base || null;
            const atHome = lastArrival && home && lastArrival.toUpperCase() === home.toUpperCase();
            const atBase = lastArrival && base && lastArrival.toUpperCase() === base.toUpperCase();

            // Active flights (dep past, arr future)
            const activeFlights = flights.filter(f => f.dep_past && f.arr_past === false);

            // Reserve segments
            const reserves = segs.filter(s => s.type === 'reserve' && s.departure_airport);

            let location, label, stepFired, stepDetail;

            if (activeFlights.length > 0) {
                stepFired = '1_airborne';
                const f = activeFlights[0];
                location = f.dep_airport;
                label = 'Airborne (pin at dep airport until ADS-B overrides)';
                stepDetail = { active_leg: f };
            } else if (!lastArrival) {
                stepFired = '5b_no_completed_flights';
                location = home;
                label = 'Home (no completed flights)';
                stepDetail = { note: 'No completed flights found. Pilot shown at home.' };
            } else if (!atHome) {
                stepFired = '5_mid_trip';
                location = lastArrival;
                label = `Overnight at ${lastArrival}`;
                stepDetail = { last_arrival: lastArrival, at_home: atHome, at_base: atBase };
            } else {
                stepFired = '6_at_home';
                location = home;
                label = 'Home';
                stepDetail = { last_arrival: lastArrival };
            }

            res.json({
                pilot: pilotKey,
                name: pilot.name,
                home,
                base,
                now: nowISO,
                is_utc_pilot: isUTCPilot,
                location,
                label,
                step_fired: stepFired,
                step_detail: stepDetail,
                debug: {
                    note: 'dep_utc/arr_utc use raw string + Z suffix for local-time pilots (approximate; actual app uses airport timezone). dep_past/arr_past are based on this approximation.',
                    total_flights: flights.length,
                    completed_count: completedFlights.length,
                    active_count: activeFlights.length,
                    last_flight: lastFlight,
                    reserve_count: reserves.length,
                },
                flights,
            });
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
    db.get('SELECT id, parser_type, airline_code, base, home_airport FROM pilots WHERE pilot_key = ?', [pilotKey], async (err, pilot) => {
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
                        : (parserType === 'ics_scx' || parserType === 'ics_ecrew')
                        ? parseECrewICS(fileContent, airlineCode, ECREW_IATA_ALIASES[airlineCode] || [])
                        : parseICS(fileContent);
                } else if (filename.endsWith('.vcs') || (filename.endsWith('.ics') && fileContent.includes('PRODID:SkyWest Inc SkedPlus+'))) {
                    events = parseVCS_skywest(fileContent);
                } else if (filename.endsWith('.csv')) {
                    events = parserType === 'csv_skywest'
                        ? parseCSV_skywest(fileContent)
                        : parseCSV(fileContent, airlineCode);
                } else {
                    return res.status(400).json({ error: 'Unsupported file type. Use .ics, .csv, .vcs, or .pdf' });
                }
            }
        } catch (parseError) {
            return res.status(400).json({ error: `Parse error: ${parseError.message}` });
        }

        // Fill reserve location from pilot's airline base (where they report for duty)
        const pilotBase = pilot.base || pilot.home_airport || '';
        if (pilotBase) {
            events.forEach(ev => {
                if (ev.type === 'reserve' && !ev.departureAirport) {
                    ev.departureAirport = pilotBase;
                    ev.arrivalAirport   = pilotBase;
                }
            });
        }

        // Replace all non-manual events for the date range covered by this file, then insert fresh.
        // This ensures re-uploading a corrected file removes stale events from a previous broken parse.
        if (events.length === 0) {
            return res.json({ success: true, segmentsAdded: 0, parser: parserType });
        }

        const allTimes = events.flatMap(e => [e.departureTime, e.arrivalTime]).filter(Boolean).sort();
        const rangeStart = allTimes[0].slice(0, 10);
        const rangeEnd   = allTimes[allTimes.length - 1].slice(0, 10);

        db.run(
            `DELETE FROM segments WHERE pilot_id=? AND (is_manual IS NULL OR is_manual=0) AND departure_time>=? AND departure_time<=?`,
            [pilot.id, rangeStart + 'T00:00:00', rangeEnd + 'T23:59:59'],
            (delErr) => {
                if (delErr) return res.status(500).json({ error: delErr.message });

                let completed = 0;
                const errors = [];
                const done = () => {
                    completed++;
                    if (completed === events.length) {
                        if (errors.length > 0)
                            return res.status(500).json({ error: 'Some segments failed', details: errors });
                        logEvent(pilotKey, 'upload:schedule');
                        res.json({ success: true, segmentsAdded: events.length, parser: parserType });
                    }
                };

                events.forEach(event => {
                    db.run(
                        `INSERT INTO segments (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, block_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [pilot.id, event.type, event.departureTime || null, event.arrivalTime || null, event.departureAirport || null, event.arrivalAirport || null, event.tail || null, event.trip || null, event.flightNumber || null, event.dh ? 1 : 0, event.blockMinutes || null],
                        err => { if (err) errors.push(err.message); done(); }
                    );
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

// Core ICS sync logic — shared by the HTTP endpoint and the auto-sync scheduler
async function syncPilotICS(pilotKey, urlOverride = null) {
    const db = getDB();

    const url = urlOverride || await new Promise((resolve, reject) => {
        db.get(`SELECT value FROM settings WHERE key=?`, [`${pilotKey}_ics_url`], (err, row) => {
            if (err) return reject(err);
            const data = row ? JSON.parse(row.value) : null;
            resolve(data?.url || null);
        });
    });
    if (!url) throw new Error('No ICS URL configured');

    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw Object.assign(new Error(`ICS fetch returned ${resp.status}`), { status: resp.status });
    const icsText = await resp.text();

    const pilot = await new Promise((resolve, reject) => {
        db.get('SELECT id, parser_type, airline_code, base, home_airport FROM pilots WHERE pilot_key = ?', [pilotKey], (err, row) => {
            if (err) return reject(err); resolve(row);
        });
    });
    if (!pilot) throw new Error('Pilot not found');

    const resolvedParser = pilotParsers[pilotKey] || pilot.parser_type || 'ics';
    const resolvedCode = pilotAirlineCodes[pilotKey] || pilot.airline_code || '';
    const events = resolvedParser === 'ics_rosterbuster'
        ? parseRosterBusterICS(icsText)
        : (resolvedParser === 'ics_scx' || resolvedParser === 'ics_ecrew')
        ? parseECrewICS(icsText, resolvedCode, ECREW_IATA_ALIASES[resolvedCode] || [])
        : parseICS(icsText);

    const pilotBase = pilot.base || '';
    if (pilotBase) {
        events.forEach(ev => {
            if (ev.type === 'reserve' && !ev.departureAirport) {
                ev.departureAirport = pilotBase;
                ev.arrivalAirport   = pilotBase;
            }
        });
    }

    const nowIso = new Date().toISOString();

    const existing = await new Promise((resolve, reject) => {
        db.all(
            'SELECT id, type, departure_time, departure_airport FROM segments WHERE pilot_id = ? AND (is_manual IS NULL OR is_manual = 0)',
            [pilot.id],
            (err, rows) => { if (err) return reject(err); resolve(rows); }
        );
    });

    const existingMap = {};
    existing.forEach(s => {
        existingMap[`${s.type}|${s.departure_time || ''}|${s.departure_airport || ''}`] = s.id;
    });

    const incomingKeys = new Set(events.map(ev => `${ev.type}|${ev.departureTime || ''}|${ev.departureAirport || ''}`));
    const matchedIds = new Set();
    existing.forEach(s => {
        const key = `${s.type}|${s.departure_time || ''}|${s.departure_airport || ''}`;
        if (incomingKeys.has(key)) matchedIds.add(s.id);
    });

    const staleIds = existing
        .filter(s => !matchedIds.has(s.id) && (s.departure_time || '') >= nowIso)
        .map(s => s.id);

    if (staleIds.length > 0) {
        const placeholders = staleIds.map(() => '?').join(',');
        await new Promise((resolve, reject) => {
            db.run(`DELETE FROM segments WHERE id IN (${placeholders})`, staleIds, err => {
                if (err) return reject(err); resolve();
            });
        });
    }

    if (events.length === 0) return { success: true, segmentsAdded: 0 };

    await Promise.all(events.map(ev => new Promise((resolve, reject) => {
        const key = `${ev.type}|${ev.departureTime || ''}|${ev.departureAirport || ''}`;
        const existingId = existingMap[key];
        if (existingId) {
            db.run(
                `UPDATE segments SET arrival_time=?, arrival_airport=?, tail=?, trip=?, flight_number=?, is_dh=?, block_minutes=? WHERE id=?`,
                [ev.arrivalTime||null, ev.arrivalAirport||null, ev.tail||null, ev.trip||null, ev.flightNumber||null, ev.dh?1:0, null, existingId],
                err => { if (err) return reject(err); resolve(); }
            );
        } else {
            db.run(
                `INSERT INTO segments (pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, block_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [pilot.id, ev.type, ev.departureTime||null, ev.arrivalTime||null, ev.departureAirport||null, ev.arrivalAirport||null, ev.tail||null, ev.trip||null, ev.flightNumber||null, ev.dh?1:0, null],
                err => { if (err) return reject(err); resolve(); }
            );
        }
    })));

    return { success: true, segmentsAdded: events.length };
}

// ICS sync endpoint — saves URL then delegates to syncPilotICS
app.post('/api/pilots/:pilotKey/sync-ics', async (req, res) => {
    const { pilotKey } = req.params;
    if (pilotKey === 'admin') return res.status(403).json({ error: 'Not allowed' });
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const db = getDB();
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        [`${pilotKey}_ics_url`, JSON.stringify({ url })]);

    try {
        const result = await syncPilotICS(pilotKey, url);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET stored ICS URL for a pilot
app.get('/api/pilots/:pilotKey/ics-url', (req, res) => {
    const { pilotKey } = req.params;
    const db = getDB();
    db.get(`SELECT value FROM settings WHERE key=?`, [`${pilotKey}_ics_url`], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const data = row ? JSON.parse(row.value) : null;
        res.json({ url: data?.url || null });
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

// Company crew lookup — returns captain for a given date where Kyle is SIC
// Fetches the Schedaero daily calendar using stored credentials and parses
// <BottomLeft>CAPT/KDK</BottomLeft> crew assignments.
app.get('/api/kyle/company-crew', async (req, res) => {
    const { date } = req.query; // YYYY-MM-DD
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    const db = getDB();
    db.get(`SELECT value FROM settings WHERE key='schedaero-creds'`, async (err, row) => {
        if (err || !row) return res.status(400).json({ error: 'No Schedaero credentials saved' });
        let creds;
        try { creds = JSON.parse(row.value); } catch { return res.status(500).json({ error: 'Corrupt credentials' }); }
        if (!creds.cookie || !creds.url) return res.status(400).json({ error: 'Incomplete credentials' });
        const baseUrl = creds.url.split('?')[0]; // strip any existing query params
        const calUrl = `${baseUrl}/${date}?ajax=true&_=${Date.now()}`;
        const origin = new URL(creds.url).origin;
        const csrfMatch = creds.cookie.match(/(?:^|;\s*)(?:__Host-)?AviCSRF=([^;]+)/);
        const csrf = csrfMatch ? csrfMatch[1].trim() : null;
        const headers = {
            'Cookie': creds.cookie,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `${origin}/`,
        };
        if (csrf)          headers['X-AviCSRF'] = csrf;
        if (creds.apiToken) headers['X-Avinode-ApiToken'] = creds.apiToken;
        try {
            const response = await fetch(calUrl, { headers });
            if (!response.ok) {
                return res.status(response.status).json({ error: `Schedaero returned ${response.status}`, sessionExpired: response.status === 302 || response.status === 401 });
            }
            const text = await response.text();
            const CREW = {
                HSB: 'Hans Brosbol', TJB: 'Thomas Bressie', MEV: 'Martin Valla',
                JAL: 'Lonnie Legner', AJB: 'Aleks Biteman', TAJ: 'Tyler Johnson',
                LWK: 'Luke Knudsvig', GWM: 'Greg Medsker',
            };
            const assignments = [];
            const re = /<BottomLeft>([^<]*)<\/BottomLeft>/gi;
            let m;
            while ((m = re.exec(text)) !== null) {
                const crew = m[1].trim();
                if (!crew) continue;
                const parts = crew.split('/');
                if (parts.length >= 2 && parts[1].trim().toUpperCase() === 'KDK') {
                    const captInit = parts[0].trim().toUpperCase();
                    assignments.push({ captainInitials: captInit, captainName: CREW[captInit] || null, raw: crew });
                }
            }
            res.json({ date, assignments });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
});

// Live flight tracking — position + accumulated trail
const _liveCache = {};
const LIVE_TTL = 5000; // 5s cache; client polls every 8s

const _posTrail = {};  // hex → [[lat, lon, tsMs], ...]
const _trailLastTime = {}; // hex → Date.now() of last appended trail point
const _trailSeeded = new Set(); // hexes whose adsb.lol/OpenSky history has been fetched
const _trailSeedTime = {}; // hex → timestamp of last adsb.lol fetch
const _trailSeedPromise = {}; // hex → in-flight seed Promise (so API endpoint can await first seed)
const TRAIL_RESEED_MS = 90 * 1000; // re-fetch adsb.lol trace every 90 s (CDN updates ~1–2 min)

// Trail persistence — survives server restarts so the full flight path accumulates
const TRAIL_CACHE_FILE = path.join(__dirname, '.trail_cache.json');

function loadTrailCache() {
    try {
        const data = JSON.parse(fs.readFileSync(TRAIL_CACHE_FILE, 'utf8'));
        const cutoff = Date.now() - 24 * 60 * 60 * 1000; // drop entries older than 24h
        for (const [hex, entry] of Object.entries(data)) {
            if (entry.ts > cutoff && Array.isArray(entry.coords) && entry.coords.length >= 2) {
                _posTrail[hex] = entry.coords;
                // Trail coords prove this aircraft was airborne — parked detection can fire immediately on next ground reading
                _flightState[hex] = { hasBeenAirborne: true, groundStillCount: 0 };
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

function seedTrailFromOpenSky(hex, sinceUnixSec = null) {
    const now = Date.now();
    const alreadySeeded = _trailSeeded.has(hex);
    const lastSeed = _trailSeedTime[hex] || 0;
    // If rate-limited, return the in-flight promise (if any) so callers can await current seed
    if (alreadySeeded && (now - lastSeed) < TRAIL_RESEED_MS) return _trailSeedPromise[hex] || Promise.resolve();
    const wasSeeded = alreadySeeded; // capture before mutating set
    _trailSeeded.add(hex);
    _trailSeedTime[hex] = now;
    const promise = _doSeedTrail(hex, sinceUnixSec, wasSeeded);
    _trailSeedPromise[hex] = promise;
    promise.finally(() => { if (_trailSeedPromise[hex] === promise) delete _trailSeedPromise[hex]; });
    return promise;
}

async function _doSeedTrail(hex, sinceUnixSec, alreadySeeded) {
    try {
        let coords = null; // will be [lat, lon, tsMs] triples

        // On re-seeds prefer trace_recent (smaller, updates faster on adsb.lol CDN).
        // On first seed prefer trace_full (complete leg history from departure).
        const zz = hex.slice(-2).toLowerCase();
        const h  = hex.toLowerCase();
        const traceUrls = alreadySeeded
            ? [`https://globe.adsb.lol/data/traces/${zz}/trace_recent_${h}.json`,
               `https://globe.adsb.lol/data/traces/${zz}/trace_full_${h}.json`]
            : [`https://globe.adsb.lol/data/traces/${zz}/trace_full_${h}.json`,
               `https://globe.adsb.lol/data/traces/${zz}/trace_recent_${h}.json`];

        for (const traceUrl of traceUrls) {
            if (coords) break;
            try {
                const tr = await fetch(traceUrl, { signal: AbortSignal.timeout(5000) });
                if (!tr.ok) continue;
                const tj = await tr.json();
                if (tj?.trace && tj.trace.length >= 2) {
                    const baseTs = tj.timestamp || 0; // UNIX seconds of trace epoch
                    // Only filter by time if baseTs looks like a real epoch (post-2001)
                    const cutoffSec = (sinceUnixSec && baseTs > 1000000000) ? sinceUnixSec - 15 * 60 : null;
                    const pts = tj.trace
                        .filter(p => p[1] != null && p[2] != null &&
                                     (!cutoffSec || (baseTs + p[0]) >= cutoffSec))
                        .map(p => [p[1], p[2], (baseTs + p[0]) * 1000]); // [lat, lon, tsMs]
                    if (pts.length >= 2) {
                        coords = pts;
                        const src = traceUrl.includes('recent') ? 'trace_recent' : 'trace_full';
                        console.log(`${alreadySeeded ? 'Refreshed' : 'Seeded'} trail for ${hex}: ${coords.length} pts (${src}${cutoffSec ? ', since dep' : ''})`);
                    }
                }
            } catch (_) {}
        }

        // Fall back to OpenSky on first seed only
        if (!coords && !alreadySeeded) {
            const osUser = process.env.OPENSKY_USER, osPass = process.env.OPENSKY_PASS;
            const headers = osUser ? { Authorization: 'Basic ' + Buffer.from(`${osUser}:${osPass}`).toString('base64') } : {};
            const resp = await fetch(`https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`,
                { headers, signal: AbortSignal.timeout(10000) });
            if (resp.ok) {
                const json = await resp.json();
                const path = json?.path;
                if (path && path.length >= 2) {
                    const raw = path.filter(p => p[1] != null && p[2] != null && !p[5])
                                    .map(p => [p[1], p[2], p[0] * 1000]); // p[0] is UNIX s
                    if (raw.length >= 2) { coords = raw; console.log(`Seeded trail for ${hex}: ${coords.length} OpenSky pts`); }
                }
            }
        }

        if (!coords) { if (!alreadySeeded) _trailSeeded.delete(hex); return; }

        // Merge adsb.lol points with ALL local polling points chronologically.
        // Previously we only kept local points newer than the last adsb.lol timestamp,
        // which discarded locally-polled points that filled adsb.lol coverage gaps mid-flight.
        const existing = _posTrail[hex] || [];
        const combined = [...coords, ...existing];
        combined.sort((a, b) => (a[2] || 0) - (b[2] || 0));
        // Deduplicate: drop any point within 4s of the previous one (adsb.lol preferred since coords comes first)
        const merged = [combined[0]];
        for (let i = 1; i < combined.length; i++) {
            if ((combined[i][2] || 0) - (merged[merged.length - 1][2] || 0) >= 4000) {
                merged.push(combined[i]);
            }
        }

        const currentLen = existing.length;
        if (merged.length > currentLen) {
            _posTrail[hex] = merged;
            if (_posTrail[hex].length > 4000) _posTrail[hex].splice(0, _posTrail[hex].length - 4000);
            scheduleTrailSave();
        }
    } catch (e) {
        if (!alreadySeeded) _trailSeeded.delete(hex);
        console.warn(`Trail seed error for ${hex}:`, e.message);
    }
}

// Per-hex flight phase tracking for parked detection
const _flightState = {}; // hex → { hasBeenAirborne, groundStillCount }
const _callsignToHex = {}; // callsign → last-known hex (survives cache expiry)
const _parkedCallsigns = new Set(); // suppress background polling after flight completes
const _earlyLandings = {}; // date (YYYY-MM-DD) → Set<callsign> — flights that landed before scheduled arrival

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
function processPositionUpdate(data, sinceUnixSec = null) {
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
        seedTrailFromOpenSky(hex, sinceUnixSec); // async, fire-and-forget — rate-limited to TRAIL_RESEED_MS
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
            trail.push([data.lat, data.lon, now]); // [lat, lon, tsMs]
            _trailLastTime[hex] = now;
            if (trail.length > 3000) trail.splice(0, trail.length - 3000);
            scheduleTrailSave();
        }
        data.trail = [...trail];
    }
    // Tell the client whether this aircraft has ever been airborne this session.
    // Needed so a fresh map load while the plane is taxiing post-landing can still
    // remove the planned-route arc and show correct state.
    if (_flightState[data.hex]) data.hasBeenAirborne = _flightState[data.hex].hasBeenAirborne;
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

app.post('/api/early-landing', express.json(), (req, res) => {
    const { callsign, date } = req.body || {};
    if (!callsign || !date) return res.status(400).json({ error: 'missing fields' });
    const cs = callsign.toUpperCase().trim();
    if (!_earlyLandings[date]) _earlyLandings[date] = new Set();
    _earlyLandings[date].add(cs);
    res.json({ ok: true });
});

app.get('/api/early-landings', (req, res) => {
    const { date } = req.query;
    if (!date) return res.json({ callsigns: [] });
    const set = _earlyLandings[date];
    res.json({ callsigns: set ? [...set] : [] });
});

app.get('/api/live-position', async (req, res) => {
    const callsign = (req.query.callsign || '').toUpperCase().replace(/\s/g, '');
    if (!callsign) return res.json({ found: false });
    // Optional: scheduled departure time (Unix seconds) used to filter trail to current leg only
    const sinceUnixSec = req.query.depTime ? parseInt(req.query.depTime, 10) : null;

    // If the server already confirmed this callsign parked, tell the client immediately
    // so it can clean up even if the scheduled arrival time hasn't passed yet.
    if (_parkedCallsigns.has(callsign)) return res.json({ found: false, parked: true });

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

    processPositionUpdate(data, sinceUnixSec);

    // If the trail is empty (first contact while airborne), await the adsb.lol seed before
    // responding so the client gets trail data on the very first map load, not the second.
    const _hex = data.hex;
    if (_hex && data.found && !data.onGround && (!data.trail || data.trail.length < 2)) {
        await (_trailSeedPromise[_hex] || Promise.resolve());
        if (_posTrail[_hex]?.length >= 2) data.trail = [..._posTrail[_hex]];
    }

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
                const depUnixSec = row.departure_time ? Math.floor(new Date(row.departure_time).getTime() / 1000) : null;
                try {
                    const data = await fetchAdsbPosition(callsign);
                    processPositionUpdate(data, depUnixSec);
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

// App version — reads from package.json so only one place to update
app.get('/api/version', (req, res) => {
    res.json({ version: require('./package.json').version });
});

// ── Page routes ────────────────────────────────────────────────────────
const ROSTER_LOGIN_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CrewSync · Roster</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/icon.svg" type="image/svg+xml"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px 28px;width:100%;max-width:340px}h2{margin:0 0 24px;font-size:18px;font-weight:700;text-align:center}input{width:100%;padding:10px 14px;background:#09090b;border:1px solid #3f3f46;border-radius:8px;color:#e4e4e7;font-size:15px;outline:none;margin-bottom:12px}input:focus{border-color:#6366f1}button{width:100%;padding:11px;background:#6366f1;border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}button:hover{background:#4f46e5}.err{color:#f87171;font-size:13px;text-align:center;margin-bottom:10px;display:none}</style></head><body><div class="card"><h2>CrewSync</h2><form method="POST" action="/crew-roster/login"><p class="err" id="e">Incorrect password</p><input type="password" name="password" placeholder="Password" autofocus><button type="submit">Sign In</button></form></div><script>if(location.search.includes('err'))document.getElementById('e').style.display='block'</script></body></html>`;

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

// Add viewer from crew-roster page (form POST, no JS required)
app.post('/crew-roster/add-viewer', rosterAuth, express.urlencoded({ extended: false }), (req, res) => {
    const { firstName, lastName } = req.body;
    if (!firstName || !firstName.trim()) return res.redirect('/crew-roster?err=name');
    const db = getDB();
    const name = lastName && lastName.trim() ? `${firstName.trim()} ${lastName.trim()}` : firstName.trim();
    const baseKey = firstName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const token = generateToken();
    const tryInsert = (key, attempt) => {
        const finalKey = attempt === 0 ? key : `${key}${attempt}`;
        db.run(
            `INSERT INTO pilots (pilot_key, name, role, parser_type, token) VALUES (?, ?, 'viewer', 'none', ?)`,
            [finalKey, name, token],
            function(err) {
                if (err && err.message.includes('UNIQUE')) return tryInsert(key, attempt + 1);
                if (err) return res.redirect('/crew-roster?err=db');
                res.redirect(`/crew-roster?added=${encodeURIComponent(token)}`);
            }
        );
    };
    tryInsert(baseKey, 0);
});

// DB download — password-protected, for local dev sync
app.get('/admin/download-db', rosterAuth, (req, res) => {
    res.download(path.join(__dirname, 'dispatch.db'), 'dispatch.db');
});

// Admin user list — password-protected HTML page
app.get('/crew-roster', rosterAuth, (req, res) => {
    const db = getDB();
    const addedToken = req.query.added || '';
    const addErr     = req.query.err   || '';
    db.all(`SELECT pilot_key, name, base, home_airport, role, token, last_active FROM pilots ORDER BY pilot_key='admin' DESC, name`, (err, rows) => {
        if (err) return res.status(500).send(err.message);
        const host   = req.headers.host || `localhost:${PORT}`;
        const proto  = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const origin = `${proto}://${host}`;
        const fmtActive = (iso) => {
            if (!iso) return 'Never';
            const diff = Date.now() - new Date(iso).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 2)   return 'Just now';
            if (mins < 60)  return `${mins}m ago`;
            const hrs = Math.floor(mins / 60);
            if (hrs < 24)   return `${hrs}h ago`;
            const days = Math.floor(hrs / 24);
            const dateStr = new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (days < 7)   return `${days}d ago · ${dateStr}`;
            return dateStr;
        };
        const activeColor = (iso) => {
            if (!iso) return '#52525b';
            const hrs = (Date.now() - new Date(iso).getTime()) / 3600000;
            if (hrs < 1)   return '#22c55e';  // green   — within 1h
            if (hrs < 24)  return '#84cc16';  // lime    — same day
            if (hrs < 72)  return '#eab308';  // yellow  — 1–3 days
            if (hrs < 168) return '#f97316';  // orange  — 3–7 days
            return '#ef4444';                  // red     — over a week
        };
        const cards = rows.map(r => {
            const link = `${origin}/app?u=${r.token}`;
            const isViewer = r.role === 'viewer';
            const initials = isViewer ? '👁' : r.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const avatarBg = isViewer ? '#064e3b' : '#1e3a5f';
            const avatarColor = isViewer ? '#34d399' : '#60a5fa';
            const sub = isViewer
                ? `${r.pilot_key} · View only`
                : [r.pilot_key, r.base && `base ${r.base}`, r.home_airport && r.home_airport !== r.base && `home ${r.home_airport}`].filter(Boolean).join(' · ');
            const activeStr = fmtActive(r.last_active);
            const dotColor = activeColor(r.last_active);
            const cardBorder = isViewer ? '#166534' : '#27272a';
            return `<div style="background:#111113;border:1px solid ${cardBorder};border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px">
  <div style="display:flex;align-items:center;gap:12px">
    <div style="width:40px;height:40px;border-radius:10px;background:${avatarBg};color:${avatarColor};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${isViewer?'18':'13'}px;flex-shrink:0">${initials}</div>
    <div style="flex:1">
      <div style="font-weight:800;font-size:15px;color:#fff">${r.name}</div>
      <div style="font-size:11px;color:#52525b;font-weight:600;margin-top:2px">${sub}</div>
    </div>
    <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
      <div style="width:7px;height:7px;border-radius:50%;background:${dotColor}"></div>
      <span style="font-size:11px;color:${dotColor};white-space:nowrap;font-weight:700">${activeStr}</span>
    </div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;background:#09090b;border:1px solid #1c1c1f;border-radius:8px;padding:8px 10px">
    <span style="flex:1;font-size:11px;color:#71717a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace">${link}</span>
    <button onclick="copyText('${link}',this)" style="flex-shrink:0;background:#1d4ed8;border:none;color:#fff;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em">Copy</button>
    <a href="${link}" target="_blank" style="flex-shrink:0;background:#18181b;color:#a1a1aa;border:1px solid #27272a;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;text-decoration:none">Open</a>
  </div>
</div>`;
        }).join('');
        res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>CrewSync · Roster</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#e4e4e7;min-height:100vh;padding:2rem 1rem}
.wrap{max-width:640px;margin:0 auto}
.header{display:flex;align-items:center;gap:8px;margin-bottom:1.5rem}
.logo{font-size:1.1rem;font-weight:900;color:#3b82f6;text-transform:uppercase;letter-spacing:.05em;font-style:italic}
.header-sub{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#52525b;margin-top:2px}
.cards{display:flex;flex-direction:column;gap:10px}
.add-viewer{margin-top:2rem;padding:16px;background:#052e16;border:1px solid #166534;border-radius:14px}
.add-viewer-label{font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#34d399;margin-bottom:5px}
.add-viewer-desc{font-size:.75rem;color:#6ee7b7;margin-bottom:12px;line-height:1.45}
.add-viewer-row{display:flex;gap:8px;flex-wrap:wrap}
.add-viewer-input{flex:1;min-width:110px;padding:8px 12px;background:#09090b;border:1px solid #166534;border-radius:8px;color:#e4e4e7;font-size:.85rem;outline:none}
.add-viewer-input:focus{border-color:#34d399}
.btn-add{padding:8px 16px;background:#166534;border:none;color:#34d399;border-radius:8px;font-size:.8rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;white-space:nowrap}
.btn-add:hover{background:#15803d}
#v-result{margin-top:10px;font-size:.75rem;color:#34d399;display:none;line-height:1.4}
</style>
</head><body>
<div class="wrap">
  <div class="header">
    <img src="/icon.svg" width="36" height="36" style="border-radius:9px;flex-shrink:0" alt="">
    <div><div class="logo">CrewSync</div><div class="header-sub">Crew Roster</div></div>
  </div>
  <div class="cards">${cards}</div>
  <div class="add-viewer">
    <div class="add-viewer-label">Add View-Only Guest</div>
    <p class="add-viewer-desc">View-only guests can see all crew schedules but cannot upload, edit, or add flights. They get their own "Your Crew" filter to choose who they follow.</p>
    ${addErr ? `<p style="color:#f87171;font-size:.8rem;margin-bottom:8px">Error adding viewer — try again.</p>` : ''}
    ${addedToken ? `<div style="margin-bottom:12px;padding:10px 12px;background:#052e16;border:1px solid #16a34a;border-radius:8px;font-size:.8rem;color:#34d399">
      Viewer added! Link: <strong style="color:#fff;word-break:break-all">${origin}/app?u=${addedToken}</strong>
      <button onclick="copyText('${origin}/app?u=${addedToken}',this)" style="display:block;margin-top:6px;background:#166534;border:none;color:#34d399;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:.75rem;font-weight:800">Copy Link</button>
    </div>` : ''}
    <form method="POST" action="/crew-roster/add-viewer" class="add-viewer-row">
      <input name="firstName" placeholder="First name" class="add-viewer-input" required>
      <input name="lastName" placeholder="Last name (optional)" class="add-viewer-input">
      <button type="submit" class="btn-add">Add Viewer</button>
    </form>
  </div>
</div>
<script>
function copyText(t,btn){
  var prev=btn.textContent;
  if(navigator.clipboard&&location.protocol==='https:'){
    navigator.clipboard.writeText(t).then(()=>{btn.textContent='✓ Copied';setTimeout(()=>btn.textContent=prev,1800);});
  } else {
    var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');btn.textContent='✓ Copied';setTimeout(()=>btn.textContent=prev,1800);}catch(e){}
    document.body.removeChild(ta);
  }
}
</script>
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
                const isViewer = u.role === 'viewer';
                const sub = isViewer
                    ? `${u.pilot_key} · View only`
                    : [u.base, u.home_airport && u.home_airport !== u.base ? `home ${u.home_airport}` : null, u.role].filter(Boolean).join(' · ');
                const avatarBg = isViewer ? '#064e3b' : '#1e3a5f';
                const avatarColor = isViewer ? '#34d399' : '#60a5fa';
                return `<div class="card">
  <div class="card-header">
    <div class="avatar" style="background:${avatarBg};color:${avatarColor}">${isViewer ? '👁' : initials}</div>
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
<link rel="icon" href="/icon.svg" type="image/svg+xml">
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
.my-link{margin-top:1.5rem;padding:14px 16px;background:#111113;border:1px solid #27272a;border-radius:12px}
.my-link-label{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#3f3f46;margin-bottom:6px}
.my-link-box{display:flex;gap:8px;align-items:center}
.my-link-url{flex:1;font-family:ui-monospace,monospace;font-size:.65rem;color:#3f3f46;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.add-viewer{margin-top:2.5rem;padding:16px;background:#052e16;border:1px solid #166534;border-radius:12px}
.add-viewer-label{font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#34d399;margin-bottom:6px}
.add-viewer-desc{font-size:.75rem;color:#6ee7b7;margin-bottom:12px;line-height:1.4}
.add-viewer-row{display:flex;gap:8px;flex-wrap:wrap}
.add-viewer-input{flex:1;min-width:120px;padding:8px 12px;background:#09090b;border:1px solid #166534;border-radius:8px;color:#e4e4e7;font-size:.85rem;outline:none}
.add-viewer-input:focus{border-color:#34d399}
.btn-add-viewer{padding:8px 16px;background:#166534;border:none;color:#34d399;border-radius:8px;font-size:.8rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;white-space:nowrap}
.btn-add-viewer:hover{background:#15803d}
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
  <div class="add-viewer">
    <div class="add-viewer-label">Add View-Only Guest</div>
    <p class="add-viewer-desc">View-only guests can see all crew schedules but cannot upload, edit, or add flights. They get their own "Your Crew" filter.</p>
    <div class="add-viewer-row">
      <input id="v-first" placeholder="First name" class="add-viewer-input">
      <input id="v-last" placeholder="Last name" class="add-viewer-input">
      <button onclick="addViewer()" class="btn-add-viewer">Add Viewer</button>
    </div>
    <div id="v-result" style="margin-top:10px;font-size:.75rem;color:#34d399;display:none"></div>
  </div>
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
async function addViewer(){
  const first=document.getElementById('v-first').value.trim();
  const last=document.getElementById('v-last').value.trim();
  const el=document.getElementById('v-result');
  el.style.display='block';
  if(!first){el.style.color='#f87171';el.textContent='Enter at least a first name.';return;}
  el.style.color='#a1a1aa';el.textContent='Creating…';
  try{
    const res=await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({firstName:first,lastName:last||'',role:'viewer',parserType:'none'})});
    const data=await res.json();
    if(!data.success){el.style.color='#f87171';el.textContent='Error: '+(data.error||'Unknown');return;}
    const link=location.origin+data.link;
    el.style.color='#34d399';
    el.innerHTML='Link created — <strong style="color:#fff">'+link+'</strong> &nbsp;<button onclick="copyText(\''+link+'\',this)" style="background:#27272a;border:none;color:#e4e4e7;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:.7rem">Copy</button>';
    document.getElementById('v-first').value='';
    document.getElementById('v-last').value='';
    setTimeout(()=>location.reload(),4000);
  }catch(e){el.style.color='#f87171';el.textContent='Network error — try again.';}
}
</script>
</body></html>`);
        });
    });
});

// Landing page at root (unauthenticated entry point)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// ── Web Push (VAPID) ────────────────────────────────────────────────────────
let webpush = null;
try {
    webpush = require('web-push');
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'mailto:admin@crewsync.app',
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );
    } else {
        console.warn('[Push] VAPID keys not set in .env — push notifications disabled');
        webpush = null;
    }
} catch (e) {
    console.warn('[Push] web-push not available:', e.message);
}

function pushToAll(pilotKey, payload) {
    if (!webpush) return;
    const db = getDB();
    db.all('SELECT endpoint, subscription_json FROM push_subscriptions WHERE pilot_key=?', [pilotKey], (err, subs) => {
        if (err || !subs?.length) return;
        const str = JSON.stringify(payload);
        subs.forEach(row => {
            try {
                webpush.sendNotification(JSON.parse(row.subscription_json), str).catch(e => {
                    if (e.statusCode === 410 || e.statusCode === 404) {
                        db.run('DELETE FROM push_subscriptions WHERE endpoint=?', [row.endpoint]);
                    }
                });
            } catch (_) {}
        });
    });
}

// GET VAPID public key (needed by frontend to subscribe)
app.get('/api/push/vapid-key', (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST save a device's push subscription
app.post('/api/push/subscribe', (req, res) => {
    const db = getDB();
    const { token, subscription } = req.body;
    if (!token || !subscription?.endpoint) return res.status(400).json({ error: 'Missing token or subscription' });
    db.get('SELECT pilot_key FROM pilots WHERE token=?', [token], (err, pilot) => {
        if (err || !pilot) return res.status(401).json({ error: 'Invalid token' });
        db.run(
            `INSERT INTO push_subscriptions (pilot_key, endpoint, subscription_json) VALUES (?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json, pilot_key=excluded.pilot_key`,
            [pilot.pilot_key, subscription.endpoint, JSON.stringify(subscription)],
            err2 => err2 ? res.status(500).json({ error: err2.message }) : res.json({ ok: true })
        );
    });
});

// DELETE remove a push subscription (user turned off notifications)
app.delete('/api/push/subscribe', (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    getDB().run('DELETE FROM push_subscriptions WHERE endpoint=?', [endpoint], () => res.json({ ok: true }));
});

// GET notifications for the authed pilot
app.get('/api/notifications', (req, res) => {
    const db = getDB();
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'No token' });
    db.get('SELECT pilot_key FROM pilots WHERE token=?', [token], (err, pilot) => {
        if (err || !pilot) return res.status(401).json({ error: 'Invalid token' });
        db.all(
            'SELECT id, title, body, url, is_read, created_at FROM notifications WHERE pilot_key=? ORDER BY created_at DESC LIMIT 50',
            [pilot.pilot_key],
            (err2, rows) => err2 ? res.status(500).json({ error: err2.message }) : res.json(rows || [])
        );
    });
});

// PATCH mark all notifications read for the authed pilot
app.patch('/api/notifications/read', (req, res) => {
    const db = getDB();
    const token = req.body.token;
    if (!token) return res.status(401).json({ error: 'No token' });
    db.get('SELECT pilot_key FROM pilots WHERE token=?', [token], (err, pilot) => {
        if (err || !pilot) return res.status(401).json({ error: 'Invalid token' });
        db.run('UPDATE notifications SET is_read=1 WHERE pilot_key=?', [pilot.pilot_key], () => {
            res.json({ ok: true });
            // Clear app badge via next push — badge resets when user opens the app (handled client-side)
        });
    });
});

// POST broadcast crossing notifications (called by frontend after schedule upload)
// crossings: [{ kA, kB, airport, directStart, title, body }]
app.post('/api/notifications/crossing', (req, res) => {
    const db = getDB();
    const { token, crossings } = req.body;
    if (!token || !Array.isArray(crossings)) return res.status(400).json({ error: 'Missing params' });
    db.get('SELECT pilot_key FROM pilots WHERE token=?', [token], (err, sender) => {
        if (err || !sender) return res.status(401).json({ error: 'Invalid token' });
        res.json({ ok: true }); // respond immediately, push in background
        crossings.forEach(c => {
            const key = [c.kA, c.kB, c.airport, (c.directStart || '').slice(0, 10)].sort().join('|');
            [c.kA, c.kB].forEach(pilotKey => {
                db.run(
                    `INSERT OR IGNORE INTO notifications (pilot_key, title, body, url, crossing_key) VALUES (?, ?, ?, '/app?view=overlap', ?)`,
                    [pilotKey, c.title, c.body, key],
                    function() {
                        if (this.changes === 0) return; // duplicate — already notified
                        db.get('SELECT COUNT(*) as cnt FROM notifications WHERE pilot_key=? AND is_read=0', [pilotKey], (__, row) => {
                            pushToAll(pilotKey, { title: c.title, body: c.body, url: '/app?view=overlap', tag: key, unreadCount: row?.cnt || 1 });
                        });
                    }
                );
            });
        });
    });
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

// Manual / wiki — public, no auth required
app.get('/manual', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manual.html'));
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
    db.get(`SELECT pilot_key, name, base, role FROM pilots WHERE token=?`, [token], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Invalid token' });
        db.run(`UPDATE pilots SET last_active=? WHERE token=?`, [new Date().toISOString(), token]);
        res.json({ pilotKey: row.pilot_key, name: row.name, base: row.base, isViewer: row.role === 'viewer' });
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
    if (!firstName) return res.status(400).json({ error: 'Name required' });

    const db = getDB();
    const name = lastName ? `${firstName.trim()} ${lastName.trim()}` : firstName.trim();
    // Derive a unique pilot_key from first name, add number suffix if collision
    const baseKey = firstName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const token = generateToken();
    const safeRole    = (role || '').trim();
    const safeParser  = (parserType || 'other').trim();
    const safeCode    = (airlineCode || '').trim().toUpperCase();
    const safeHome    = (homeAirport || '').toUpperCase().trim();

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

// ── Crew Intel ────────────────────────────────────────────────────────────────
app.get('/api/intel', (req, res) => {
    const db = getDB();
    const { airport } = req.query;
    const sql = airport
        ? `SELECT ci.*, p.name AS added_by_name FROM crew_intel ci LEFT JOIN pilots p ON p.pilot_key=ci.added_by WHERE ci.airport_code=? ORDER BY ci.category, ci.created_at DESC`
        : `SELECT ci.*, p.name AS added_by_name FROM crew_intel ci LEFT JOIN pilots p ON p.pilot_key=ci.added_by ORDER BY ci.airport_code, ci.category, ci.created_at DESC`;
    const params = airport ? [airport.toUpperCase()] : [];
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Resolve a token to any authenticated pilot row (viewers included), or return 401
function _resolveIntelAuthor(token, db, cb) {
    if (!token) return cb(401, 'Authentication required');
    db.get(`SELECT pilot_key, role FROM pilots WHERE token=?`, [token], (err, row) => {
        if (err) return cb(500, err.message);
        if (!row) return cb(401, 'Invalid token');
        cb(null, null, row.pilot_key);
    });
}

app.post('/api/intel', (req, res) => {
    const db = getDB();
    const { airport_code, category, title, body, token } = req.body;
    if (!airport_code || !category || !title)
        return res.status(400).json({ error: 'Missing required fields' });
    _resolveIntelAuthor(token, db, (status, msg, authorKey) => {
        if (status) return res.status(status).json({ error: msg });
        db.run(
            `INSERT INTO crew_intel (airport_code, category, title, body, added_by) VALUES (?,?,?,?,?)`,
            [airport_code.toUpperCase(), category, title, body || '', authorKey],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                logEvent(authorKey === 'admin' ? null : authorKey, 'intel:add');
                db.get(`SELECT * FROM crew_intel WHERE id=?`, [this.lastID], (e, row) => res.json(row || {}));
            }
        );
    });
});

app.put('/api/intel/:id', (req, res) => {
    const db = getDB();
    const { category, title, body, airport_code, token } = req.body;
    _resolveIntelAuthor(token, db, (status, msg, authorKey) => {
        if (status) return res.status(status).json({ error: msg });
        const isAdmin = authorKey === 'admin';
        const sql = isAdmin
            ? `UPDATE crew_intel SET airport_code=?, category=?, title=?, body=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
            : `UPDATE crew_intel SET airport_code=?, category=?, title=?, body=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND added_by=?`;
        const params = isAdmin
            ? [airport_code?.toUpperCase() || '', category, title, body || '', req.params.id]
            : [airport_code?.toUpperCase() || '', category, title, body || '', req.params.id, authorKey];
        db.run(sql, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(403).json({ error: 'Not authorized' });
            res.json({ success: true });
        });
    });
});

app.delete('/api/intel/:id', (req, res) => {
    const db = getDB();
    const { token } = req.body;
    _resolveIntelAuthor(token, db, (status, msg, authorKey) => {
        if (status) return res.status(status).json({ error: msg });
        const isAdmin = authorKey === 'admin';
        const sql = isAdmin ? `DELETE FROM crew_intel WHERE id=?` : `DELETE FROM crew_intel WHERE id=? AND added_by=?`;
        const params = isAdmin ? [req.params.id] : [req.params.id, authorKey];
        db.run(sql, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(403).json({ error: 'Not authorized' });
            res.json({ success: true });
        });
    });
});

// Airport city batch lookup
app.get('/api/airports/cities', (req, res) => {
    const codes = (req.query.codes || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean).slice(0, 100);
    const result = {};
    codes.forEach(code => {
        const city = _airportCities[code] || _airportCities['K' + code] || null;
        if (city) result[code] = city;
    });
    res.json(result);
});

// Airport coordinate batch lookup — fills gaps when airports aren't in the client's airports.json.
// Uses _aptCoords built from airports.dat (ICAO codes like KSFO, KSTL are included).
app.get('/api/airports/coords', (req, res) => {
    const codes = (req.query.codes || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean).slice(0, 100);
    const result = {};
    codes.forEach(code => {
        // Try exact code, then K-prefix for 3-letter IATA, then last-3 only for non-K/C ICAO codes
        const coords = _aptCoords[code]
            || (code.length === 3 ? _aptCoords['K' + code] : null)
            || (code.length === 4 && code[0] !== 'K' && code[0] !== 'C' ? _aptCoords[code.slice(1)] : null);
        if (coords) result[code] = coords; // [lat, lon]
    });
    res.json(result);
});

// Analytics event ingestion
app.post('/api/analytics', (req, res) => {
    const { pilot_key, event } = req.body;
    if (!pilot_key || !event) return res.status(400).json({ error: 'Missing fields' });
    const db = getDB();
    db.run('INSERT INTO usage_events (pilot_key, event) VALUES (?, ?)', [pilot_key, event], err => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// Internal helper — log an event server-side (fire and forget)
function logEvent(pilotKey, event) {
    if (!pilotKey || pilotKey === 'admin') return;
    const db = getDB();
    db.run('INSERT INTO usage_events (pilot_key, event) VALUES (?, ?)', [pilotKey, event], () => {});
}

// Admin dashboard stats
app.get('/api/admin/stats', (req, res) => {
    const db = getDB();
    const q  = (sql, p = []) => new Promise((ok, fail) => db.all(sql, p, (e, r) => e ? fail(e) : ok(r)));
    const q1 = (sql, p = []) => new Promise((ok, fail) => db.get(sql, p,  (e, r) => e ? fail(e) : ok(r)));

    Promise.all([
        // Segment counts by type
        q(`SELECT type, COUNT(*) as count FROM segments GROUP BY type ORDER BY count DESC`),
        // Total non-admin pilots
        q1(`SELECT COUNT(*) as count FROM pilots WHERE pilot_key != 'admin'`),
        // Pilots with at least one future flight
        q1(`SELECT COUNT(DISTINCT pilot_id) as count FROM segments WHERE type='flight' AND departure_time >= datetime('now')`),
        // Pilots who uploaded in last 30 days
        q1(`SELECT COUNT(DISTINCT pilot_id) as count FROM segments WHERE created_at >= datetime('now', '-30 days')`),
        // Schedule date range
        q1(`SELECT MIN(departure_time) as earliest, MAX(departure_time) as latest FROM segments WHERE type='flight'`),
        // Unique airports across all flight segments
        q1(`SELECT COUNT(DISTINCT departure_airport) as count FROM segments WHERE type='flight' AND departure_airport != ''`),
        // Top departure airports
        q(`SELECT departure_airport as airport, COUNT(*) as count FROM segments WHERE type='flight' AND departure_airport != '' GROUP BY departure_airport ORDER BY count DESC LIMIT 8`),
        // Manual entries
        q1(`SELECT COUNT(*) as count FROM segments WHERE is_manual = 1`),
        // Crew intel by category
        q(`SELECT category, COUNT(*) as count FROM crew_intel GROUP BY category ORDER BY count DESC`),
        // Pilots who contributed to crew intel
        q1(`SELECT COUNT(DISTINCT added_by) as count FROM crew_intel`),
        // Push subscriptions (distinct pilots)
        q1(`SELECT COUNT(DISTINCT pilot_key) as count FROM push_subscriptions`),
        // Total crossings found (notifications)
        q1(`SELECT COUNT(*) as count FROM notifications`),
        // Upload events last 8 weeks (one "upload" = distinct pilot+day in segments.created_at)
        q(`SELECT strftime('%Y-%W', d) as week, COUNT(*) as uploads FROM (SELECT pilot_id, date(created_at) as d FROM segments GROUP BY pilot_id, date(created_at)) GROUP BY week ORDER BY week DESC LIMIT 8`),
        // View usage — how often each view is opened (last 90 days)
        q(`SELECT event, COUNT(*) as count FROM usage_events WHERE event LIKE 'view:%' AND created_at >= datetime('now', '-90 days') GROUP BY event ORDER BY count DESC`),
        // Daily active usage (distinct pilots with any event per day, last 30 days)
        q(`SELECT date(created_at) as day, COUNT(DISTINCT pilot_key) as pilots FROM usage_events WHERE created_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day`),
        // Total app opens
        q1(`SELECT COUNT(*) as count FROM usage_events WHERE event = 'app:open'`),
        // Active pilots last 7 days
        q1(`SELECT COUNT(DISTINCT pilot_key) as count FROM usage_events WHERE created_at >= datetime('now', '-7 days')`),
    ]).then(([segsByType, totalPilots, pilotsWithFuture, recentUploaders, schedRange, uniqueAirports, topAirports, manualSegs, intelByCat, intelContribs, pushPilots, crossingsFound, weeklyUploads, viewUsage, dailyActive, totalOpens, activeLast7]) => {
        const totalSegs = segsByType.reduce((s, r) => s + r.count, 0);
        const intelTotal = intelByCat.reduce((s, r) => s + r.count, 0);
        res.json({
            pilots:         { total: totalPilots?.count || 0, withFutureSchedule: pilotsWithFuture?.count || 0, recentUploaders: recentUploaders?.count || 0, activeLast7: activeLast7?.count || 0 },
            segments:       { total: totalSegs, byType: segsByType, manual: manualSegs?.count || 0 },
            schedule:       { earliest: schedRange?.earliest, latest: schedRange?.latest, uniqueAirports: uniqueAirports?.count || 0 },
            topAirports,
            intel:          { total: intelTotal, byCategory: intelByCat, contributors: intelContribs?.count || 0 },
            push:           { pilots: pushPilots?.count || 0 },
            crossings:      { total: crossingsFound?.count || 0 },
            weeklyUploads:  weeklyUploads.reverse(),
            usage:          { viewCounts: viewUsage, dailyActive, totalOpens: totalOpens?.count || 0 },
        });
    }).catch(err => res.status(500).json({ error: err.message }));
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

// ── Auto-sync scheduler — runs 3x/day at 6 AM, 2 PM, and 10 PM UTC ────────────

async function autoSyncAllICS() {
    const db = getDB();
    const rows = await new Promise((resolve, reject) => {
        db.all(`SELECT key, value FROM settings WHERE key LIKE '%_ics_url'`, (err, rows) => {
            if (err) return reject(err); resolve(rows || []);
        });
    });
    for (const row of rows) {
        const pilotKey = row.key.replace(/_ics_url$/, '');
        if (pilotKey === 'admin') continue;
        try {
            const data = JSON.parse(row.value);
            const result = await syncPilotICS(pilotKey, data.url);
            console.log(`[auto-sync] ${pilotKey} (ICS): ${result.segmentsAdded} segments`);
        } catch (err) {
            console.error(`[auto-sync] ${pilotKey} (ICS) failed:`, err.message);
        }
    }
}

async function autoSyncKyleSchedaero() {
    const db = getDB();
    const row = await new Promise((resolve, reject) => {
        db.get(`SELECT value FROM settings WHERE key='schedaero-creds'`, (err, row) => {
            if (err) return reject(err); resolve(row);
        });
    });
    if (!row) return;
    const creds = JSON.parse(row.value);
    if (!creds.cookie || !creds.url || !creds.apiToken) return;
    const now = new Date();
    const back  = parseInt(creds.monthsBack)  || 0;
    const ahead = parseInt(creds.monthsAhead) || 3;
    const pilot = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM pilots WHERE pilot_key=?', ['kyle'], (err, row) => {
            if (err) return reject(err); resolve(row);
        });
    });
    if (!pilot) return;
    let totalAdded = 0;
    for (let i = -back; i < ahead; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        try {
            const events = await fetchSchedaeroMonth(creds.cookie, creds.url, creds.apiToken, d.getMonth() + 1, d.getFullYear());
            totalAdded += await importSchedaeroEvents(db, pilot.id, events, d.getMonth() + 1, d.getFullYear());
        } catch (e) {
            console.error(`[auto-sync] kyle (Schedaero) failed:`, e.message);
            return;
        }
    }
    console.log(`[auto-sync] kyle (Schedaero): ${totalAdded} segments`);
}

async function autoSyncAll() {
    console.log('[auto-sync] Starting scheduled sync…');
    await autoSyncAllICS();
    await autoSyncKyleSchedaero();
    console.log('[auto-sync] Done.');
}

// Schedule at 06:00, 14:00, 22:00 UTC daily
function scheduleNextSync() {
    const now = new Date();
    const fireHours = [6, 14, 22];
    const candidates = fireHours.map(h => {
        const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0, 0));
        if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
        return t;
    });
    const next = candidates.reduce((a, b) => a < b ? a : b);
    const delay = next - now;
    console.log(`[auto-sync] Next sync scheduled at ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`);
    setTimeout(() => { autoSyncAll(); scheduleNextSync(); }, delay);
}

scheduleNextSync();

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
