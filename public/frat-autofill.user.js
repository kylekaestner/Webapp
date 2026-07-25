// ==UserScript==
// @name         CrewSync FRAT Autofill
// @namespace    https://crewsync.spiritjets.com/
// @version      1.1
// @description  Prefills Origin, Destination, and SIC from your CrewSync schedule
// @author       Kyle Kaestner
// @match        https://prismsms.argus.aero/tools/frat-landing/frat-report/*/add
// @match        https://prismsms.argus.aero/tools/frat-landing/frat-report/*/edit
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      167.71.107.245
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SERVER  = 'http://167.71.107.245:3000';
  const PILOT   = 'kyle';
  const SIC_NAME = 'Kaestner';   // text to match in the SIC dropdown

  // ── DOM helpers ──────────────────────────────────────────────────────────

  function waitFor(sel, timeout = 15000) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        const el = document.querySelector(sel);
        if (el) return res(el);
        if (Date.now() - t0 > timeout) return rej('Timeout waiting for: ' + sel);
        setTimeout(poll, 300);
      })();
    });
  }

  // Bypass Angular/React value tracking — the native setter + input event
  // is the only reliable way to update a framework-managed text field.
  function setAngularInput(el, value) {
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    el.blur();
  }

  // Find the <input> inside a mat-form-field whose mat-label matches labelText
  function inputByLabel(labelText) {
    for (const lbl of document.querySelectorAll('mat-label')) {
      if (lbl.textContent.trim().replace(/\s*\*\s*$/, '').toLowerCase() === labelText.toLowerCase()) {
        const ff = lbl.closest('mat-form-field');
        if (ff) return ff.querySelector('input');
      }
    }
    return null;
  }

  // Find the mat-select inside a mat-form-field by label
  function selectByLabel(labelText) {
    for (const lbl of document.querySelectorAll('mat-label')) {
      if (lbl.textContent.trim().replace(/\s*\*\s*$/, '').toLowerCase() === labelText.toLowerCase()) {
        const ff = lbl.closest('mat-form-field');
        if (ff) return ff.querySelector('mat-select');
      }
    }
    return null;
  }

  // Click a mat-select open, then pick the option whose text includes `search`
  function selectMatOption(selectEl, search) {
    if (!selectEl) return Promise.resolve(false);
    return new Promise(resolve => {
      selectEl.click();
      setTimeout(() => {
        const opts = [...document.querySelectorAll('mat-option')];
        const match = opts.find(o => o.textContent.toLowerCase().includes(search.toLowerCase()));
        if (match) { match.click(); return resolve(true); }
        // Close the panel if no match found
        document.body.click();
        resolve(false);
      }, 500);
    });
  }

  // ── Date formatting (Kyle's segments are UTC — end in Z) ─────────────────

  function fmtFlight(seg) {
    const dep = new Date(seg.departure_time); // ends in Z → parses as UTC
    const opts = { timeZone: 'America/Chicago' };
    const dateStr = dep.toLocaleDateString('en-US', { ...opts, weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = dep.toLocaleTimeString('en-US', { ...opts, hour: '2-digit', minute: '2-digit', hour12: false });
    return `${dateStr} · ${timeStr} CT`;
  }

  // ── Fetch upcoming flights ────────────────────────────────────────────────

  function fetchFlights() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'GET',
        url:     `${SERVER}/api/pilots/${PILOT}`,
        timeout: 10000,
        onload(r) {
          try {
            const data = JSON.parse(r.responseText);
            const cutoff = Date.now() - 2 * 3600_000; // include up to 2h ago
            const flights = (data.segments || [])
              .filter(s =>
                s.type === 'flight' &&
                s.departure_airport &&
                s.arrival_airport &&
                s.departure_time &&
                new Date(s.departure_time).getTime() >= cutoff
              )
              .sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time))
              .slice(0, 10);
            resolve(flights);
          } catch (e) { reject(e); }
        },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });
  }

  // ── Fill the FRAT form fields ─────────────────────────────────────────────

  async function fillFlight(flight) {
    // Text inputs: Origin and Destination
    const originInput = inputByLabel('origin');
    const destInput   = inputByLabel('destination');
    if (originInput) setAngularInput(originInput, flight.departure_airport);
    if (destInput)   setAngularInput(destInput,   flight.arrival_airport);

    // SIC dropdown — Kyle is always SIC
    await new Promise(r => setTimeout(r, 300));
    const sicSel = selectByLabel('sic');
    await selectMatOption(sicSel, SIC_NAME);
  }

  // ── Floating panel UI ─────────────────────────────────────────────────────

  const PANEL_ID = 'cs-frat-panel';

  function buildPanel(flights) {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position:     'fixed',
      top:          '72px',
      right:        '18px',
      zIndex:       '2147483647',
      background:   '#0f172a',
      border:       '1px solid #1e3a5f',
      borderRadius: '16px',
      padding:      '14px 14px 10px',
      width:        '300px',
      boxShadow:    '0 12px 40px rgba(0,0,0,.65)',
      fontFamily:   'system-ui,-apple-system,sans-serif',
      fontSize:     '13px',
      lineHeight:   '1.4',
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      display:        'flex',
      justifyContent: 'space-between',
      alignItems:     'center',
      marginBottom:   '10px',
    });
    header.innerHTML = `
      <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.1em">
        ✈ CrewSync — Select Leg
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <span id="cs-status" style="font-size:11px;color:#10b981;display:none"></span>
        <button id="cs-close" title="Close"
          style="background:none;border:none;color:#475569;cursor:pointer;font-size:20px;line-height:1;padding:0 2px">×</button>
      </div>
    `;
    panel.appendChild(header);

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:10px;color:#475569;margin-bottom:10px';
    sub.textContent = 'Click a leg — fills Origin, Destination, and SIC';
    panel.appendChild(sub);

    const status = header.querySelector('#cs-status');

    if (!flights.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#475569;text-align:center;padding:16px 0;font-size:12px';
      empty.textContent = 'No upcoming flights in schedule';
      panel.appendChild(empty);
    }

    flights.forEach(f => {
      const card = document.createElement('div');
      Object.assign(card.style, {
        padding:      '10px 13px',
        borderRadius: '10px',
        border:       '1px solid #1e293b',
        background:   '#1e293b',
        cursor:       'pointer',
        marginBottom: '6px',
        transition:   'background .12s, border-color .12s',
      });
      card.onmouseenter = () => { card.style.background = '#1e3a5f'; card.style.borderColor = '#3b82f6'; };
      card.onmouseleave = () => {
        if (!card.dataset.done) { card.style.background = '#1e293b'; card.style.borderColor = '#1e293b'; }
      };

      const route = document.createElement('div');
      route.style.cssText = 'font-weight:700;font-size:16px;color:#f1f5f9;letter-spacing:.01em';
      route.innerHTML = `${f.departure_airport} <span style="color:#3b82f6">→</span> ${f.arrival_airport}`;

      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:10px;color:#64748b;margin-top:3px';
      meta.textContent = fmtFlight(f) + (f.tail ? ' · ' + f.tail : '');

      card.appendChild(route);
      card.appendChild(meta);

      card.onclick = async () => {
        if (card.dataset.done) return;
        card.dataset.done = '1';
        card.style.background   = '#064e3b';
        card.style.borderColor  = '#10b981';
        status.textContent      = 'Filling…';
        status.style.display    = 'block';
        route.style.color       = '#34d399';
        await fillFlight(f);
        status.textContent = `✓ ${f.departure_airport} → ${f.arrival_airport}`;
        meta.textContent   = 'Done — check PIC and TSA fields manually';
        meta.style.color   = '#4ade80';
      };

      panel.appendChild(card);
    });

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:#334155;margin-top:8px;border-top:1px solid #1e293b;padding-top:8px';
    hint.innerHTML = 'PIC &amp; TSA Vetting — fill manually &nbsp;·&nbsp; <a href="' + SERVER + '/frat-autofill.user.js" target="_blank" style="color:#3b82f6;text-decoration:none">reinstall script</a>';
    panel.appendChild(hint);

    document.body.appendChild(panel);
    panel.querySelector('#cs-close').onclick = () => panel.remove();
  }

  // ── Error / loading panels ────────────────────────────────────────────────

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
    panel.innerHTML = `<div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">✈ CrewSync</div>Loading schedule…`;
    document.body.appendChild(panel);
    return panel;
  }

  // ── Main ─────────────────────────────────────────────────────────────────

  async function main() {
    try {
      // Wait for Angular to render the form before we do anything
      await waitFor('mat-form-field');
      await new Promise(r => setTimeout(r, 1000)); // extra hydration buffer

      const loadingPanel = buildLoadingPanel();

      let flights;
      try {
        flights = await fetchFlights();
      } catch (e) {
        loadingPanel.innerHTML = `
          <div style="font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">✈ CrewSync</div>
          <div style="color:#64748b;font-size:12px">Could not reach server.<br>Check your connection.</div>
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
