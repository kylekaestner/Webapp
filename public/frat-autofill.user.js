// ==UserScript==
// @name         CrewSync FRAT Autofill
// @namespace    https://crewsync.spiritjets.com/
// @version      2.9
// @description  Prefills Date, Origin, Dest, Trip ID, PIC, SIC, Aircraft, TSA from CrewSync + Schedaero
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
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SERVER      = 'http://167.71.107.245:3000';
  const PILOT       = 'kyle';
  const SIC_NAME    = 'Kaestner'; // Kyle's last name as it appears in SIC dropdown
  const COMPANY_CAL = 'https://schedaero.avinode.com/mvc/api/calendars/main/5678';

  // Captain name lookup by Schedaero 3-letter initials
  const CREW_NAMES = {
    HSB: 'Hans Brosbol',   TJB: 'Thomas Bressie', MEV: 'Martin Valla',
    JAL: 'Lonnie Legner',  AJB: 'Aleks Biteman',  TAJ: 'Tyler Johnson',
    LWK: 'Luke Knudsvig',  GWM: 'Greg Medsker',
  };

  // ── Input finders ─────────────────────────────────────────────────────────

  // Returns the text of the label associated with a mat-form-field containing el
  function matFieldLabel(ff) {
    const ml = ff.querySelector('mat-label');
    if (ml) return ml.textContent.replace(/\*/g, '').trim().toLowerCase();
    // Some Prism SMS fields use a plain <label> inside the form field wrapper
    const lbl = ff.querySelector('label');
    if (lbl) return lbl.textContent.replace(/\*/g, '').trim().toLowerCase();
    return '';
  }

  // Find an <input> whose Angular Material form-field has a label matching text
  function inputByLabel(text) {
    const t = text.toLowerCase();
    // Strategy 1 — mat-form-field with mat-label or label child
    for (const ff of document.querySelectorAll('mat-form-field')) {
      if (matFieldLabel(ff) === t) {
        return ff.querySelector('input:not([type=hidden])') || null;
      }
    }
    // Strategy 2 — HTML <label for="...">
    for (const lbl of document.querySelectorAll('label')) {
      const lblTxt = lbl.textContent.replace(/\*/g, '').trim().toLowerCase();
      if (lblTxt === t && lbl.htmlFor) {
        return document.getElementById(lbl.htmlFor) || null;
      }
    }
    // Strategy 3 — find the label text element, then walk UP looking for a
  //   container that has EXACTLY 1 visible input. This prevents grabbing the
  //   wrong field when labels are in a multi-column row (e.g. Trip ID label
  //   found, but row container's first input is the Flight Date field).
  const all = document.querySelectorAll('label, mat-label, span, div, p, th');
  for (const el of all) {
    if (el.children.length > 2) continue; // skip composite containers
    const txt = el.textContent.replace(/\*/g, '').trim().toLowerCase();
    if (txt !== t) continue;

    let container = el.parentElement;
    for (let i = 0; i < 4 && container; i++) {
      const inputs = [...container.querySelectorAll(
        'input:not([type=hidden]):not([type=checkbox]):not([type=radio])'
      )];
      if (inputs.length === 1) return inputs[0]; // unique — this is the right column
      // Multiple inputs means we're in a row/section spanning columns — go higher
      container = container.parentElement;
    }
  }
  return null;
}

  // Find any select element (mat-select OR native <select>) for the given label text.
  // Returns { el, kind: 'mat'|'native' } or null.
  function findAnySelect(text) {
    const t = text.toLowerCase();

    // ── mat-select strategies ──────────────────────────────────────────────
    // S1: exact mat-form-field label
    for (const ff of document.querySelectorAll('mat-form-field')) {
      if (matFieldLabel(ff) === t) {
        const s = ff.querySelector('mat-select');
        if (s) return { el: s, kind: 'mat' };
      }
    }
    // S2: partial match on mat-form-field label
    for (const ff of document.querySelectorAll('mat-form-field')) {
      const lbl = matFieldLabel(ff);
      if (!lbl) continue;
      if (lbl.includes(t) || (lbl.length >= 2 && t.includes(lbl))) {
        const s = ff.querySelector('mat-select');
        if (s) return { el: s, kind: 'mat' };
      }
    }
    // S3: formcontrolname / ng-reflect-name on mat-select
    // Require name length >= 3 to avoid matching short substrings ('ic', 'pi')
    for (const s of document.querySelectorAll('mat-select')) {
      const name = (s.getAttribute('formcontrolname') ||
                    s.getAttribute('ng-reflect-name') || '').toLowerCase();
      if (name && name.length >= 3 && (name === t || name.includes(t) || t.includes(name))) return { el: s, kind: 'mat' };
    }
    // S4: word-boundary label search across ALL text-bearing elements, including
    //     table cells (td/th) which the previous version missed.
    //     Skips elements that contain an input/select (those are data cells, not labels).
    const termRegex = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const allSelects = [
      ...[...document.querySelectorAll('mat-select')].map(s => ({ el: s, kind: 'mat' })),
      ...[...document.querySelectorAll('select')].map(s => ({ el: s, kind: 'native' })),
    ];

    for (const el of document.querySelectorAll(
      'label, mat-label, span, div, p, td, th, h4, h5, h6'
    )) {
      // Skip data cells — cells that contain an input or select are not labels
      if (el.querySelector('mat-select, select, input:not([type=hidden])')) continue;
      const txt = el.textContent.replace(/\*/g, '').trim();
      if (!termRegex.test(txt)) continue;

      // Find all selects that come AFTER this label in document order
      const following = allSelects.filter(({ el: s }) =>
        el.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (following.length) return following[0]; // closest = first in DOM order
    }

    return null;
  }

  // Kept for backwards compat within selectMatOption
  function selectByLabel(text) {
    const r = findAnySelect(text);
    return (r && r.kind === 'mat') ? r.el : null;
  }

  // ── Angular-aware value setter ────────────────────────────────────────────

  function setAngularInput(el, value) {
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    ['focus', 'input', 'change', 'blur'].forEach(ev =>
      el.dispatchEvent(new Event(ev, { bubbles: true }))
    );
  }

  // Set a text input that has an autocomplete dropdown.
  // Types the value, waits for mat-option panel, clicks the best match.
  async function setAutocomplete(el, value) {
    if (!el) return false;
    el.focus();
    setAngularInput(el, value);
    // Wait for the autocomplete panel to appear
    await new Promise(r => setTimeout(r, 700));
    const opts = [...document.querySelectorAll('mat-option')].filter(
      o => o.offsetParent !== null // visible only
    );
    if (!opts.length) return true; // no autocomplete — plain text fill is enough
    // Prefer option whose text contains the value; otherwise take first
    const match = opts.find(o => o.textContent.includes(value)) || opts[0];
    match.click();
    await new Promise(r => setTimeout(r, 200));
    return true;
  }

  // Select an option in either a mat-select or a native <select>
  async function selectAnyOption(info, search) {
    if (!info) return false;
    const { el, kind } = info;

    if (kind === 'native') {
      const opts = [...el.options];
      const match = opts.find(o => o.text.toLowerCase().includes(search.toLowerCase()));
      if (!match) {
        console.log(`[CrewSync FRAT] No match for "${search}" in native select. Options:`, opts.map(o => o.text.trim()));
        return false;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, match.value);
      ['change', 'input'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
      return true;
    }

    return selectMatOption(el, search); // mat-select path
  }

  // Close whatever Angular CDK overlay is currently open
  function closeCdkOverlay() {
    // Escape key is the most reliable way to close mat-select panels
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    // Also click the backdrop as a fallback
    const backdrop = document.querySelector('.cdk-overlay-backdrop');
    if (backdrop) backdrop.click();
  }

  // Click a mat-select open, optionally type in its search box, then pick option
  async function selectMatOption(selectEl, search) {
    if (!selectEl) return false;

    closeCdkOverlay();
    await new Promise(r => setTimeout(r, 250));

    const trigger = selectEl.querySelector('.mat-select-trigger') || selectEl;
    trigger.click();
    await new Promise(r => setTimeout(r, 450));

    // If the CURRENTLY VISIBLE panel has a search/filter input, type to narrow the list.
    // Aircraft needs this — not all tail numbers are rendered until filtered.
    // IMPORTANT: must filter to visible inputs only — a closed panel's input can
    // still be in the DOM and would otherwise be found first by querySelector.
    const panelSearch = [...document.querySelectorAll(
      '.mat-select-panel input, mat-select-search input, [class*="select-search"] input'
    )].find(el => el.offsetParent !== null); // offsetParent null = hidden/detached
    if (panelSearch) {
      panelSearch.focus();
      setAngularInput(panelSearch, search);
      await new Promise(r => setTimeout(r, 600));
    }

    const opts = [...document.querySelectorAll('mat-option')];
    const match = opts.find(o => o.textContent.toLowerCase().includes(search.toLowerCase()));
    if (match) { match.click(); return true; }

    // If exactly 1 option is visible and it's not a "no results" placeholder, click it.
    // Handles fields like TSA Vetting where the only option has unexpected casing/phrasing.
    const realOpts = opts.filter(o => !o.classList.contains('mat-option-disabled') &&
      !o.textContent.trim().toLowerCase().startsWith('no '));
    if (realOpts.length === 1) {
      console.log(`[CrewSync FRAT] No text match for "${search}" — clicking sole option: "${realOpts[0].textContent.trim()}"`);
      realOpts[0].click();
      return true;
    }

    const optTexts = opts.map(o => `"${o.textContent.trim()}"`).join(' | ');
    console.log(`[CrewSync FRAT] No match for "${search}". Options: ${optTexts}`);
    closeCdkOverlay();
    return false;
  }

  // ── Debug: dump form state as plain inline strings (no collapsed Objects) ─

  function debugDump() {
    const allMs = [...document.querySelectorAll('mat-select')];

    // ── 1. ALL mat-selects in document order ──────────────────────────────
    console.group(`[CrewSync FRAT] ALL mat-selects (${allMs.length} total) — full list:`);
    allMs.forEach((sel, idx) => {
      const fc  = sel.getAttribute('formcontrolname') || sel.getAttribute('ng-reflect-name') || '(none)';
      const val = sel.querySelector('.mat-select-value-text')?.textContent.trim() || '(empty)';
      const ff  = sel.closest('mat-form-field');
      const ffl = ff ? (matFieldLabel(ff) || '(no ff-label)') : '(not in ff)';
      // Find nearest preceding text node as label hint
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

    // ── 2. findAnySelect results for key fields ────────────────────────────
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

    // ── 3. Visible text inputs ─────────────────────────────────────────────
    const inputs = [...document.querySelectorAll(
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio])'
    )].filter(i => i.offsetParent !== null);
    console.group(`[CrewSync FRAT] Visible inputs (${inputs.length}):`);
    inputs.forEach((inp, idx) => {
      const ff  = inp.closest('mat-form-field');
      const lbl = ff
        ? (ff.querySelector('mat-label')?.textContent.trim() ||
           ff.querySelector('label')?.textContent.trim() || '(no ff-label)')
        : (document.querySelector(`label[for="${inp.id}"]`)?.textContent.trim() || '(no label)');
      console.log(
        `[${idx}] label="${lbl}" | id="${inp.id || '(none)'}" | fc="${inp.getAttribute('formcontrolname') || '(none)'}" | placeholder="${inp.placeholder || ''}" | val="${inp.value}"`
      );
    });
    console.groupEnd();

    // ── 4. mat-label elements present ─────────────────────────────────────
    const matLabels = [...document.querySelectorAll('mat-label')];
    console.log(`[CrewSync FRAT] mat-label count: ${matLabels.length}`,
      matLabels.length ? matLabels.map(l => `"${l.textContent.trim()}"`).join(', ') : '(none — form uses plain text labels)');

    alert('CrewSync debug info written to browser console (F12 → Console).\nShare the output with Kyle.');
  }

  // ── Date / time formatting ────────────────────────────────────────────────

  function fmtFlight(seg) {
    const dep = new Date(seg.departure_time); // UTC, ends in Z
    const opts = { timeZone: 'America/Chicago' };
    return dep.toLocaleDateString('en-US', { ...opts, weekday: 'short', month: 'short', day: 'numeric' })
      + ' · '
      + dep.toLocaleTimeString('en-US', { ...opts, hour: '2-digit', minute: '2-digit', hour12: false })
      + ' CT';
  }

  // Extract all BottomLeft crew strings from a Schedaero calendar response.
  // Handles both raw XML ("<BottomLeft>TJB/KDK</BottomLeft>") and JSON
  // ({"BottomLeft":"TJB/KDK",...}) — Schedaero returns JSON when the request
  // comes from a script rather than a browser page navigation.
  function extractBottomLeft(text) {
    const hits = [];
    // Try JSON first (most likely format for programmatic AJAX requests)
    try {
      const data = JSON.parse(text);
      const scan = v => {
        if (!v || typeof v !== 'object') return;
        // Check both PascalCase (C#/.NET default) and camelCase
        if (v.BottomLeft) hits.push(String(v.BottomLeft).trim());
        else if (v.bottomLeft) hits.push(String(v.bottomLeft).trim());
        (Array.isArray(v) ? v : Object.values(v)).forEach(scan);
      };
      scan(data);
      return hits; // return even if empty — we know it was JSON
    } catch (_) {}
    // Fall back to XML/HTML regex for raw XML responses
    for (const m of text.matchAll(/<BottomLeft[^>]*>([^<]*)<\/BottomLeft>/gi)) {
      if (m[1].trim()) hits.push(m[1].trim());
    }
    return hits;
  }

  // ── Fetch captain from Schedaero company calendar ─────────────────────────
  // Uses your live browser session cookies (no server restart needed).

  function fetchCaptain(flight) {
    const date = new Date(flight.departure_time).toISOString().slice(0, 10);
    const url  = `${COMPANY_CAL}/${date}?ajax=true&_=${Date.now()}`;
    console.log('[CrewSync FRAT] Fetching company cal:', url);
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method:  'GET',
        url,
        timeout: 8000,
        onload(r) {
          try {
            if (r.status !== 200) {
              console.log(`[CrewSync FRAT] Company cal HTTP ${r.status} — are you logged into Schedaero?`);
              resolve(null);
              return;
            }

            // Log the raw response so we can see what format Schedaero actually returns
            console.log('[CrewSync FRAT] Company cal response (first 400 chars):', r.responseText.slice(0, 400));

            // Extract all BottomLeft values — handles both JSON and XML responses.
            // Schedaero AJAX returns JSON when fetched programmatically; the browser
            // renders it as XML but the wire format is JSON with PascalCase field names.
            const allBL = extractBottomLeft(r.responseText);
            console.log(`[CrewSync FRAT] BottomLeft values on ${date}: ${allBL.join(' | ') || '(none)'}`);

            for (const crew of allBL) {
              const parts     = crew.split('/');
              const captInit  = parts[0].trim().toUpperCase();
              const sicInit   = (parts[1] || '').trim().toUpperCase();
              if (sicInit === 'KDK' && captInit.length >= 2) {
                const captainName = CREW_NAMES[captInit];
                console.log(`[CrewSync FRAT] Captain: ${captInit} = ${captainName || '(unknown — add to CREW_NAMES)'}`);
                resolve(captainName || null);
                return;
              }
            }
            console.log('[CrewSync FRAT] No KDK-as-SIC entry found for', date);
            resolve(null);
          } catch (e) {
            console.log('[CrewSync FRAT] Company cal parse error:', e.message);
            resolve(null);
          }
        },
        onerror:   () => { console.log('[CrewSync FRAT] Company cal network error'); resolve(null); },
        ontimeout: () => { console.log('[CrewSync FRAT] Company cal timeout'); resolve(null); },
      });
    });
  }

  // ── Fetch upcoming legs ────────────────────────────────────────────────────

  function fetchFlights() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'GET',
        url:     `${SERVER}/api/pilots/${PILOT}`,
        timeout: 10000,
        onload(r) {
          try {
            const data = JSON.parse(r.responseText);
            const cutoff = Date.now() - 2 * 3600_000;
            const flights = (data.segments || [])
              .filter(s =>
                s.type === 'flight' &&
                s.departure_airport && s.arrival_airport && s.departure_time &&
                new Date(s.departure_time).getTime() >= cutoff
              )
              .sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time))
              .slice(0, 12);
            resolve(flights);
          } catch (e) { reject(e); }
        },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  // ── Form fill ─────────────────────────────────────────────────────────────

  async function fillFlight(flight) {
    const log = [];

    // Start company crew fetch immediately — runs in parallel with text-field filling
    const captainPromise = fetchCaptain(flight);

    // ── Flight Date and ETD ────────────────────────────────────────────────
    const dateEl = inputByLabel('flight date and etd');
    if (dateEl) {
      const d = new Date(flight.departure_time); // UTC
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

    // ── Trip ID (plain text) ───────────────────────────────────────────────
    const tripEl = inputByLabel('trip id');
    if (tripEl && flight.trip) { setAngularInput(tripEl, flight.trip); log.push('Trip ID ✓'); }
    else if (!tripEl) log.push('Trip ID ✗');

    // ── Wait for captain lookup + any autocomplete panels to close ─────────
    const [captain] = await Promise.all([
      captainPromise,
      new Promise(r => setTimeout(r, 400)),
    ]);

    // Briefly outline a field so the user can see which element is being targeted
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

    // SIC = mat-select immediately after PIC in document order
    let sicInfo = null;
    if (picInfo && picInfo.kind === 'mat') {
      const picIdx = allMs.indexOf(picInfo.el);
      if (picIdx >= 0 && picIdx + 1 < allMs.length) {
        const candidate = allMs[picIdx + 1];
        if (candidate !== picInfo.el && candidate !== aircraftInfo?.el) {
          sicInfo = { el: candidate, kind: 'mat' };
        }
      }
    }
    if (!sicInfo) sicInfo = findAnySelect('sic');

    // PIC = mat-select immediately before SIC — guaranteed anchor when label search fails.
    // SIC is known-good (fills Kyle correctly), so SIC-1 must be PIC.
    if (!picInfo && sicInfo) {
      const sicIdx = allMs.indexOf(sicInfo.el);
      if (sicIdx > 0 && allMs[sicIdx - 1] !== aircraftInfo?.el) {
        picInfo = { el: allMs[sicIdx - 1], kind: 'mat' };
        console.log('[CrewSync FRAT] PIC derived as SIC-1 (label search failed)');
      }
    }

    const labelOf = info => {
      if (!info) return 'NOT FOUND';
      const ff = info.el.closest('mat-form-field');
      return `${info.kind} · label="${matFieldLabel(ff) || '(none)'}" · idx=${allMs.indexOf(info.el)}`;
    };
    console.log(
      `[CrewSync FRAT] Selects resolved:\n` +
      `  aircraft: ${labelOf(aircraftInfo)}\n` +
      `  pic:      ${labelOf(picInfo)}\n` +
      `  sic:      ${labelOf(sicInfo)}\n` +
      `  tsa:      ${labelOf(tsaInfo)}\n` +
      `  fit:      ${labelOf(fitInfo)}\n` +
      `  restTime: ${labelOf(restInfo)}`
    );

    // ── Fill order: PIC → SIC → Aircraft (last — Angular blanks it on crew changes) → TSA

    // PIC — captain from company schedule
    if (captain && picInfo) {
      highlightField(picInfo);
      // Search by last name for dropdown format flexibility (e.g. "Brosbol, Hans" or "Hans Brosbol")
      const lastName = captain.split(' ').pop();
      const ok = await selectAnyOption(picInfo, lastName);
      log.push('PIC ' + (ok ? `✓ (${captain})` : `✗ (${captain} not in list)`));
    } else if (!captain) {
      log.push('PIC — manual (not on company schedule today)');
    } else {
      log.push('PIC ✗ (field not found)');
    }

    // SIC — Kyle
    if (sicInfo) {
      highlightField(sicInfo);
      const ok = await selectAnyOption(sicInfo, SIC_NAME);
      log.push('SIC ' + (ok ? '✓' : '✗'));
    } else log.push('SIC ✗ (not found)');

    // Aircraft — filled LAST so PIC/SIC changes can't blank it afterward
    if (aircraftInfo && flight.tail) {
      highlightField(aircraftInfo);
      const ok = await selectAnyOption(aircraftInfo, flight.tail);
      log.push('Aircraft ' + (ok ? '✓' : '✗'));
    } else if (!aircraftInfo) log.push('Aircraft ✗ (not found)');

    // TSA Vetting
    if (tsaInfo) {
      highlightField(tsaInfo);
      const ok = await selectAnyOption(tsaInfo, 'Completed');
      log.push('TSA ' + (ok ? '✓' : '✗'));
    } else log.push('TSA ✗ (not found)');

    // Fit to fly — always Yes
    if (fitInfo) {
      highlightField(fitInfo);
      const ok = await selectAnyOption(fitInfo, 'Yes');
      log.push('Fit to fly ' + (ok ? '✓' : '✗'));
    } else log.push('Fit to fly ✗ (not found)');

    // Rest time after crossing time zones
    if (restInfo) {
      highlightField(restInfo);
      const ok = await selectAnyOption(restInfo, '14 hours');
      log.push('Rest time ' + (ok ? '✓' : '✗'));
    } else log.push('Rest time ✗ (not found)');

    console.log('[CrewSync FRAT] Fill result:', log.join(', '));
    return log;
  }

  // ── Panel UI ───────────────────────────────────────────────────────────────

  const PANEL_ID = 'cs-frat-panel';

  function buildPanel(flights) {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

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
        Fills: Date · Origin · Dest · Trip ID · PIC · SIC · Aircraft · TSA
      </div>
      <div id="cs-legs"></div>
      <div style="font-size:10px;color:#334155;margin-top:8px;border-top:1px solid #1e293b;padding-top:8px">
        PIC auto-filled from company schedule · verify before submit
      </div>
    `;

    const legsEl = panel.querySelector('#cs-legs');
    const status = panel.querySelector('#cs-status');

    if (!flights.length) {
      legsEl.innerHTML = '<div style="color:#475569;text-align:center;padding:16px 0;font-size:12px">No upcoming flights in schedule</div>';
    }

    flights.forEach(f => {
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

        const log = await fillFlight(f);
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
