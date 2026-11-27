// Year in Review (Wrapped) stats for one pilot and one year. Pure: server.js passes in its airport
// helpers, computes every pilot with it, and turns the results into percentiles. One engine, so a
// pilot's numbers and where they rank always agree, and time zones are handled once, correctly.
//
// helpers:
//   localMs(iso, airport)   -> UTC ms (stored times are airport-local unless they end in Z)
//   localParts(ms, airport) -> { date: 'YYYY-MM-DD', hour, minute, dow } at that airport
//   coords(airport)         -> [lat, lon] or null
'use strict';

const EARTH_NM = 21639;        // once around the equator
const MOON_NM = 207559;        // average Earth-Moon distance
const HOME_RADIUS_NM = 35;     // an airport this close to home or base counts as home (SUS/STL, LGA/JFK)
const MAX_STAY_MS = 6 * 86400000;   // a longer gap between two legs is time off, not a stay
const MAX_LAYOVER_MS = 5 * 86400000;

function haversineNm(a, b) {
    const r = d => d * Math.PI / 180;
    const dLat = r(b[0] - a[0]), dLon = r(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLon / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const up = c => String(c || '').toUpperCase().trim();
const top = (counts, n) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }

function computeWrappedStats({ pilot, segments, year, helpers }) {
    const { localMs, localParts, coords } = helpers;
    const y = String(year);
    const homeCodes = [pilot.home_airport, pilot.base, ...(pilot.extraHomes || [])].map(up).filter(Boolean);
    const homeCoords = homeCodes.map(coords).filter(Boolean);
    // Every base they've had: a stay at an old base (Sam's LGA) is a crash pad, not a layover.
    const baseCoords = [pilot.base, ...(pilot.pastBases || [])].map(up).filter(Boolean).map(coords).filter(Boolean);
    const near = (code, list) => {
        const c = coords(code);
        if (!c) return homeCodes.includes(up(code));
        return list.some(h => haversineNm(c, h) <= HOME_RADIUS_NM);
    };
    const isHome = code => near(code, homeCoords);
    const isBase = code => near(code, baseCoords);

    // Every flight that happened, in order, with real instants and local dates.
    const flights = [];
    for (const s of segments) {
        if (s.type !== 'flight' || s.auto_leg_cancelled || !s.departure_time) continue;
        const dep = up(s.departure_airport), arr = up(s.arrival_airport);
        const depMs = localMs(s.departure_time, dep);
        if (!Number.isFinite(depMs)) continue;
        let arrMs = s.arrival_time ? localMs(s.arrival_time, arr || dep) : NaN;
        if (!(arrMs > depMs) || arrMs - depMs > 20 * 3600000) arrMs = NaN;
        const trip = s.trip || '';
        const kind = trip === 'PERSONAL' ? 'personal' : (s.is_dh || trip === 'COMMUTE') ? 'ride' : 'work';
        const block = s.block_minutes > 0 && s.block_minutes < 20 * 60 ? s.block_minutes
            : Number.isFinite(arrMs) ? Math.round((arrMs - depMs) / 60000) : null;
        const dc = coords(dep), ac = coords(arr);
        flights.push({
            dep, arr, depMs, arrMs, kind, block, tail: up(s.tail), fn: up(s.flight_number), created: s.created_at || '',
            nm: dc && ac && dep !== arr ? haversineNm(dc, ac) : 0,
            depL: localParts(depMs, dep), arrL: Number.isFinite(arrMs) ? localParts(arrMs, arr || dep) : null,
        });
    }
    flights.sort((a, b) => a.depMs - b.depMs);
    // The same leg stored twice is one flight: a sync can add a retimed copy instead of replacing it
    // (Drew's G74452 STL-ORD at 00:00Z and 00:30Z). Same route and flight number that local day, or the
    // same route within 10 minutes; the newer row wins.
    const seen = new Map();
    for (const f of flights) {
        const key = f.fn ? `${f.fn}|${f.dep}|${f.arr}|${f.depL.date}` : `${f.dep}|${f.arr}|${Math.round(f.depMs / 600000)}`;
        const had = seen.get(key);
        if (!had || f.created > had.created) seen.set(key, f);
    }
    const kept = new Set(seen.values());
    for (let i = flights.length - 1; i >= 0; i--) if (!kept.has(flights[i])) flights.splice(i, 1);
    // Only flights that have happened: a scheduled trip can still be cancelled or changed. helpers.now for tests.
    const now = helpers.now ?? Date.now();
    const inYear = f => f.depL.date.startsWith(y) && f.depMs <= now;
    // A leg back to the airport it left (a return to the gate) isn't a trip anywhere.
    const work = flights.filter(f => f.kind === 'work' && inYear(f) && f.dep !== f.arr);
    const rides = flights.filter(f => f.kind === 'ride' && inYear(f));
    const firstSeen = flights.length ? flights[0].depL.date : null;

    const blockMins = work.reduce((s, f) => s + (f.block || 0), 0);
    const nm = work.reduce((s, f) => s + f.nm, 0);

    const airports = new Set(), landings = {}, routes = {};
    for (const f of work) {
        if (f.dep) airports.add(f.dep);
        if (f.arr) { airports.add(f.arr); landings[f.arr] = (landings[f.arr] || 0) + 1; }
        if (f.dep && f.arr && f.dep !== f.arr) routes[`${f.dep}-${f.arr}`] = (routes[`${f.dep}-${f.arr}`] || 0) + 1;
    }
    // Airports first flown to this year (only when there's history from before the year to compare with).
    let newAirports = null;
    if (firstSeen && firstSeen < `${y}-01-01`) {
        const before = new Set();
        for (const f of flights) if (!inYear(f) && f.depL.date < `${y}-01-01`) { before.add(f.dep); before.add(f.arr); }
        newAirports = [...airports].filter(a => !before.has(a));
    }

    const months = Array.from({ length: 12 }, () => ({ legs: 0, block: 0 }));
    const weekdays = Array(7).fill(0), hours = Array(24).fill(0), byDay = {};
    for (const f of work) {
        const m = months[parseInt(f.depL.date.slice(5, 7), 10) - 1];
        m.legs++; m.block += f.block || 0;
        weekdays[f.depL.dow]++;
        hours[f.depL.hour]++;
        (byDay[f.depL.date] = byDay[f.depL.date] || []).push(f);
    }
    const busiestMonth = months.reduce((b, m, i) => m.legs && (!b || m.legs > b.legs || (m.legs === b.legs && m.block > b.block)) ? { i, legs: m.legs, block: m.block } : b, null);

    const days = Object.keys(byDay).sort();
    let busiestDay = null;
    // Most legs, and on a tie the most block time (Kyle has six 3-leg days; the first one used to win).
    for (const d of days) {
        const legs = byDay[d].length, block = byDay[d].reduce((s, f) => s + (f.block || 0), 0);
        if (!busiestDay || legs > busiestDay.legs || (legs === busiestDay.legs && block > busiestDay.block)) {
            busiestDay = { date: d, legs, stops: [byDay[d][0].dep, ...byDay[d].map(f => f.arr)], block };
        }
    }
    let streak = 0, run = 0, prev = null, streakEnd = null;
    for (const d of days) { run = prev && dayDiff(prev, d) === 1 ? run + 1 : 1; if (run > streak) { streak = run; streakEnd = d; } prev = d; }

    const hhmm = p => `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    const legOut = f => f && { dep: f.dep, arr: f.arr, date: f.depL.date, block: f.block, nm: Math.round(f.nm) };
    let earliest = null, latest = null, longest = null, shortest = null, farthest = null;
    for (const f of work) {
        const dm = f.depL.hour * 60 + f.depL.minute;
        // Earliest start counts from 03:00, so a 01:30 departure is a late night, not an early morning.
        const early = (dm - 180 + 1440) % 1440;
        if (!earliest || early < earliest.k) earliest = { k: early, time: hhmm(f.depL), leg: legOut(f) };
        if (f.arrL) {
            const am = f.arrL.hour * 60 + f.arrL.minute, late = (am - 300 + 1440) % 1440;
            if (!latest || late > latest.k) latest = { k: late, time: hhmm(f.arrL), leg: legOut(f) };
        }
        if (f.block && (!longest || f.block > longest.block)) longest = f;
        if (f.block >= 10 && (!shortest || f.block < shortest.block)) shortest = f;
        if (f.nm && (!farthest || f.nm > farthest.nm)) farthest = f;
    }
    const earlyStarts = work.filter(f => f.depL.hour < 6 && f.depL.hour >= 3).length;
    const lateNights = work.filter(f => f.arrL && (f.arrL.hour >= 23 || f.arrL.hour < 3)).length;
    const redEyes = work.filter(f => f.arrL && f.arrL.date > f.depL.date && f.block >= 120).length;

    // Where they slept: between one flight's arrival and the next departure from that same place.
    let nightsAway = 0;
    const nightsBy = {}, stays = [];
    for (let i = 0; i + 1 < flights.length; i++) {
        const a = flights[i], b = flights[i + 1];
        if (!a.arrL || !a.arrL.date.startsWith(y) || b.depMs > now || a.kind === 'personal' || b.kind === 'personal') continue;
        if (!a.arr || !b.dep || (a.arr !== b.dep && !(coords(a.arr) && coords(b.dep) && haversineNm(coords(a.arr), coords(b.dep)) < 15))) continue;
        const gap = b.depMs - a.arrMs;
        if (!(gap > 0) || gap > MAX_STAY_MS || isHome(a.arr)) continue;
        const nights = dayDiff(a.arrL.date, b.depL.date);
        if (nights > 0) { nightsAway += nights; nightsBy[a.arr] = (nightsBy[a.arr] || 0) + nights; }
        if (!isBase(a.arr) && gap <= MAX_LAYOVER_MS && (a.kind === 'work' || b.kind === 'work')) stays.push({ airport: a.arr, mins: Math.round(gap / 60000), from: a.arrL.date, to: b.depL.date });
    }
    // A crash pad: one airport holding a big share of the nights (a commuter's base, even one missing from
    // the base history). It gets its own fact and stays out of the layover rankings.
    const [padApt, padNights] = top(nightsBy, 1)[0] || [];
    const crashPad = padNights >= 15 && padNights >= nightsAway * 0.3 ? { airport: padApt, nights: padNights } : null;
    const longestLayover = stays.filter(x => !crashPad || x.airport !== crashPad.airport).sort((a, b) => b.mins - a.mins)[0] || null;
    const layoverNights = { ...nightsBy };
    if (crashPad) delete layoverNights[crashPad.airport];
    for (const b of [pilot.base, ...(pilot.pastBases || [])].map(up)) delete layoverNights[b];

    // Compass points: the farthest north, south, east and west they landed.
    const compass = {};
    for (const a of airports) {
        const c = coords(a); if (!c) continue;
        if (!compass.north || c[0] > compass.north.lat) compass.north = { airport: a, lat: c[0], lon: c[1] };
        if (!compass.south || c[0] < compass.south.lat) compass.south = { airport: a, lat: c[0], lon: c[1] };
        if (!compass.east || c[1] > compass.east.lon) compass.east = { airport: a, lat: c[0], lon: c[1] };
        if (!compass.west || c[1] < compass.west.lon) compass.west = { airport: a, lat: c[0], lon: c[1] };
    }

    // Some parsers put the aircraft type (CR7, 321) where the tail goes: those make a fleet, not tails.
    const tails = {}, types = {};
    const isReg = t => /^N\d{1,5}[A-Z]{0,2}$/.test(t) || /^[A-Z]{1,2}-[A-Z0-9]{3,5}$/.test(t) || /^C-[A-Z]{4}$/.test(t);
    const isNetjetsDigits = t => /^\d{1,3}$/.test(t) && pilot.airline_code === 'EJA';
    for (const f of work) {
        if (!f.tail) continue;
        if (isReg(f.tail) || isNetjetsDigits(f.tail)) tails[f.tail] = (tails[f.tail] || 0) + 1;
        else types[f.tail] = (types[f.tail] || 0) + 1;
    }
    // Every route flown, both directions as one line (SUS-BIV and BIV-SUS), for the map. It used to stop at the
    // top 60, so a once-flown airport (NEW, HOU) had a dot with no line to it.
    const pairs = {};
    for (const [r, n] of Object.entries(routes)) { const k = r.split('-').sort().join('-'); pairs[k] = (pairs[k] || 0) + n; }
    const routeArcs = top(pairs, 500).map(([r, n]) => { const [d, a] = r.split('-'); return { dep: d, arr: a, n, dc: coords(d), ac: coords(a) }; }).filter(r => r.dc && r.ac);

    return {
        year: Number(year), pilotKey: pilot.pilot_key, name: pilot.name, firstName: String(pilot.name || pilot.pilot_key).split(' ')[0],
        legs: work.length, blockMins, nm: Math.round(nm), earthLaps: nm / EARTH_NM, moonTrips: nm / MOON_NM,
        avgSpeedKts: blockMins ? Math.round(nm / (blockMins / 60)) : null,
        airports: airports.size, newAirports: newAirports && { count: newAirports.length, list: newAirports.slice(0, 6) },
        topAirports: top(landings, 5), topRoutes: top(routes, 5), routeArcs,
        airportPoints: [...airports].map(a => ({ a, c: coords(a), n: landings[a] || 0 })).filter(p => p.c),
        months, busiestMonth, weekdays, hours,
        flyingDays: days.length, busiestDay, streak: { days: streak, end: streakEnd },
        earliest: earliest && { time: earliest.time, leg: earliest.leg }, latest: latest && { time: latest.time, leg: latest.leg },
        earlyStarts, lateNights, redEyes,
        longestLeg: legOut(longest), shortestLeg: legOut(shortest), farthestLeg: legOut(farthest),
        nightsAway, crashPad, topLayoverCities: top(layoverNights, 5), longestLayover,
        rides: { legs: rides.length, nm: Math.round(rides.reduce((s, f) => s + f.nm, 0)) },
        tails: { count: Object.keys(tails).length, top: top(tails, 3) },
        aircraftTypes: top(types, 4),
        compass,
    };
}

// The metrics pilots are ranked on: higher is "more". Others' values never leave the server.
const RANKED = ['blockMins', 'legs', 'nm', 'airports', 'nightsAway', 'longestLayover', 'earlyStarts', 'flyingDays', 'streak', 'busiestDay', 'lateNights'];
const metricValue = (s, k) => k === 'longestLayover' ? (s.longestLayover?.mins || 0) : k === 'streak' ? s.streak.days
    : k === 'busiestDay' ? (s.busiestDay?.legs || 0) : (s[k] || 0);
// pct = the share of the other pilots this one beats (ties count half). Null for a group under 4.
function percentiles(all, me, minLegs = 10) {
    const group = all.filter(s => s.legs >= minLegs);
    const out = {};
    for (const k of RANKED) {
        const mine = metricValue(me, k), others = group.filter(s => s.pilotKey !== me.pilotKey).map(s => metricValue(s, k));
        if (others.length < 3 || me.legs < minLegs) { out[k] = null; continue; }
        const below = others.filter(v => v < mine).length, tied = others.filter(v => v === mine).length;
        out[k] = { pct: Math.round(100 * (below + tied / 2) / others.length), n: others.length + 1, top: below === others.length };
    }
    return out;
}

module.exports = { computeWrappedStats, percentiles, haversineNm, RANKED };
