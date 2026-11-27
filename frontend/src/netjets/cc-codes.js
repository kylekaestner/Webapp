        // NetJets CC schedule day codes (the "Vector codes" legend, 2026-11-26). One table for the app and
        // the server: server.js requires this file, the app gets it in the bundle.
        // kind: duty = on tour (tail tracking, ON TOUR) · training / travel / office = working, not on tour
        // and not off · leave / off = off. label is the short status tag; desc is the legend's wording.
        const CC_CODES = (() => {
            const t = {};
            const add = (kind, label, rows) => rows.forEach(([code, desc]) => { t[code] = { code, kind, label, desc }; });
            add('duty', 'ON TOUR', [
                ['X', 'Regular duty assignment'], ['X1', 'Duty day not eligible to modify with slide or PTO'],
                ['X2', 'Duty day with planned international event'], ['X3', 'AdHoc tour slide, company initiated'],
                ['X4', 'AdHoc tour slide, crewmember initiated'], ['X6', 'Extended day not eligible for additional pay'],
                ['X8', 'NRFO duty for non-NRFO pilot'], ['X9', 'NRFO duty'], ['R', 'Voluntary additional work day (VAWD)'],
                ['I', 'Check airman duty'], ['2', 'After midnight return'], ['EXT', 'Extended day'],
            ]);
            add('training', 'TRAINING', [
                ['G', 'Ground training'], ['G1', 'Initial aircraft training'], ['G2', 'Recurrent training, aircraft specific'],
                ['G3', 'Company upgrade training'], ['G4', 'Recurrent training, non-aircraft specific'],
                ['G5', 'Company indoctrination training'], ['G6', 'Supplemental training'],
                ['G7', 'Supplemental duty position (SDP) training'], ['G8', 'Training tour, extended pay'],
                ['T', 'Flight training and/or flight check'],
            ]);
            add('travel', 'TRAVEL', [['N', 'Travel day']]);
            add('office', 'OFFICE', [['D2', 'Office duty'], ['D3', 'Office duty, mandatory schedule'], ['D6', 'Office duty'], ['D9', 'Office duty, union paid']]);
            add('leave', 'PTO', [['P1', 'PTO, 1 day'], ['P2', 'PTO, 1.5 days'], ['P3', 'PTO, 2 days'],
                ['P4', 'Extraordinary PTO, 2 days'], ['P5', 'Extraordinary PTO, 3 days'], ['P6', 'Extraordinary PTO, 4 days']]);
            add('leave', 'VAC', [['V', 'Vacation'], ['V5', 'FMLA family, with vacation'], ['V8', 'SALCO/STD, with vacation']]);
            add('leave', 'SICK', [['S', 'Sick leave, paid'], ['S2', '0.75 sick day'], ['S4', 'FMLA self, with PTO'],
                ['S5', 'FMLA family, with PTO'], ['S7', 'SALCO/STD, with PTO'], ['S8', 'Extended bereavement, with PTO'], ['S9', 'Unpaid sick day']]);
            add('leave', 'LEAVE', [
                ['F', 'Paid bereavement leave'], ['B', "Workers' compensation"], ['J', 'Jury duty'], ['M', 'Military leave'],
                ['L', 'Personal unpaid leave of absence'], ['L0', 'Unpaid medical leave'], ['L3', 'FMLA, unpaid'],
                ['L5', 'FMLA family, long term bank'], ['L7', 'SALCO, long term bank'], ['L8', 'SALCO/STD, no supplement'],
                ['L9', 'Loss of medical'], ['O2', 'Ops leave, no brief'], ['O9', 'Extended unpaid medical leave'],
                ['U', 'Unauthorized absence'], ['U4', 'Paid parental leave'], ['U5', 'Unpaid parental leave'], ['U9', 'Unpaid suspension'],
            ]);
            add('off', 'OFF', [['OFF', 'Day off'], ['/', 'Previously a duty day, now an off day']]);
            add('off', 'COMP OFF', [['C', 'Compensatory day off for an extended day']]);
            add('off', 'RECOVERY', [['Q', 'Time recovery for an after midnight return']]);
            add('off', 'NO SCHED', [['•', 'Vacation lead day or do not schedule day']]);
            return t;
        })();
        // The legend's two dot codes (do not schedule, extended day) come out of OCR as a bullet or dash.
        const _CC_DOTS = new Set(['•', '-', '–', '—', '·', '*', '●', '○', '◦', '▪']);
        function ccCodeInfo(code) {
            const c = String(code || '').trim().toUpperCase();
            return CC_CODES[_CC_DOTS.has(c) ? '•' : c] || { code: c, kind: 'unknown', label: c || '?', desc: 'Unrecognized code' };
        }
        // A status token from the export to a known code, or null. OCR swaps look-alike characters, so the
        // second character is tried as a digit (XI, XL -> X1; LO -> L0; SS -> S5) and a leading 0 as O.
        // A dot right after a duty day is read as an extended day, otherwise as do-not-schedule.
        function ccNormalizeCode(raw, prevKind) {
            const tok = String(raw || '').trim().toUpperCase().replace(/[.,;:]+$/, '');
            if (_CC_DOTS.has(tok)) return prevKind === 'duty' ? 'EXT' : '•';
            if (tok === '0FF' || tok === 'OF' || tok === 'OFE') return 'OFF';
            if (CC_CODES[tok]) return tok;
            const digit = { I: '1', L: '1', '|': '1', O: '0', Q: '0', D: '0', S: '5', Z: '2', B: '8', G: '6' };
            const tries = [];
            if (tok.length === 2) {
                if (digit[tok[1]]) tries.push(tok[0] + digit[tok[1]]);
                if (tok[0] === '0') tries.push('O' + tok[1], 'O' + (digit[tok[1]] || tok[1]));
            }
            return tries.find(c => CC_CODES[c]) || null;
        }
        if (typeof module !== 'undefined') module.exports = { CC_CODES, ccCodeInfo, ccNormalizeCode };
