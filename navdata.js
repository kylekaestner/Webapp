// navdata.js — resolves named fixes/navaids/SID/STAR/airways from a parsed route (see
// parseRouteString in swim.js) to real coordinates, using FAA NASR data (public domain, 28-day
// AIRAC cycle — see scripts/build-navdata.js for the source/build process). This is what
// swim.js's/server.js's airport+latlon-only resolution couldn't do on its own.
//
// Known, accepted limitations (documented rather than silently wrong):
// - Fix/navaid identifiers are not globally unique. Disambiguated by proximity to the previous
//   already-resolved point in the route, same approach SwimReader's own real implementation
//   uses. The first waypoint in a route has the origin airport as that reference point.
// - A SID/STAR can have multiple distinct "body" segments (e.g. runway-specific initial legs)
//   that all converge to the same later fix. Without the actual departure/arrival runway (not
//   available from the route string), there's no way to know which one applied — this resolver
//   picks the first one deterministically. Confirmed against a real flight (SWA2932/FORPE1) that
//   this produces a materially correct fix sequence from the convergence point onward, even when
//   the exact initial unique fixes can't be guaranteed.
// - Airways are resolved as the sub-sequence between the two known surrounding points, in
//   whichever direction they appear in the airway's published fix list. If a waypoint appears
//   more than once on the same airway (rare but possible on complex airways), the nearest
//   occurrence to the surrounding points is used.

const fs = require('fs');
const path = require('path');

const NASR_DIR = path.join(__dirname, 'data', 'nasr');

function loadJson(name) {
    try {
        return JSON.parse(fs.readFileSync(path.join(NASR_DIR, name), 'utf8'));
    } catch (e) {
        console.warn(`[navdata] could not load ${name} — run scripts/build-navdata.js first. Named-fix resolution disabled.`, e.message);
        return null;
    }
}

const fixes = loadJson('fixes.json');
const navaids = loadJson('navaids.json');
const proceduresData = loadJson('procedures.json');
const airways = loadJson('airways.json');

const ENABLED = !!(fixes && navaids && proceduresData && airways);

function haversineNm(a, b) {
    const R = 3440.065; // nautical miles
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Projects a point `distanceNm` along `radial` (true degrees) from a navaid's position.
function projectRadialDistance(origin, radialDeg, distanceNm) {
    const R = 3440.065;
    const brng = radialDeg * Math.PI / 180;
    const lat1 = origin.lat * Math.PI / 180, lon1 = origin.lon * Math.PI / 180;
    const d = distanceNm / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

// Picks the closest candidate to a reference point from a list of {lat,lon,...} candidates.
function pickClosest(candidates, ref) {
    if (!candidates || !candidates.length) return null;
    if (!ref || candidates.length === 1) return candidates[0];
    let best = candidates[0], bestDist = haversineNm(ref, candidates[0]);
    for (let i = 1; i < candidates.length; i++) {
        const d = haversineNm(ref, candidates[i]);
        if (d < bestDist) { best = candidates[i]; bestDist = d; }
    }
    return best;
}

// Map-marker symbol classification, per the real NASR field distribution checked against the
// actual data: FIX_USE_CODE is "WP" (RNAV waypoint) for 47k of ~70k fixes, "RP" (classic airway
// reporting point/intersection) for another 14k, and a handful of minor codes for the rest
// (military/VFR/radar fixes) — lumped in with "fix" rather than given their own symbol, since
// they're a small fraction and not a distinction asked for. Navaid NAV_TYPE values (VOR,
// VOR/DME, VORTAC, VOT, TACAN, DME, NDB, NDB/DME) collapse to just "vor" or "ndb" — the two
// symbol families that actually matter on a chart.
function classifyFixSymbol(useCode) {
    return useCode === 'WP' ? 'waypoint' : 'fix';
}
function classifyNavaidSymbol(navType) {
    return (navType || '').toUpperCase().includes('NDB') ? 'ndb' : 'vor';
}

function resolveFixOrNavaid(name, ref) {
    const fixCandidates = (fixes[name] || []).map(c => ({ ...c, symbol: classifyFixSymbol(c.useCode) }));
    const navCandidates = (navaids[name] || []).map(c => ({ ...c, symbol: classifyNavaidSymbol(c.type) }));
    const all = [...fixCandidates, ...navCandidates];
    return pickClosest(all, ref);
}

// Expands a SID/STAR name into its real fix sequence (names only — resolved to coordinates by
// the caller, same as any other fix). `nextToken` is whatever immediately follows the procedure
// in the route string — if it matches one of the procedure's real transitions, it's consumed as
// part of the expansion rather than treated as a separate, independent fix.
// Confirmed against real NASR data: a SID's transition fix comes AFTER its body (airport → SID
// → exit transition, e.g. "FORPE1.ABQ" in a route string — ABQ is the token AFTER the SID) and
// its code format is "NAME.transition". A STAR's transition comes BEFORE its body (entry
// transition → STAR → airport, e.g. "USIRE.KOLTS2" — USIRE is the token BEFORE the STAR) and its
// code format is the OPPOSITE: "transition.NAME". So the neighbor token checked for a match is
// the next one for a SID, but the previous one for a STAR — not the same direction for both.
function expandProcedure(procName, isSid, neighborTokenName) {
    const table = isSid ? proceduresData.sids : proceduresData.stars;
    const proc = table[procName];
    if (!proc) return null;
    const body = (proc.bodies && proc.bodies[0]) || []; // first body segment — see file header limitation
    const transitionFixes = (neighborTokenName && proc.transitions[neighborTokenName]) || [];
    return { body, transitionFixes, isSid, matchedNeighbor: transitionFixes.length > 0 };
}

// Main entry point: given parseRouteString()'s waypoints array (already has lat/lon filled in
// for 'airport' and 'latlon' types by the caller), returns a NEW ordered array of
// {name, lat, lon} points with procedures/airways/fixes/radial_fixes expanded and resolved.
// Anything that still can't be resolved (unknown identifier, NASR data not loaded) is simply
// omitted — a gap in the line is honest; a wrong guess at coordinates is not.
function resolveWaypoints(waypoints, originCoords) {
    if (!ENABLED || !waypoints?.length) return [];
    const out = [];
    let ref = originCoords || null;
    // 'airport'/'latlon' points already carry coordinates from the caller (parseRouteString) —
    // no navdata lookup needed, so their symbol comes straight from their own waypoint type.
    if (waypoints[0]?.lat != null) { out.push({ name: waypoints[0].name, lat: waypoints[0].lat, lon: waypoints[0].lon, symbol: waypoints[0].type === 'airport' ? 'airport' : 'latlon' }); ref = waypoints[0]; }

    for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        if (i === 0 && wp.lat != null) continue; // already pushed above as the starting reference

        if (wp.lat != null) { out.push({ name: wp.name, lat: wp.lat, lon: wp.lon, symbol: wp.type === 'airport' ? 'airport' : 'latlon' }); ref = wp; continue; }

        if (wp.type === 'procedure') {
            const nextTok = waypoints[i + 1]?.name;
            // Try both tables rather than guess SID vs STAR from position/context — procedure
            // naming collisions between the two spaces are not a real-world concern.
            const prevTok = out[out.length - 1]?.name;
            // SID: check the NEXT token (exit transition comes after the SID in a route string).
            // STAR: check the PREVIOUS token (entry transition comes before the STAR) — already
            // resolved and sitting in `out`, so its fixes get prepended, not "consumed" from the
            // waypoints array the way a SID's next-token match is.
            const sidMatch = expandProcedure(wp.name, true, nextTok);
            const starMatch = !sidMatch?.matchedNeighbor ? expandProcedure(wp.name, false, prevTok) : null;
            const expansion = sidMatch?.matchedNeighbor ? sidMatch : (starMatch?.matchedNeighbor ? starMatch : (sidMatch || starMatch));

            if (expansion) {
                const names = expansion.isSid
                    ? [...expansion.body, ...expansion.transitionFixes.filter(f => f !== expansion.body[expansion.body.length - 1])]
                    : [...expansion.transitionFixes.filter(f => f !== prevTok),
                       ...expansion.body.filter((f, idx) => idx > 0 || f !== expansion.transitionFixes[expansion.transitionFixes.length - 1])];
                for (const fixName of names) {
                    const resolved = resolveFixOrNavaid(fixName, ref);
                    if (resolved) { out.push({ name: fixName, lat: resolved.lat, lon: resolved.lon, symbol: resolved.symbol }); ref = resolved; }
                }
                if (expansion.isSid && expansion.matchedNeighbor) i++; // next token was the SID's exit transition, already expanded — skip it
            }
            continue;
        }

        if (wp.type === 'airway') {
            const seq = airways[wp.name];
            const prevPoint = out[out.length - 1];
            const nextWp = waypoints[i + 1];
            if (seq && prevPoint && nextWp) {
                const fromIdx = seq.indexOf(prevPoint.name);
                // next waypoint might itself need resolving first for its name to be known — it's just a name match here, not coordinates
                const toIdx = nextWp.name ? seq.indexOf(nextWp.name) : -1;
                if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                    const slice = fromIdx < toIdx ? seq.slice(fromIdx + 1, toIdx) : seq.slice(toIdx + 1, fromIdx).reverse();
                    for (const fixName of slice) {
                        const resolved = resolveFixOrNavaid(fixName, ref);
                        if (resolved) { out.push({ name: fixName, lat: resolved.lat, lon: resolved.lon, symbol: resolved.symbol }); ref = resolved; }
                    }
                }
            }
            continue;
        }

        if (wp.type === 'radial_fix') {
            const navCandidates = navaids[wp.navaid];
            const nav = pickClosest(navCandidates, ref);
            if (nav) {
                const projected = projectRadialDistance(nav, wp.radial, wp.distanceNm);
                // Not a charted fix nor the navaid's own position — a computed point along the
                // route, same visual role as a classic intersection, so it gets the "fix" symbol.
                out.push({ name: wp.name, lat: projected.lat, lon: projected.lon, symbol: 'fix' });
                ref = projected;
            }
            continue;
        }

        // Plain 'fix' type (and anything else we don't have special handling for)
        const resolved = resolveFixOrNavaid(wp.name, ref);
        if (resolved) { out.push({ name: wp.name, lat: resolved.lat, lon: resolved.lon, symbol: resolved.symbol }); ref = resolved; }
    }

    return out;
}

module.exports = { resolveWaypoints, isEnabled: () => ENABLED };
