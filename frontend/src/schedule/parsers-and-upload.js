        // ── Client-side parsers ──────────────────────────────────────────────
        // These run in the browser before uploading so the server receives a
        // normalized JSON array. The server's /api/pilots/:key/upload route
        // picks the right parser based on pilots.parser_type in the DB:
        //   'ics'            -> parseICS()        (Schedaero .ics)
        //   'ics_rosterbuster'-> parseICS()       (RosterBuster .ics -- same format)
        //   'csv_republic'   -> parseCSV()        (Republic Airways CSV layout)
        //   'csv_skywest'    -> parseSkyWestCSV() (SkyWest-specific CSV layout)
        // After parsing, uploadPilotSchedule() POSTs the events[] to the server.
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
                    // hard day off
                    const date = isAllDay ? dtstart : dtstart.substring(0,8);
                    const y = date.substring(0,4), m = date.substring(4,6), d = date.substring(6,8);
                    events.push({ type: 'hard', departureTime: `${y}-${m}-${d}T00:00:00` });
                    continue;
                }

                if (/^AWAY$/i.test(summary)) {
                    // away with DESCRIPTION maybe 'AWAY - APC'
                    const arrival = (desc.match(/AWAY\s*-\s*(\w+)/i) || [])[1] || null;
                    if (dtstart) {
                        const isoStart = formatICSDatetime(dtstart);
                        const isoEnd = dtend ? formatICSDatetime(dtend) : '';
                        events.push({ type: 'away', departureTime: isoStart, arrivalTime: isoEnd, arrivalAirport: arrival });
                    }
                    continue;
                }

                // flight events: SUMMARY like '✈️ KSUS -> TJSJ' or '✈️ KCNY -> KSUS'
                const flightMatch = summary.match(/(?:✈️|\u2708)?\s*([A-Z0-9]{3,4})\s*(?:->|→|–|—|-|to)\s*([A-Z0-9]{3,4})/i);
                const tailMatch = desc.match(/Tail:\s*([A-Z0-9]+)/i);
                const tripMatch = desc.match(/Trip\s*[:#]?\s*(\d+)/i);
                // try to capture flight number like RPA1234 or SKW567
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
            // s like 20260430T120000Z or 20260501
            if (/^\d{8}T\d{6}Z$/.test(s)) {
                const y = s.substring(0,4), m = s.substring(4,6), d = s.substring(6,8);
                const hh = s.substring(9,11), mm = s.substring(11,13), ss = s.substring(13,15);
                return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
            }
            if (/^\d{8}$/.test(s)) {
                const y = s.substring(0,4), m = s.substring(4,6), d = s.substring(6,8);
                return `${y}-${m}-${d}T00:00:00`;
            }
            return s;
        }

        function parseCSV(text) {
            const lines = text.split(/\r?\n/).filter(l => l.trim());
            const header = lines.shift().split(',').map(h => h.trim());
            const idx = (name) => header.indexOf(name);
            const events = [];

            const toMinutes = (time) => {
                const txt = normalizeTime(time);
                const [hh, mm] = txt.split(':').map(Number);
                return hh * 60 + mm;
            };

            const addDays = (year, month, day, extraDays) => {
                const d = new Date(Number(year), Number(month) - 1, Number(day) + extraDays);
                const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
                return { y, m, dd };
            };

            for (const row of lines) {
                const cols = row.split(',');
                const date = cols[idx('DATE')]?.trim();
                const dh = cols[idx('DH')]?.trim();
                const tail = (cols[idx('FCVTAIL')] || cols[idx('TAIL')] || '').trim();
                const dep = (cols[idx('DEP')] || '').trim();
                const arr = (cols[idx('ARR')] || '').trim();
                const deptime = (cols[idx('DEPTIME')] || '').trim();
                const arrtime = (cols[idx('ARRTIME')] || '').trim();

                if (!date) continue;
                const [m, d, y] = date.split('/');
                const ym = y.padStart(4, '0'), mm = m.padStart(2, '0'), dd = d.padStart(2, '0');

                if (dep && arr) {
                    const dt = normalizeTime(deptime);
                    const at = normalizeTime(arrtime);
                    let arrivalDate = { y: ym, m: mm, dd: dd };
                    const depMinutes = toMinutes(deptime);
                    const arrMinutes = toMinutes(arrtime);
                    if (arrMinutes <= depMinutes) {
                        arrivalDate = addDays(ym, mm, dd, 1);
                    }
                    const isoStart = `${ym}-${mm}-${dd}T${dt}:00`;
                    const isoEnd = `${arrivalDate.y}-${arrivalDate.m}-${arrivalDate.dd}T${at}:00`;
                    const isDH = dh && dh.toUpperCase() === 'DH';
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

        function normalizeTime(t) {
            if (!t) return '00:00';
            const txt = t.trim().replace(/[^\d:]/g, '');
            if (txt.includes(':')) {
                const parts = txt.split(':');
                const hh = String(parts[0] || '00').padStart(2, '0').slice(-2);
                const mm = String(parts[1] || '00').padStart(2, '0').slice(-2);
                return `${hh}:${mm}`;
            }
            const s = txt.padStart(4, '0');
            return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
        }

        async function handleUpload(input) {
            if (_isDemo || !input.files[0]) return;

            const file = input.files[0];
            // Get selected pilot from dropdown
            const uploadPilot = document.getElementById('upload-pilot-select').value;

            // A PDF schedule goes through server-side OCR (the only real NetJets CC-schedule
            // export, Microsoft Print-to-PDF, has no extractable text layer) -- genuinely slow
            // (~30-60s on this box), so say so up front instead of leaving the button looking dead.
            if (file.name.toLowerCase().endsWith('.pdf')) {
                showToast('Reading PDF schedule — this can take up to a minute…', 'info', 8000);
            }

            const result = await uploadPilotSchedule(uploadPilot, file);

            if (result && result.success) {
                showToast(result.ccSchedule
                    ? `Schedule uploaded — ${result.daysParsed} days parsed for ${uploadPilot}`
                    : `Schedule uploaded — ${result.segmentsAdded} segments added for ${uploadPilot}`);
                if (myPilot === null && !myViewer && result.warnings && result.warnings.length) {
                    showToast(`⚠ ${result.warnings.length} unrecognized item${result.warnings.length > 1 ? 's' : ''} in this schedule — see Admin → Manage Users for details.`, 'info', 6000);
                }
                // If the uploaded pilot is currently viewed, reload their data
                if (uploadPilot === currentPilot) {
                    loadPilot(currentPilot);
                }
                // Compute crossings and notify affected pilots
                computeOverlap().then(overlaps => {
                    updateCrossingAlert(overlaps);
                    if (PUSH_ENABLED) broadcastCrossingNotifications(overlaps);
                }).catch(() => {});
            } else {
                showToast('Upload failed — check the browser console for details.', 'error');
            }

            // Reset input
            input.value = '';
        }

