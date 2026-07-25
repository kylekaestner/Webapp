// ==UserScript==
// @name         CrewSync FRAT Autofill
// @namespace    https://crewsync.spiritjets.com/
// @version      1.9
// @description  Prefills Origin, Destination, Trip ID, and SIC from your CrewSync schedule
// @author       Kyle Kaestner
// @match        https://prismsms.argus.aero/tools/frat-landing/frat-report/*/add
// @match        https://prismsms.argus.aero/tools/frat-landing/frat-report/*/edit
// @updateURL    http://167.71.107.245:3000/frat-autofill.user.js
// @downloadURL  http://167.71.107.245:3000/frat-autofill.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      167.71.107.245
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SERVER   = 'http://167.71.107.245:3000';
  const PILOT    = 'kyle';
  const SIC_NAME = 'Kaestner';

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
    for (const s of document.querySelectorAll('mat-select')) {
      const name = (s.getAttribute('formcontrolname') ||
                    s.getAttribute('ng-reflect-name') || '').toLowerCase();
      if (name && (name === t || name.includes(t) || t.includes(name))) return { el: s, kind: 'mat' };
    }
    // S4: find label text element, then return the NEAREST select/mat-select
    //     that follows it in DOM order. This is critical for two-column layouts
    //     (PIC / SIC side by side) where walking UP the tree returns the wrong
    //     (first) select in the shared row container.
    const allSelects = [
      ...[...document.querySelectorAll('mat-select')].map(s => ({ el: s, kind: 'mat' })),
      ...[...document.querySelectorAll('select')].map(s => ({ el: s, kind: 'native' })),
    ];

    for (const el of document.querySelectorAll('label, mat-label, span, div, p, h4, h5, h6')) {
      if (el.children.length > 2) continue;
      const txt = el.textContent.replace(/\*/g, '').trim().toLowerCase();
      if (txt !== t && !txt.includes(t)) continue;

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

    // If the panel has a search/filter input, type the search term to narrow the list.
    // Aircraft uses this — all tail numbers are options but only some are rendered.
    const panelSearch = document.querySelector(
      '.mat-select-panel input, mat-select-search input, ' +
      '[class*="select-search"] input, .mat-autocomplete-panel ~ * input'
    );
    if (panelSearch) {
      panelSearch.focus();
      setAngularInput(panelSearch, search);
      await new Promise(r => setTimeout(r, 600)); // wait for filter to apply
    }

    const opts = [...document.querySelectorAll('mat-option')];
    const match = opts.find(o => o.textContent.toLowerCase().includes(search.toLowerCase()));
    if (match) { match.click(); return true; }

    console.log(`[CrewSync FRAT] No match for "${search}". Options:`,
      opts.map(o => o.textContent.trim()));
    closeCdkOverlay();
    return false;
  }

  // ── Debug: log every visible input and its context ────────────────────────

  function debugDump() {
    const inputs = [...document.querySelectorAll(
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio])'
    )].filter(i => i.offsetParent !== null);

    console.group('[CrewSync FRAT] Visible inputs:');
    inputs.forEach((inp, idx) => {
      const ff  = inp.closest('mat-form-field');
      const lbl = ff
        ? (ff.querySelector('mat-label')?.textContent.trim() ||
           ff.querySelector('label')?.textContent.trim() || '(none)')
        : (document.querySelector(`label[for="${inp.id}"]`)?.textContent.trim() || '(none)');
      console.log(idx, {
        label: lbl,
        id:    inp.id   || '(none)',
        name:  inp.name || '(none)',
        placeholder: inp.placeholder || '(none)',
        'aria-label': inp.getAttribute('aria-label') || '(none)',
        formcontrolname: inp.getAttribute('formcontrolname') || '(none)',
        type:  inp.type || 'text',
        value: inp.value,
      });
    });
    console.groupEnd();

    const matLabels = [...document.querySelectorAll('mat-label')];
    console.group('[CrewSync FRAT] mat-label texts:');
    matLabels.forEach(l => console.log(`"${l.textContent.trim()}"`, '→ parent:', l.parentElement?.tagName));
    console.groupEnd();

    // Dump all mat-select fields
    console.group('[CrewSync FRAT] mat-select fields:');
    document.querySelectorAll('mat-form-field').forEach((ff, idx) => {
      const sel = ff.querySelector('mat-select');
      if (!sel) return;
      const lbl = matFieldLabel(ff) || '(no label)';
      const val = sel.querySelector('.mat-select-value-text')?.textContent.trim() || '(empty)';
      const fc = sel.getAttribute('formcontrolname') || '(none)';
      console.log(idx, { label: lbl, formcontrolname: fc, currentValue: val });
    });
    console.groupEnd();

    // Dump native <select> fields
    console.group('[CrewSync FRAT] native <select> fields:');
    document.querySelectorAll('select').forEach((sel, idx) => {
      const lbl = document.querySelector(`label[for="${sel.id}"]`)?.textContent.trim() ||
        sel.closest('[class*="field"], [class*="form"], [class*="group"]')
          ?.querySelector('label, span, div')?.textContent.trim() || '(no label)';
      const fc = sel.getAttribute('formcontrolname') || sel.getAttribute('ng-reflect-name') || '(none)';
      console.log(idx, { label: lbl.substring(0, 60), formcontrolname: fc,
        currentValue: sel.options[sel.selectedIndex]?.text || '(none)',
        optionCount: sel.options.length });
    });
    console.groupEnd();

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

    // ── Flight Date and ETD (UTC format matching the "(GMT) GMT" label) ────
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

    // ── Dropdowns — wait for any open autocomplete panels to close ─────────
    await new Promise(r => setTimeout(r, 400));

    const sicInfo      = findAnySelect('sic');
    const aircraftInfo = findAnySelect('aircraft');
    const tsaInfo      = findAnySelect('tsa vetting') || findAnySelect('part 135 tsa vetting');

    console.log('[CrewSync FRAT] Selects found:', {
      sic:      sicInfo      ? `${sicInfo.kind}` : 'NOT FOUND',
      aircraft: aircraftInfo ? `${aircraftInfo.kind}` : 'NOT FOUND',
      tsa:      tsaInfo      ? `${tsaInfo.kind}` : 'NOT FOUND',
    });

    if (sicInfo) {
      const ok = await selectAnyOption(sicInfo, SIC_NAME); // 'Kaestner' matches "Kaestner, Kyle"
      log.push('SIC ' + (ok ? '✓' : '✗'));
    } else log.push('SIC ✗ (not found)');

    if (aircraftInfo && flight.tail) {
      const ok = await selectAnyOption(aircraftInfo, flight.tail);
      log.push('Aircraft ' + (ok ? '✓' : '✗'));
    } else if (!aircraftInfo) log.push('Aircraft ✗ (not found)');

    if (tsaInfo) {
      const ok = await selectAnyOption(tsaInfo, 'Completed');
      log.push('TSA ' + (ok ? '✓' : '✗'));
    } else log.push('TSA ✗ (not found)');

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
        Fills: Origin · Destination · Trip ID · SIC · Aircraft
      </div>
      <div id="cs-legs"></div>
      <div style="font-size:10px;color:#334155;margin-top:8px;border-top:1px solid #1e293b;padding-top:8px">
        PIC — fill manually
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
