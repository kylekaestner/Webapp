// ==UserScript==
// @name         CrewSync FRAT Autofill
// @namespace    https://crewsync.spiritjets.com/
// @version      3.1
// @description  Prefills Date, Origin, Dest, Trip ID, PIC, SIC, Aircraft, TSA + 24 risk questions from schedule, weather, airport, and NOTAM data
// @author       Kyle Kaestner
// @match        https://prismsms.argus.aero/tools/frat-landing/frat-report/*/add
// @match        https://prismsms.argus.aero/tools/frat-landing/frat-report/*/edit
// @updateURL    http://167.71.107.245:3000/frat-autofill.user.js
// @downloadURL  http://167.71.107.245:3000/frat-autofill.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      167.71.107.245
// @connect      schedaero.avinode.com
// @connect      aviationweather.gov
// @connect      api.sunrise-sunset.org
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SERVER      = 'http://167.71.107.245:3000';
  const PILOT       = 'kyle';
  const SIC_NAME    = 'Kaestner';
  const COMPANY_CAL = 'https://schedaero.avinode.com/mvc/api/calendars/main/5678';

  const CREW_NAMES = {
    HSB: 'Hans Brosbol',   TJB: 'Thomas Bressie', MEV: 'Martin Valla',
    JAL: 'Lonnie Legner',  AJB: 'Aleks Biteman',  TAJ: 'Tyler Johnson',
    LWK: 'Luke Knudsvig',  GWM: 'Greg Medsker',
  };

  // IANA timezone for common airports; unknown ones fall back to lon-based estimate
  const AIRPORT_TZ = {
    KBOS:'America/New_York',  KJFK:'America/New_York',  KLGA:'America/New_York',
    KEWR:'America/New_York',  KIAD:'America/New_York',  KDCA:'America/New_York',
    KBWI:'America/New_York',  KATL:'America/New_York',  KCLT:'America/New_York',
    KMIA:'America/New_York',  KTPA:'America/New_York',  KMCO:'America/New_York',
    KPHL:'America/New_York',  KPBI:'America/New_York',  KFLL:'America/New_York',
    KORD:'America/Chicago',   KMDW:'America/Chicago',   KDAL:'America/Chicago',
    KDFW:'America/Chicago',   KHOU:'America/Chicago',   KIAH:'America/Chicago',
    KMSP:'America/Chicago',   KSUS:'America/Chicago',   KSTL:'America/Chicago',
    KMKC:'America/Chicago',   KTUL:'America/Chicago',   KOMA:'America/Chicago',
    KSAT:'America/Chicago',   KAUS:'America/Chicago',   KLIT:'America/Chicago',
    KBNA:'America/Chicago',   KMEM:'America/Chicago',   KIND:'America/Indiana/Indianapolis',
    KDEN:'America/Denver',    KSLC:'America/Denver',    KABQ:'America/Denver',
    KBZN:'America/Denver',    KASE:'America/Denver',    KEGE:'America/Denver',
    KGJT:'America/Denver',    KTEX:'America/Denver',
    KPHX:'America/Phoenix',   KTUS:'America/Phoenix',
    KLAS:'America/Los_Angeles', KLAX:'America/Los_Angeles', KSFO:'America/Los_Angeles',
    KSEA:'America/Los_Angeles', KPDX:'America/Los_Angeles', KOAK:'America/Los_Angeles',
    KSJC:'America/Los_Angeles', KSAN:'America/Los_Angeles',
    PANC:'America/Anchorage',
    PHNL:'Pacific/Honolulu',  PHOG:'Pacific/Honolulu',
  };

  // ── Generic AJAX helper (returns parsed JSON or null) ─────────────────────

  function gmXhr(url, extraOpts = {}) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 8000, ...extraOpts,
        onload:    r => { try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); } },
        onerror:   () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  // ── Input finders ─────────────────────────────────────────────────────────

  function matFieldLabel(ff) {
    const ml = ff.querySelector('mat-label');
    if (ml) return ml.textContent.replace(/\*/g, '').trim().toLowerCase();
    const lbl = ff.querySelector('label');
    if (lbl) return lbl.textContent.replace(/\*/g, '').trim().toLowerCase();
    return '';
  }

  function inputByLabel(text) {
    const t = text.toLowerCase();
    for (const ff of document.querySelectorAll('mat-form-field')) {
      if (matFieldLabel(ff) === t) return ff.querySelector('input:not([type=hidden])') || null;
    }
    for (const lbl of document.querySelectorAll('label')) {
      const lblTxt = lbl.textContent.replace(/\*/g, '').trim().toLowerCase();
      if (lblTxt === t && lbl.htmlFor) return document.getElementById(lbl.htmlFor) || null;
    }
    const all = document.querySelectorAll('label, mat-label, span, div, p, th');
    for (const el of all) {
      if (el.children.length > 2) continue;
      const txt = el.textContent.replace(/\*/g, '').trim().toLowerCase();
      if (txt !== t) continue;
      let container = el.parentElement;
      for (let i = 0; i < 4 && container; i++) {
        const inputs = [...container.querySelectorAll(
          'input:not([type=hidden]):not([type=checkbox]):not([type=radio])'
        )];
        if (inputs.length === 1) return inputs[0];
        container = container.parentElement;
      }
    }
    return null;
  }

  function findAnySelect(text) {
    const t = text.toLowerCase();
    for (const ff of document.querySelectorAll('mat-form-field')) {
      if (matFieldLabel(ff) === t) {
        const s = ff.querySelector('mat-select');
        if (s) return { el: s, kind: 'mat' };
      }
    }
    for (const ff of document.querySelectorAll('mat-form-field')) {
      const lbl = matFieldLabel(ff);
      if (!lbl) continue;
      if (lbl.includes(t) || (lbl.length >= 2 && t.includes(lbl))) {
        const s = ff.querySelector('mat-select');
        if (s) return { el: s, kind: 'mat' };
      }
    }
    for (const s of document.querySelectorAll('mat-select')) {
      const name = (s.getAttribute('formcontrolname') || s.getAttribute('ng-reflect-name') || '').toLowerCase();
      if (name && name.length >= 3 && (name === t || name.includes(t) || t.includes(name))) return { el: s, kind: 'mat' };
    }
    const termRegex = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const allSelects = [
      ...[...document.querySelectorAll('mat-select')].map(s => ({ el: s, kind: 'mat' })),
      ...[...document.querySelectorAll('select')].map(s => ({ el: s, kind: 'native' })),
    ];
    for (const el of document.querySelectorAll('label, mat-label, span, div, p, td, th, h4, h5, h6')) {
      if (el.querySelector('mat-select, select, input:not([type=hidden])')) continue;
      const txt = el.textContent.replace(/\*/g, '').trim();
      if (!termRegex.test(txt)) continue;
      const following = allSelects.filter(({ el: s }) =>
        el.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (following.length) return following[0];
    }
    return null;
  }

  function selectByLabel(text) {
    const r = findAnySelect(text);
    return (r && r.kind === 'mat') ? r.el : null;
  }

  // ── Angular-aware value setters ───────────────────────────────────────────

  function setAngularInput(el, value) {
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    ['focus', 'input', 'change', 'blur'].forEach(ev =>
      el.dispatchEvent(new Event(ev, { bubbles: true }))
    );
  }

  async function setAutocomplete(el, value) {
    if (!el) return false;
    el.focus();
    setAngularInput(el, value);
    await new Promise(r => setTimeout(r, 700));
    const opts = [...document.querySelectorAll('mat-option')].filter(o => o.offsetParent !== null);
    if (!opts.length) return true;
    const match = opts.find(o => o.textContent.includes(value)) || opts[0];
    match.click();
    await new Promise(r => setTimeout(r, 200));
    return true;
  }

  async function selectAnyOption(info, search) {
    if (!info) return false;
    const { el, kind } = info;
    if (kind === 'native') {
      const opts = [...el.options];
      const match = opts.find(o => o.text.toLowerCase().includes(search.toLowerCase()));
      if (!match) {
        console.log(`[CrewSync FRAT] No match for "${search}" in native select`);
        return false;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, match.value);
      ['change', 'input'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
      return true;
    }
    return selectMatOption(el, search);
  }

  function closeCdkOverlay() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    const backdrop = document.querySelector('.cdk-overlay-backdrop');
    if (backdrop) backdrop.click();
  }

  async function selectMatOption(selectEl, search) {
    if (!selectEl) return false;
    closeCdkOverlay();
    await new Promise(r => setTimeout(r, 250));
    const trigger = selectEl.querySelector('.mat-select-trigger') || selectEl;
    trigger.click();
    await new Promise(r => setTimeout(r, 450));
    const panelSearch = [...document.querySelectorAll(
      '.mat-select-panel input, mat-select-search input, [class*="select-search"] input'
    )].find(el => el.offsetParent !== null);
    if (panelSearch) {
      panelSearch.focus();
      setAngularInput(panelSearch, search);
      await new Promise(r => setTimeout(r, 600));
    }
    const opts = [...document.querySelectorAll('mat-option')];
    const match = opts.find(o => o.textContent.toLowerCase().includes(search.toLowerCase()));
    if (match) { match.click(); return true; }
    const realOpts = opts.filter(o => !o.classList.contains('mat-option-disabled') &&
      !o.textContent.trim().toLowerCase().startsWith('no '));
    if (realOpts.length === 1) {
      console.log(`[CrewSync FRAT] No text match for "${search}" — clicking sole option: "${realOpts[0].textContent.trim()}"`);
      realOpts[0].click();
      return true;
    }
    console.log(`[CrewSync FRAT] No match for "${search}". Options: ${opts.map(o => `"${o.textContent.trim()}"`).join(' | ')}`);
    closeCdkOverlay();
    return false;
  }

  // ── Debug dump ────────────────────────────────────────────────────────────

  function debugDump() {
    const allMs = [...document.querySelectorAll('mat-select')];
    console.group(`[CrewSync FRAT] ALL mat-selects (${allMs.length} total):`);
    allMs.forEach((sel, idx) => {
      const fc  = sel.getAttribute('formcontrolname') || sel.getAttribute('ng-reflect-name') || '(none)';
      const val = sel.querySelector('.mat-select-value-text')?.textContent.trim() || '(empty)';
      const ff  = sel.closest('mat-form-field');
      const ffl = ff ? (matFieldLabel(ff) || '(no ff-label)') : '(not in ff)';
      let prevLabel = '';
      let node = sel;
      for (let i = 0; i < 6 && !prevLabel; i++) {
        node = node.previousElementSibling || node.parentElement?.previousElementSibling;
        if (!node) break;
        const txt = node.textContent.replace(/\*/g, '').trim().slice(0, 40);
        if (txt && node.children.length <= 3) prevLabel = txt;
      }
      console.log(`[${idx}] fc="${fc}" | val="${val}" | ff-label="${ffl}" | prev-sibling="${prevLabel}"`);
    });
    console.groupEnd();
    console.group('[CrewSync FRAT] findAnySelect results:');
    ['aircraft', 'pic', 'sic', 'tsa vetting', 'part 135 tsa vetting', 'physically and mentally fit', 'time zones'].forEach(term => {
      const r = findAnySelect(term);
      if (!r) { console.log(`  "${term}" → NOT FOUND`); return; }
      const idx = allMs.indexOf(r.el);
      const fc  = r.el.getAttribute('formcontrolname') || '(none)';
      const val = r.el.querySelector('.mat-select-value-text')?.textContent.trim() || '(empty)';
      console.log(`  "${term}" → [${idx}] fc="${fc}" | val="${val}" | kind=${r.kind}`);
    });
    console.groupEnd();
    const inputs = [...document.querySelectorAll(
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio])'
    )].filter(i => i.offsetParent !== null);
    console.group(`[CrewSync FRAT] Visible inputs (${inputs.length}):`);
    inputs.forEach((inp, idx) => {
      const ff  = inp.closest('mat-form-field');
      const lbl = ff
        ? (ff.querySelector('mat-label')?.textContent.trim() || ff.querySelector('label')?.textContent.trim() || '(no ff-label)')
        : (document.querySelector(`label[for="${inp.id}"]`)?.textContent.trim() || '(no label)');
      console.log(`[${idx}] label="${lbl}" | id="${inp.id || '(none)'}" | val="${inp.value}"`);
    });
    console.groupEnd();

    // ── Risk question row finder test ──
    console.group('[CrewSync FRAT] Risk row finder test (Q6, Q7, Q8, Q10, Q19, Q26, Q32):');
    [6, 7, 8, 10, 19, 26, 32].forEach(n => {
      const row = findQuestionRow(n);
      if (!row) { console.log(`  Q${n} → NOT FOUND`); return; }
      const hasRisk = !!row.querySelector('frat-checkbox[formcontrolname="risk"]');
      const hasVal  = !!row.querySelector('mat-select[formcontrolname="value"]');
      const hasMit  = !!row.querySelector('mat-select[formcontrolname="mitigation"]');
      console.log(`  Q${n} → FOUND | risk=${hasRisk} | value-select=${hasVal} | mitigation=${hasMit}`);
    });
    console.groupEnd();

    alert('CrewSync debug info written to browser console (F12 → Console).');
  }

  // ── Date / time formatting ────────────────────────────────────────────────

  function fmtFlight(seg) {
    const dep = new Date(seg.departure_time);
    const opts = { timeZone: 'America/Chicago' };
    return dep.toLocaleDateString('en-US', { ...opts, weekday: 'short', month: 'short', day: 'numeric' })
      + ' · '
      + dep.toLocaleTimeString('en-US', { ...opts, hour: '2-digit', minute: '2-digit', hour12: false })
      + ' CT';
  }

  // ── Schedaero data ────────────────────────────────────────────────────────

  function extractBottomLeft(text) {
    const hits = [];
    try {
      const data = JSON.parse(text);
      const scan = v => {
        if (!v || typeof v !== 'object') return;
        if (v.BottomLeft) hits.push(String(v.BottomLeft).trim());
        else if (v.bottomLeft) hits.push(String(v.bottomLeft).trim());
        (Array.isArray(v) ? v : Object.values(v)).forEach(scan);
      };
      scan(data);
      return hits;
    } catch (_) {}
    for (const m of text.matchAll(/<BottomLeft[^>]*>([^<]*)<\/BottomLeft>/gi)) {
      if (m[1].trim()) hits.push(m[1].trim());
    }
    return hits;
  }

  // Replaces fetchCaptain — also extracts PaxActual for repositioning detection
  function fetchScheduleInfo(flight) {
    const date = new Date(flight.departure_time).toISOString().slice(0, 10);
    const url  = `${COMPANY_CAL}/${date}?ajax=true&_=${Date.now()}`;
    console.log('[CrewSync FRAT] Fetching company cal:', url);
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 8000,
        onload(r) {
          try {
            if (r.status !== 200) { resolve({ captain: null, paxActual: null }); return; }
            console.log('[CrewSync FRAT] Company cal response (first 400 chars):', r.responseText.slice(0, 400));

            let captain = null, paxActual = null;
            const allBL = extractBottomLeft(r.responseText);
            console.log(`[CrewSync FRAT] BottomLeft values on ${date}: ${allBL.join(' | ') || '(none)'}`);

            // Walk the full JSON tree to pick up PaxActual wherever it lives
            try {
              const data = JSON.parse(r.responseText);
              const scan = v => {
                if (!v || typeof v !== 'object') return;
                const pax = v.PaxActual ?? v.paxActual;
                if (pax !== undefined && pax !== null && paxActual === null) paxActual = Number(pax);
                (Array.isArray(v) ? v : Object.values(v)).forEach(scan);
              };
              scan(data);
            } catch (_) {}

            for (const crew of allBL) {
              const parts = crew.split('/');
              const captInit = parts[0].trim().toUpperCase();
              const sicInit  = (parts[1] || '').trim().toUpperCase();
              if (sicInit === 'KDK' && captInit.length >= 2) {
                captain = CREW_NAMES[captInit] || null;
                console.log(`[CrewSync FRAT] Captain: ${captInit} = ${captain || '(unknown)'} | PaxActual: ${paxActual}`);
                break;
              }
            }
            if (!captain) console.log('[CrewSync FRAT] No KDK-as-SIC entry found for', date);
            resolve({ captain, paxActual });
          } catch (e) {
            console.log('[CrewSync FRAT] Company cal parse error:', e.message);
            resolve({ captain: null, paxActual: null });
          }
        },
        onerror:   () => { console.log('[CrewSync FRAT] Company cal network error'); resolve({ captain: null, paxActual: null }); },
        ontimeout: () => { console.log('[CrewSync FRAT] Company cal timeout');        resolve({ captain: null, paxActual: null }); },
      });
    });
  }

  // ── Fetch upcoming legs ────────────────────────────────────────────────────

  function fetchFlights() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: `${SERVER}/api/pilots/${PILOT}`, timeout: 10000,
        onload(r) {
          try {
            const data = JSON.parse(r.responseText);
            // 24h lookback so same-day earlier legs are available for duty-period analysis
            const cutoff = Date.now() - 24 * 3600_000;
            const flights = (data.segments || [])
              .filter(s =>
                s.type === 'flight' &&
                s.departure_airport && s.arrival_airport && s.departure_time &&
                new Date(s.departure_time).getTime() >= cutoff
              )
              .sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time))
              .slice(0, 30);
            resolve(flights);
          } catch (e) { reject(e); }
        },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  // FAA TAF stations: maps airports without their own TAF to the nearest one that has one.
  // aviationweather.gov only issues TAFs for airports in the siteType=["METAR","TAF"] list.
  const TAF_FALLBACK = {
    KSTP: 'KMSP',  // St. Paul Downtown → Minneapolis
    KCPS: 'KSUS',  // St. Louis Downtown → Spirit
    KSGF: 'KSGF',  // Springfield already has TAF
    KSET: 'KSUS',  // St. Charles → Spirit
  };

  // ── FAA NOTAM data (via CrewSync server proxy — requires FAA API credentials) ──

  async function fetchNotams(dep, arr) {
    const data = await gmXhr(`${SERVER}/api/notams?dep=${dep}&arr=${arr}`);
    const notams = data?.notams || [];
    if (data?.unconfigured) console.log('[CrewSync FRAT] NOTAMs: RapidAPI key not set on server — skipping (POST /api/settings/notam-creds)');
    else console.log(`[CrewSync FRAT] NOTAMs: ${notams.length} for ${dep}/${arr}`);
    return notams;
  }

  // ── Weather + airport data + sun times (aviationweather.gov + sunrise-sunset.org) ──

  async function fetchWeatherAndAirports(dep, arr, arrTime) {
    const ids = dep === arr ? dep : `${dep},${arr}`;

    // Some smaller airports (e.g. KSTP) don't have TAFs — fetch their nearest TAF station too
    const tafFallback = TAF_FALLBACK[arr];
    const tafIds = tafFallback && tafFallback !== dep && tafFallback !== arr
      ? `${ids},${tafFallback}` : ids;

    const [metars, tafs, airportList] = await Promise.all([
      gmXhr(`https://aviationweather.gov/api/data/metar?ids=${ids}&format=json&hours=3`),
      gmXhr(`https://aviationweather.gov/api/data/taf?ids=${tafIds}&format=json`),
      gmXhr(`https://aviationweather.gov/api/data/airport?ids=${ids}&format=json`),
    ]);

    const metar = {}, taf = {}, airports = {};
    for (const m of (Array.isArray(metars) ? metars : [])) {
      if (!metar[m.icaoId]) metar[m.icaoId] = m;
    }
    for (const t of (Array.isArray(tafs) ? tafs : [])) {
      if (!taf[t.icaoId]) taf[t.icaoId] = t;
    }
    // If arr has no TAF, promote the fallback TAF under the arr key
    if (!taf[arr] && tafFallback && taf[tafFallback]) {
      taf[arr] = taf[tafFallback];
      console.log(`[CrewSync FRAT] TAF: no TAF for ${arr}, using ${tafFallback} as proxy`);
    }
    for (const a of (Array.isArray(airportList) ? airportList : [])) {
      airports[a.icaoId] = a;
    }

    // Sunrise/sunset for arrival airport via api.sunrise-sunset.org (no key needed).
    // Falls back to NOAA math if the API call fails.
    let sunTimes = null;
    const arrA = airports[arr];
    if (arrA?.lat && arrA?.lon && arrTime) {
      const dateStr = arrTime.toISOString().slice(0, 10);
      const sunData = await gmXhr(
        `https://api.sunrise-sunset.org/json?lat=${arrA.lat}&lng=${arrA.lon}&date=${dateStr}&formatted=0`
      );
      if (sunData?.status === 'OK') {
        sunTimes = {
          sunrise: new Date(sunData.results.sunrise),
          sunset:  new Date(sunData.results.sunset),
        };
        console.log(`[CrewSync FRAT] Sun times (API): sunrise=${sunTimes.sunrise.toUTCString()} sunset=${sunTimes.sunset.toUTCString()}`);
      } else {
        sunTimes = _solarTimes(arrA.lat, arrA.lon, arrTime);
        console.log('[CrewSync FRAT] Sun times (math fallback)');
      }
    }

    console.log(`[CrewSync FRAT] Weather: dep=${dep} temp=${metar[dep]?.temp}°C wx="${metar[dep]?.wxString||''}" gust=${metar[dep]?.wgst||0}kt | arr=${arr} elev=${arrA?.elev||'?'}ft`);
    return { metar, taf, airports, sunTimes };
  }

  // Pull the TAF base forecast period that covers a given UTC time.
  // Skips PROB and TEMPO periods — those are conditional, not the expected forecast.
  // Falls back to most-recent METAR if no TAF covers the time.
  function tafAtTime(tafEntry, utcDate) {
    if (!tafEntry?.fcsts) return null;
    const ts = utcDate.getTime() / 1000;
    let match = null;
    for (const f of tafEntry.fcsts) {
      if (f.fcstChange === 'PROB' || f.fcstChange === 'TEMPO') continue;
      if (f.timeFrom <= ts) match = f;
      else break;
    }
    return match;
  }

  // ── Astronomical sunrise/sunset (NOAA algorithm, accurate ±2 min) ──────────

  function _solarTimes(lat, lon, dateUTC) {
    const toR = d => d * Math.PI / 180, toD = r => r * 180 / Math.PI;
    const Y = dateUTC.getUTCFullYear(), Mo = dateUTC.getUTCMonth() + 1, D = dateUTC.getUTCDate();
    const JD = 367 * Y - Math.floor(7 * (Y + Math.floor((Mo + 9) / 12)) / 4)
             + Math.floor(275 * Mo / 9) + D + 1721013.5;
    const t = (JD - 2451545) / 36525;
    const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const M  = toR((357.52911 + t * (35999.05029 - 0.0001537 * t)) % 360);
    const C  = (1.914602 - t * (0.004817 + 0.000014 * t)) * Math.sin(M)
             + (0.019993 - 0.000101 * t) * Math.sin(2 * M)
             + 0.000289 * Math.sin(3 * M);
    const lam = toR((L0 + C + 180 + 102.9372) % 360);
    const e   = toR(23.439 - 0.0000004 * t);
    const sinD = Math.sin(e) * Math.sin(lam);
    const cosD = Math.cos(Math.asin(sinD));
    const latR = toR(lat);
    const cosH = (Math.cos(toR(90.833)) - Math.sin(latR) * sinD) / (Math.cos(latR) * cosD);
    if (Math.abs(cosH) > 1) return { sunrise: null, sunset: null }; // polar
    const y2 = Math.tan(e / 2) ** 2, L0r = toR(L0), e0 = 0.016708634;
    const eqTime = 4 * toD(
      y2 * Math.sin(2 * L0r) - 2 * e0 * Math.sin(M)
      + 4 * e0 * y2 * Math.sin(M) * Math.cos(2 * L0r)
      - 0.5 * y2 * y2 * Math.sin(4 * L0r)
      - 1.25 * e0 * e0 * Math.sin(2 * M)
    );
    const HA      = toD(Math.acos(cosH));
    const base    = Date.UTC(Y, Mo - 1, D);
    const sunrise = new Date(base + (720 - 4 * (lon + HA) - eqTime) * 60000 - 2 * 4 * HA * 60000);
    const sunset  = new Date(base + (720 - 4 * (lon - HA) - eqTime) * 60000);
    // Simpler: noon ± HA*4 minutes
    const noonMins = 720 - 4 * lon - eqTime;
    const HAmins   = 4 * HA;
    return {
      sunrise: new Date(base + (noonMins - HAmins) * 60000),
      sunset:  new Date(base + (noonMins + HAmins) * 60000),
    };
  }

  function calcSunsetUTC(lat, lon, dateUTC)  { return _solarTimes(lat, lon, dateUTC).sunset;  }
  function calcSunriseUTC(lat, lon, dateUTC) { return _solarTimes(lat, lon, dateUTC).sunrise; }

  // Get local hour (0–23) at an airport given a UTC Date and ICAO code
  function localHour(utcDate, icaoCode, fallbackLon) {
    let tz = AIRPORT_TZ[icaoCode];
    if (!tz && fallbackLon !== undefined) {
      // Rough lon-based estimate for US airports
      if (fallbackLon > -82)       tz = 'America/New_York';
      else if (fallbackLon > -97)  tz = 'America/Chicago';
      else if (fallbackLon > -112) tz = 'America/Denver';
      else                         tz = 'America/Los_Angeles';
    }
    if (!tz) tz = 'America/Chicago'; // Kyle's home base as final fallback
    try {
      const h = parseInt(new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', hour12: false,
      }).format(utcDate));
      return isNaN(h) ? utcDate.getUTCHours() : h % 24;
    } catch {
      return utcDate.getUTCHours();
    }
  }

  // ── FRAT risk question form interaction ───────────────────────────────────

  // Finds the question container element by walking up from the question number span.
  // Question spans contain text like "6. Duty period begins before 06:00..."
  function findQuestionRow(num) {
    const pattern = new RegExp(`^${num}\\.\\s`);
    const selectors = 'span.text.print-data, span.print-data, span.text, .category-list span';
    for (const span of document.querySelectorAll(selectors)) {
      if (!pattern.test(span.textContent.trim())) continue;
      // Walk up until we find a container that owns the risk checkbox or value select
      let el = span;
      for (let i = 0; i < 10; i++) {
        el = el.parentElement;
        if (!el || el.tagName === 'BODY') break;
        if (el.querySelector('frat-checkbox[formcontrolname="risk"], mat-select[formcontrolname="value"]'))
          return el;
      }
    }
    return null;
  }

  // Clicks the risk checkbox in a question row (handles Angular mat-checkbox)
  function checkRiskBox(row) {
    if (!row) return false;
    const fc = row.querySelector('frat-checkbox[formcontrolname="risk"]');
    if (!fc) return false;
    const input = fc.querySelector('input[type="checkbox"]');
    if (input?.checked) return true; // already checked
    const label = fc.querySelector('.mat-checkbox-layout');
    (label || fc).click();
    return true;
  }

  // Fill a single risk question: check its risk box and/or select a scored value
  async function fillRiskQuestion(num, opts = {}) {
    const row = findQuestionRow(num);
    if (!row) {
      console.log(`[CrewSync FRAT] Q${num} row not found`);
      return `Q${num} ✗`;
    }

    if (opts.value) {
      // Scored-select question (e.g. Q10 — number of legs)
      const sel = row.querySelector('mat-select[formcontrolname="value"]');
      if (sel) {
        await selectMatOption(sel, opts.value);
      } else {
        // Fallback: might still need to check the risk box even for value-select questions
        checkRiskBox(row);
      }
    } else if (opts.check) {
      checkRiskBox(row);
    }

    if (opts.mitigation) {
      const sel = row.querySelector('mat-select[formcontrolname="mitigation"]');
      if (sel) await selectMatOption(sel, opts.mitigation);
    }

    await new Promise(r => setTimeout(r, 150));
    return `Q${num} ✓`;
  }

  // ── Risk question evaluation ──────────────────────────────────────────────
  // Returns array of { num, check?, value?, mitigation? } for applicable questions.
  // Only returns entries for questions where the condition IS TRUE (risky).

  function evaluateRiskQuestions(flight, allFlights, weather, schedInfo, notams = []) {
    const { metar = {}, taf = {}, airports = {}, sunTimes } = weather;
    const dep = flight.departure_airport;
    const arr = flight.arrival_airport;
    // Use TAF forecast period at flight time when available, else fall back to METAR
    const depM = tafAtTime(taf[dep], new Date(flight.departure_time)) || metar[dep] || {};
    const arrM = tafAtTime(taf[arr], new Date(flight.arrival_time))   || metar[arr] || {};
    const depA = airports[dep] || {};
    const arrA = airports[arr] || {};

    const depTime = new Date(flight.departure_time);
    const arrTime = new Date(flight.arrival_time);

    // Flights within 20h of this departure = same duty period
    const dutyFlights = allFlights
      .filter(f => Math.abs(new Date(f.departure_time) - depTime) < 20 * 3600000)
      .sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));

    const results = [];
    const flag = (num, opts) => { if (opts) results.push({ num, ...opts }); };

    // ── Weather helpers ──────────────────────────────────────────────────────
    const hasWx = (m, ...codes) =>
      codes.some(c => new RegExp(`\\b${c}\\b`).test(m.wxString || ''));

    const hasFrozen = m => hasWx(m, 'SN', 'FZRA', 'FZDZ', 'PL', 'GR', 'GS', 'IC');
    const hasPrecip = m => hasWx(m, 'RA', 'DZ', 'SH', 'SHRA', 'TSRA') || hasFrozen(m);
    const hasTS     = m => hasWx(m, 'TS', 'TSRA', 'TSGR', 'TSPL', 'TSSN');
    const hasLiquid = m => hasWx(m, 'RA', 'DZ', 'SH', 'SHRA', 'TSRA');

    // cloudList.base is in hundreds of feet (METAR convention: BKN050 = 5000ft → base:50)
    // Q29 threshold: ceiling < 500ft = base < 5
    const hasCeilingBelow500 = m => m.cloudList?.some(c =>
      ['BKN', 'OVC'].includes(c.cover) && c.base < 5
    );

    // ── Schedule-derived ─────────────────────────────────────────────────────

    // Q6: Duty begins before 06:00 local
    flag(6, localHour(depTime, dep, depA.lon) < 6 ? { check: true } : null);

    // Q7: Duty ends after 22:00 local
    flag(7, localHour(arrTime, arr, arrA.lon) >= 22 ? { check: true } : null);

    // Q8: 12+ hours of continuous duty
    if (dutyFlights.length > 0) {
      const first = new Date(dutyFlights[0].departure_time);
      const last  = new Date(dutyFlights[dutyFlights.length - 1].arrival_time);
      flag(8, (last - first) / 3600000 >= 12 ? { check: true } : null);
    }

    // Q10: Number of legs (scored select — leave blank if ≤2)
    const legs = dutyFlights.length;
    if (legs >= 3) {
      const legStr = legs >= 6 ? '6 or more' : `${legs} legs`;
      flag(10, { value: legStr });
    }

    // Q19: Night landing (arrival after local sunset at destination)
    if (sunTimes?.sunrise && sunTimes?.sunset) {
      const nightStart = new Date(sunTimes.sunset.getTime()  + 60 * 60000); // sunset + 1h
      const nightEnd   = new Date(sunTimes.sunrise.getTime() - 60 * 60000); // sunrise - 1h
      const isNight    = arrTime > nightStart || arrTime < nightEnd;
      console.log(`[CrewSync FRAT] Q19: arrival=${arrTime.toUTCString()} night-start=${nightStart.toUTCString()} night-end=${nightEnd.toUTCString()} flagged=${isNight}`);
      flag(19, isNight ? { check: true } : null);
    }

    // Q32: Repositioning flight (zero passengers)
    flag(32, schedInfo.paxActual === 0 ? { check: true } : null);

    // Q41: Quick turn (≤30 min on ground before next leg)
    const thisIdx = dutyFlights.findIndex(f => f.id === flight.id);
    if (thisIdx >= 0 && thisIdx < dutyFlights.length - 1) {
      const gapMins = (new Date(dutyFlights[thisIdx + 1].departure_time) - arrTime) / 60000;
      flag(41, gapMins <= 30 ? { check: true } : null);
    }

    // ── Airport data ─────────────────────────────────────────────────────────

    // Q25: Destination elevation >5000 ft MSL
    flag(25, (arrA.elev || 0) > 5000 ? { check: true } : null);

    // Q30: Outside 48 contiguous states (AK, HI, international, territories)
    const C48 = new Set('AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
    const isOutside48 = (arrA.country && arrA.country !== 'US') ||
      (arrA.state && !C48.has(arrA.state));
    flag(30, isOutside48 ? { check: true } : null);

    // ── Weather ──────────────────────────────────────────────────────────────

    // Q26: Thunderstorms at departure or destination
    flag(26, (hasTS(depM) || hasTS(arrM)) ? { check: true } : null);

    // Q27: Wind gust factor ≥10 kt above steady wind
    const bigGust = m => m.wgst && m.wspd && (m.wgst - m.wspd) >= 10;
    flag(27, (bigGust(depM) || bigGust(arrM)) ? { check: true } : null);

    // Q29: Ceiling <500 ft AGL / visibility <1 SM at destination
    const lowIFR = (hasCeilingBelow500(arrM)) || (arrM.visib !== undefined && arrM.visib < 1);
    flag(29, lowIFR ? { check: true } : null);

    // Q34: De-icing required at departure (≤5°C + visible moisture)
    flag(34, (depM.temp !== undefined && depM.temp <= 5 && hasPrecip(depM)) ? { check: true } : null);

    // Q35: Frozen precipitation at departure or destination
    flag(35, (hasFrozen(depM) || hasFrozen(arrM)) ? { check: true } : null);

    // Q37: Wet runway at departure (liquid precip)
    flag(37, hasLiquid(depM) ? { check: true } : null);

    // Q38: Wet runway at arrival (liquid precip)
    flag(38, hasLiquid(arrM) ? { check: true } : null);

    // Q39: Contaminated runway at departure (frozen precip)
    flag(39, hasFrozen(depM) ? { check: true } : null);

    // Q40: Contaminated runway at arrival (frozen precip)
    flag(40, hasFrozen(arrM) ? { check: true } : null);

    // ── NOTAM-derived ────────────────────────────────────────────────────────
    if (notams.length > 0) {
      const depNotams = notams.filter(n => n.airport === dep);
      const arrNotams = notams.filter(n => n.airport === arr);
      const allNotams = notams;

      // Helpers for common NOTAM pattern matches
      const isRwyClsd  = n => /\bRWY\b.{0,30}\b(CLSD|CLOSED)\b/i.test(n.text) || (n.subjectCode === 'RW' && /CL/i.test(n.conditionCode || ''));
      const isConstr   = n => /\b(CONSTR|WIP|WORK IN PROG|WORK IN PROGRESS|CONSTRUCTION)\b/i.test(n.text);
      const isNoise    = n => /\b(NOISE ABATEMENT|NOISE RESTRICTION|CURFEW|QUIET HOURS)\b/i.test(n.text);
      const isTFR      = n => n.classification === 'FDC' && /\bTEMPORARY FLIGHT RESTRICTION\b|\bTFR\b/i.test(n.text);
      const isLgtgInop = n => /\b(PAPI|VASI|REIL|ODALS|ALSF|MALSR|ALS|LGTG|LIGHTING)\b.{0,40}\b(INOP|U\/S|UNUSBL|OUT OF SERVICE|NOT AVBL)\b/i.test(n.text);

      // Q15: Runway closure at departure airport
      flag(15, depNotams.some(isRwyClsd) ? { check: true } : null);

      // Q16: Runway closure at arrival airport
      flag(16, arrNotams.some(isRwyClsd) ? { check: true } : null);

      // Q17: Construction (either airport)
      flag(17, allNotams.some(isConstr) ? { check: true } : null);

      // Q18: Noise abatement / curfew restrictions (arrival airport)
      flag(18, arrNotams.some(isNoise) ? { check: true } : null);

      // Q31: TFR in effect (any FDC NOTAM)
      flag(31, allNotams.some(isTFR) ? { check: true } : null);

      // Q42: Approach/runway lighting inoperative at arrival
      flag(42, arrNotams.some(isLgtgInop) ? { check: true } : null);

      const notamHits = results.filter(r => [15,16,17,18,31,42].includes(r.num)).map(r => `Q${r.num}`);
      if (notamHits.length) console.log(`[CrewSync FRAT] NOTAM flags: ${notamHits.join(', ')}`);
    }

    console.log(`[CrewSync FRAT] Risk questions flagged: ${results.map(r => `Q${r.num}`).join(', ') || 'none'}`);
    return results;
  }

  // ── Form fill ─────────────────────────────────────────────────────────────

  async function fillFlight(flight, allFlights = []) {
    const log = [];

    // Kick off all slow fetches in parallel before touching the form
    const schedInfoPromise = fetchScheduleInfo(flight);
    const weatherPromise   = fetchWeatherAndAirports(
      flight.departure_airport, flight.arrival_airport, new Date(flight.arrival_time)
    );
    const notamsPromise = fetchNotams(flight.departure_airport, flight.arrival_airport);

    // ── Flight Date and ETD ────────────────────────────────────────────────
    const dateEl = inputByLabel('flight date and etd');
    if (dateEl) {
      const d = new Date(flight.departure_time);
      const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd   = String(d.getUTCDate()).padStart(2, '0');
      const yyyy = d.getUTCFullYear();
      const hh   = String(d.getUTCHours()).padStart(2, '0');
      const min  = String(d.getUTCMinutes()).padStart(2, '0');
      setAngularInput(dateEl, `${mm}/${dd}/${yyyy} ${hh}:${min}`);
      log.push('Date ✓');
    } else log.push('Date ✗');

    // ── Origin autocomplete ────────────────────────────────────────────────
    const originEl = inputByLabel('origin');
    if (originEl) { await setAutocomplete(originEl, flight.departure_airport); log.push('Origin ✓'); }
    else log.push('Origin ✗');

    // ── Destination autocomplete ───────────────────────────────────────────
    const destEl = inputByLabel('destination');
    if (destEl) { await setAutocomplete(destEl, flight.arrival_airport); log.push('Dest ✓'); }
    else log.push('Dest ✗');

    // ── Trip ID ───────────────────────────────────────────────────────────
    const tripEl = inputByLabel('trip id');
    if (tripEl && flight.trip) { setAngularInput(tripEl, flight.trip); log.push('Trip ID ✓'); }
    else if (!tripEl) log.push('Trip ID ✗');

    // ── Await all parallel fetches (schedule info + weather) ──────────────
    const [schedInfo, weather, notams] = await Promise.all([
      schedInfoPromise,
      weatherPromise,
      notamsPromise,
      new Promise(r => setTimeout(r, 400)), // let autocomplete panels settle
    ]);

    const { captain, paxActual } = schedInfo;

    function highlightField(info) {
      if (!info) return;
      const ff = info.el.closest('mat-form-field') || info.el.parentElement;
      if (!ff) return;
      const prev = ff.style.outline;
      ff.style.outline = '3px solid #f59e0b';
      setTimeout(() => { ff.style.outline = prev; }, 1200);
    }

    const allMs        = [...document.querySelectorAll('mat-select')];
    const aircraftInfo = findAnySelect('aircraft');
    const tsaInfo      = findAnySelect('tsa vetting') || findAnySelect('part 135 tsa vetting');
    const fitInfo      = findAnySelect('physically and mentally fit') || findAnySelect('fit to fly safely');
    const restInfo     = findAnySelect('time zones') || findAnySelect('rest time equal');
    let picInfo        = findAnySelect('pic');

    let sicInfo = null;
    if (picInfo && picInfo.kind === 'mat') {
      const picIdx = allMs.indexOf(picInfo.el);
      if (picIdx >= 0 && picIdx + 1 < allMs.length) {
        const candidate = allMs[picIdx + 1];
        if (candidate !== picInfo.el && candidate !== aircraftInfo?.el)
          sicInfo = { el: candidate, kind: 'mat' };
      }
    }
    if (!sicInfo) sicInfo = findAnySelect('sic');
    if (!picInfo && sicInfo) {
      const sicIdx = allMs.indexOf(sicInfo.el);
      if (sicIdx > 0 && allMs[sicIdx - 1] !== aircraftInfo?.el) {
        picInfo = { el: allMs[sicIdx - 1], kind: 'mat' };
        console.log('[CrewSync FRAT] PIC derived as SIC-1 (label search failed)');
      }
    }

    // PIC
    if (captain && picInfo) {
      highlightField(picInfo);
      const ok = await selectAnyOption(picInfo, captain.split(' ').pop());
      log.push('PIC ' + (ok ? `✓ (${captain})` : `✗ (${captain} not in list)`));
    } else if (!captain) {
      log.push('PIC — manual (not on schedule)');
    } else {
      log.push('PIC ✗ (field not found)');
    }

    // SIC (Kyle)
    if (sicInfo) {
      highlightField(sicInfo);
      const ok = await selectAnyOption(sicInfo, SIC_NAME);
      log.push('SIC ' + (ok ? '✓' : '✗'));
    } else log.push('SIC ✗');

    // Aircraft — filled LAST so PIC/SIC changes can't blank it
    if (aircraftInfo && flight.tail) {
      highlightField(aircraftInfo);
      const ok = await selectAnyOption(aircraftInfo, flight.tail);
      log.push('Aircraft ' + (ok ? '✓' : '✗'));
    } else if (!aircraftInfo) log.push('Aircraft ✗');

    // TSA Vetting
    if (tsaInfo) {
      highlightField(tsaInfo);
      const ok = await selectAnyOption(tsaInfo, 'Completed');
      log.push('TSA ' + (ok ? '✓' : '✗'));
    } else log.push('TSA ✗');

    // Fit to fly — always Yes
    if (fitInfo) {
      highlightField(fitInfo);
      const ok = await selectAnyOption(fitInfo, 'Yes');
      log.push('Fit ✓');
    } else log.push('Fit ✗');

    // Rest time after time zones
    if (restInfo) {
      highlightField(restInfo);
      const ok = await selectAnyOption(restInfo, '14 hours');
      log.push('Rest ✓');
    } else log.push('Rest ✗');

    // ── Risk questions ────────────────────────────────────────────────────
    const riskEvals = evaluateRiskQuestions(flight, allFlights, weather, schedInfo, notams);

    if (riskEvals.length > 0) {
      for (const ev of riskEvals) {
        const result = await fillRiskQuestion(ev.num, ev);
        log.push(result);
      }
    } else {
      log.push('Risks: none flagged');
    }

    if (paxActual !== null) log.push(`PAX=${paxActual}`);

    console.log('[CrewSync FRAT] Fill result:', log.join(', '));
    return log;
  }

  // ── Panel UI ───────────────────────────────────────────────────────────────

  const PANEL_ID = 'cs-frat-panel';

  function buildPanel(flights) {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    // Show only upcoming legs in the panel (≤2h in the past); keep all for risk eval
    const upcoming = flights
      .filter(f => new Date(f.departure_time) >= Date.now() - 2 * 3600_000)
      .slice(0, 12);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', top: '72px', right: '18px', zIndex: '2147483647',
      background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: '16px',
      padding: '14px 14px 10px', width: '300px',
      boxShadow: '0 12px 40px rgba(0,0,0,.65)',
      fontFamily: 'system-ui,-apple-system,sans-serif', fontSize: '13px', lineHeight: '1.4',
    });

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.1em">
          ✈ CrewSync — Select Leg
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          <span id="cs-status" style="font-size:11px;color:#10b981;display:none"></span>
          <button id="cs-debug" title="Debug — dump selectors to console"
            style="background:none;border:1px solid #334155;color:#475569;cursor:pointer;font-size:10px;border-radius:5px;padding:2px 5px">dbg</button>
          <button id="cs-close"
            style="background:none;border:none;color:#475569;cursor:pointer;font-size:20px;line-height:1;padding:0 2px">×</button>
        </div>
      </div>
      <div style="font-size:10px;color:#475569;margin-bottom:10px">
        Date · Origin · Dest · Trip · PIC · SIC · Aircraft · TSA + risk questions
      </div>
      <div id="cs-legs"></div>
      <div style="font-size:10px;color:#334155;margin-top:8px;border-top:1px solid #1e293b;padding-top:8px">
        PIC + risk from schedule/weather — verify before submit
      </div>
    `;

    const legsEl = panel.querySelector('#cs-legs');
    const status = panel.querySelector('#cs-status');

    if (!upcoming.length) {
      legsEl.innerHTML = '<div style="color:#475569;text-align:center;padding:16px 0;font-size:12px">No upcoming flights in schedule</div>';
    }

    upcoming.forEach(f => {
      const card = document.createElement('div');
      Object.assign(card.style, {
        padding: '10px 13px', borderRadius: '10px',
        border: '1px solid #1e293b', background: '#1e293b',
        cursor: 'pointer', marginBottom: '6px',
        transition: 'background .12s, border-color .12s',
      });
      card.onmouseenter = () => { if (!card.dataset.done) { card.style.background = '#1e3a5f'; card.style.borderColor = '#3b82f6'; } };
      card.onmouseleave = () => { if (!card.dataset.done) { card.style.background = '#1e293b'; card.style.borderColor = '#1e293b'; } };
      card.innerHTML = `
        <div id="cs-route-${f.id}" style="font-weight:700;font-size:16px;color:#f1f5f9;letter-spacing:.01em">
          ${f.departure_airport} <span style="color:#3b82f6">→</span> ${f.arrival_airport}
        </div>
        <div id="cs-meta-${f.id}" style="font-size:10px;color:#64748b;margin-top:3px">
          ${fmtFlight(f)}${f.tail ? ' · ' + f.tail : ''}${f.trip ? ' · ' + f.trip : ''}
        </div>
      `;

      card.onclick = async () => {
        if (card.dataset.done) return;
        card.dataset.done = '1';
        card.style.background = '#1e3a5f';
        card.style.borderColor = '#3b82f6';
        status.textContent = 'Filling…';
        status.style.display = 'block';

        const log = await fillFlight(f, flights); // pass ALL flights for duty-day context
        const allOk = log.every(l => !l.includes('✗'));

        card.style.background  = allOk ? '#064e3b' : '#3b1f00';
        card.style.borderColor = allOk ? '#10b981'  : '#f59e0b';
        document.getElementById(`cs-route-${f.id}`).style.color = allOk ? '#34d399' : '#fbbf24';
        document.getElementById(`cs-meta-${f.id}`).textContent  = log.join(' · ');
        document.getElementById(`cs-meta-${f.id}`).style.color  = allOk ? '#4ade80' : '#fbbf24';
        status.textContent = allOk ? '✓ Done' : '⚠ Partial — check console';
        status.style.color = allOk ? '#10b981' : '#f59e0b';
      };

      legsEl.appendChild(card);
    });

    document.body.appendChild(panel);
    panel.querySelector('#cs-close').onclick = () => panel.remove();
    panel.querySelector('#cs-debug').onclick  = () => debugDump();
  }

  // ── Loading / error panels ────────────────────────────────────────────────

  function buildLoadingPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', top: '72px', right: '18px', zIndex: '2147483647',
      background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: '16px',
      padding: '14px', width: '220px', boxShadow: '0 8px 24px rgba(0,0,0,.5)',
      fontFamily: 'system-ui,sans-serif', fontSize: '12px', color: '#475569',
    });
    panel.innerHTML = '<div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">✈ CrewSync</div>Loading schedule…';
    document.body.appendChild(panel);
    return panel;
  }

  // ── waitFor helper ────────────────────────────────────────────────────────

  function waitFor(sel, timeout = 15000) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        if (document.querySelector(sel)) return res();
        if (Date.now() - t0 > timeout) return rej('Timeout: ' + sel);
        setTimeout(poll, 300);
      })();
    });
  }

  // ── Main ─────────────────────────────────────────────────────────────────

  async function main() {
    try {
      await waitFor('mat-form-field, input[type=text]');
      await new Promise(r => setTimeout(r, 1200));

      const loadingPanel = buildLoadingPanel();

      let flights;
      try {
        flights = await fetchFlights();
      } catch (e) {
        loadingPanel.innerHTML = `
          <div style="font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">✈ CrewSync</div>
          <div style="color:#64748b;font-size:12px">Could not reach server.<br>Check VPN / connection.</div>
        `;
        console.error('[CrewSync FRAT]', e);
        return;
      }

      loadingPanel.remove();
      buildPanel(flights);
    } catch (e) {
      console.error('[CrewSync FRAT]', e);
    }
  }

  main();
})();
