// Fake demo pilots and schedules — no real crew data exposed
// Anchor = mid-month so data spans the whole current month and a bit of next.

const ANCHOR = '2026-05-15';

function dt(base, n, hhmm) {
    const d = new Date(base + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return `${d.toISOString().slice(0, 10)}T${hhmm}:00`;
}

const DEMO_PILOTS = {
    alex:   { pilot_key: 'alex',   name: 'Alex Rivera',   base: 'ORD' },
    morgan: { pilot_key: 'morgan', name: 'Morgan Tate',   base: 'ATL' },
    casey:  { pilot_key: 'casey',  name: 'Casey Walsh',   base: 'DEN' },
    jordan: { pilot_key: 'jordan', name: 'Jordan Ellis',  base: 'JFK' },
};

let _id = 1000;
function seg(pilotId, type, n0, hhmm0, n1, hhmm1, dep, arr, opts = {}) {
    return {
        id: ++_id,
        pilot_id: pilotId,
        type,
        departure_time:   dt(ANCHOR, n0, hhmm0),
        arrival_time:     dt(ANCHOR, n1, hhmm1),
        departure_airport: dep,
        arrival_airport:   arr,
        flight_number: opts.fn  || null,
        tail:          opts.tail || null,
        is_dh:         opts.dh  ? 1 : 0,
        is_manual:     0,
        block_minutes: opts.blk || null,
    };
}
function off(pilotId, n, base) {
    return seg(pilotId, 'hard', n, '00:00', n, '23:59', base, base);
}

// ── ALEX RIVERA — United, ORD based ──────────────────────────────────────
// May:  1-3 trip, 4-5 off, 6-8 trip, 9-11 off, 12-14 trip, 15-16 off,
//       17-19 trip, 20-21 off, 22-24 trip, 25-26 off, 27-29 trip, 30-31 off
const alex = [
    // May 1-3: ORD-BOS-ORD
    seg(1, 'flight', -14,'06:30', -14,'10:15', 'ORD','BOS', {fn:'UA 340', tail:'N14231', blk:165}),
    seg(1, 'flight', -14,'12:00', -14,'13:20', 'BOS','LGA', {fn:'UA 412', tail:'N14231', blk:80}),
    seg(1, 'flight', -13,'08:45', -13,'10:10', 'LGA','BOS', {fn:'UA 507', tail:'N14231', blk:85}),
    seg(1, 'flight', -13,'14:30', -13,'17:00', 'BOS','ORD', {fn:'UA 624', tail:'N14231', blk:150}),
    seg(1, 'flight', -12,'09:15', -12,'12:50', 'ORD','MIA', {fn:'UA 183', tail:'N14231', blk:155}),
    seg(1, 'flight', -12,'16:00', -12,'19:30', 'MIA','ORD', {fn:'UA 290', tail:'N14231', blk:170}),
    // May 4-5: off
    off(1, -11, 'ORD'), off(1, -10, 'ORD'),
    // May 6-8: ORD-DEN-SEA
    seg(1, 'flight',  -9,'07:00',  -9,'09:45', 'ORD','DEN', {fn:'UA 512', tail:'N77869', blk:145}),
    seg(1, 'flight',  -9,'12:15',  -9,'14:30', 'DEN','SEA', {fn:'UA 651', tail:'N77869', blk:135}),
    seg(1, 'flight',  -8,'10:00',  -8,'15:40', 'SEA','ORD', {fn:'UA 744', tail:'N77869', blk:220}),
    seg(1, 'flight',  -7,'08:20',  -7,'12:05', 'ORD','DFW', {fn:'UA 830', tail:'N77869', blk:165}),
    seg(1, 'flight',  -7,'15:30',  -7,'18:45', 'DFW','ORD', {fn:'UA 917', tail:'N77869', blk:135}),
    // May 9-11: off
    off(1, -6,'ORD'), off(1, -5,'ORD'), off(1, -4,'ORD'),
    // May 12-14: ORD-JFK-ORD
    seg(1, 'flight',  -3,'06:15',  -3,'09:45', 'ORD','JFK', {fn:'UA 723', tail:'N14219', blk:130}),
    seg(1, 'flight',  -3,'11:30',  -3,'12:55', 'JFK','BOS', {fn:'UA 890', tail:'N14219', blk:85}),
    seg(1, 'flight',  -2,'09:10',  -2,'10:35', 'BOS','JFK', {fn:'UA 445', tail:'N14219', blk:85}),
    seg(1, 'flight',  -2,'14:00',  -2,'16:20', 'JFK','ORD', {fn:'UA 286', tail:'N14219', blk:140}),
    seg(1, 'flight',  -1,'07:30',  -1,'11:10', 'ORD','MIA', {fn:'UA 204', tail:'N14219', blk:160}),
    seg(1, 'flight',  -1,'14:45',  -1,'18:20', 'MIA','ORD', {fn:'UA 317', tail:'N14219', blk:155}),
    // May 15-16: off
    off(1, 0,'ORD'), off(1, 1,'ORD'),
    // May 17-19: ORD-DEN-LAX
    seg(1, 'flight',  2,'07:00',  2,'09:30', 'ORD','DEN', {fn:'UA 512', tail:'N77521', blk:150}),
    seg(1, 'flight',  2,'12:45',  2,'14:55', 'DEN','LAX', {fn:'UA 618', tail:'N77521', blk:130}),
    seg(1, 'flight',  3,'08:20',  3,'10:40', 'LAX','SFO', {fn:'UA 340', tail:'N77521', blk:80}),
    seg(1, 'flight',  3,'13:00',  3,'18:50', 'SFO','ORD', {fn:'UA 731', tail:'N77521', blk:230}),
    seg(1, 'flight',  4,'09:30',  4,'13:15', 'ORD','ATL', {fn:'UA 405', tail:'N77521', blk:125}),
    seg(1, 'flight',  4,'17:00',  4,'19:10', 'ATL','ORD', {fn:'UA 518', tail:'N77521', blk:130}),
    // May 20-21: off
    off(1, 5,'ORD'), off(1, 6,'ORD'),
    // May 22-24: ORD-EWR-ORD
    seg(1, 'flight',  7,'06:00',  7,'09:30', 'ORD','EWR', {fn:'UA 111', tail:'N14256', blk:150}),
    seg(1, 'flight',  7,'12:15',  7,'13:50', 'EWR','BOS', {fn:'UA 203', tail:'N14256', blk:95}),
    seg(1, 'flight',  8,'10:00',  8,'11:45', 'BOS','EWR', {fn:'UA 315', tail:'N14256', blk:105}),
    seg(1, 'flight',  8,'14:30',  8,'17:10', 'EWR','ORD', {fn:'UA 427', tail:'N14256', blk:160}),
    seg(1, 'flight',  9,'08:00',  9,'12:05', 'ORD','MCO', {fn:'UA 509', tail:'N14256', blk:175}),
    seg(1, 'flight',  9,'16:30',  9,'19:45', 'MCO','ORD', {fn:'UA 612', tail:'N14256', blk:175}),
    // May 25-26: off
    off(1,10,'ORD'), off(1,11,'ORD'),
    // May 27-29: ORD-PHX-LAS
    seg(1, 'flight', 12,'07:30', 12,'10:00', 'ORD','PHX', {fn:'UA 730', tail:'N77899', blk:210}),
    seg(1, 'flight', 12,'13:00', 12,'14:15', 'PHX','LAS', {fn:'UA 815', tail:'N77899', blk:75}),
    seg(1, 'flight', 13,'09:00', 13,'13:30', 'LAS','ORD', {fn:'UA 920', tail:'N77899', blk:210}),
    seg(1, 'flight', 14,'07:45', 14,'11:30', 'ORD','DCA', {fn:'UA 104', tail:'N77899', blk:105}),
    seg(1, 'flight', 14,'14:00', 14,'16:45', 'DCA','ORD', {fn:'UA 217', tail:'N77899', blk:105}),
    // May 30-31: off
    off(1,15,'ORD'), off(1,16,'ORD'),
];

// ── MORGAN TATE — Delta, ATL based ───────────────────────────────────────
const morgan = [
    // May 1-4: ATL-SEA long trip
    seg(2, 'flight', -14,'06:00', -14,'08:10', 'ATL','ORD', {fn:'DL 402', tail:'N301DN', dh:true, blk:130}),
    seg(2, 'flight', -14,'10:30', -14,'14:45', 'ORD','SEA', {fn:'DL 711', tail:'N301DN', blk:255}),
    seg(2, 'flight', -13,'08:15', -13,'12:00', 'SEA','SFO', {fn:'DL 546', tail:'N301DN', blk:105}),
    seg(2, 'flight', -13,'14:30', -13,'18:45', 'SFO','ATL', {fn:'DL 820', tail:'N301DN', blk:285}),
    seg(2, 'flight', -12,'07:00', -12,'09:45', 'ATL','ORD', {fn:'DL 330', tail:'N301DN', blk:165}),
    seg(2, 'flight', -12,'12:15', -12,'16:30', 'ORD','ATL', {fn:'DL 448', tail:'N301DN', blk:135}),
    // May 5-7: off
    off(2,-10,'ATL'), off(2,-9,'ATL'), off(2,-8,'ATL'),
    // May 8-10: ATL-JFK-BOS
    seg(2, 'flight',  -7,'06:30',  -7,'09:45', 'ATL','JFK', {fn:'DL 271', tail:'N308DN', blk:135}),
    seg(2, 'flight',  -7,'11:20',  -7,'12:50', 'JFK','BOS', {fn:'DL 392', tail:'N308DN', blk:90}),
    seg(2, 'flight',  -6,'09:00',  -6,'10:30', 'BOS','JFK', {fn:'DL 505', tail:'N308DN', blk:90}),
    seg(2, 'flight',  -6,'13:00',  -6,'16:45', 'JFK','ATL', {fn:'DL 608', tail:'N308DN', blk:165}),
    seg(2, 'flight',  -5,'07:15',  -5,'10:30', 'ATL','DFW', {fn:'DL 700', tail:'N308DN', blk:155}),
    seg(2, 'flight',  -5,'13:30',  -5,'16:45', 'DFW','ATL', {fn:'DL 812', tail:'N308DN', blk:115}),
    // May 11-13: off
    off(2,-4,'ATL'), off(2,-3,'ATL'), off(2,-2,'ATL'),
    // May 14-16: ATL-DEN
    seg(2, 'flight',  -1,'13:00',  -1,'15:30', 'ATL','DEN', {fn:'DL 933', tail:'N304DN', blk:210}),
    seg(2, 'flight',   0,'07:45',   0,'13:30', 'DEN','ATL', {fn:'DL 100', tail:'N304DN', blk:225}),
    seg(2, 'flight',   1,'09:00',   1,'11:15', 'ATL','ORD', {fn:'DL 210', tail:'N304DN', blk:135}),
    // May 16-17: off
    off(2, 2,'ATL'), off(2, 3,'ATL'),
    // May 18-20: ATL-LAX
    seg(2, 'flight',   4,'08:00',   4,'11:15', 'ATL','DFW', {fn:'DL 415', tail:'N305DN', blk:155}),
    seg(2, 'flight',   4,'13:30',   4,'15:45', 'DFW','LAX', {fn:'DL 520', tail:'N305DN', blk:135}),
    seg(2, 'flight',   5,'10:00',   5,'16:30', 'LAX','ATL', {fn:'DL 633', tail:'N305DN', blk:210}),
    seg(2, 'flight',   6,'07:30',   6,'10:45', 'ATL','BOS', {fn:'DL 740', tail:'N305DN', blk:165}),
    // May 20-22: off
    off(2, 7,'ATL'), off(2, 8,'ATL'),
    // May 23-25: ATL-JFK-MIA
    seg(2, 'flight',   9,'06:30',   9,'09:45', 'ATL','JFK', {fn:'DL 271', tail:'N309DN', blk:135}),
    seg(2, 'flight',   9,'12:00',   9,'15:30', 'JFK','MIA', {fn:'DL 380', tail:'N309DN', blk:150}),
    seg(2, 'flight',  10,'08:00',  10,'11:30', 'MIA','ATL', {fn:'DL 490', tail:'N309DN', blk:90}),
    seg(2, 'flight',  10,'14:00',  10,'17:15', 'ATL','LGA', {fn:'DL 601', tail:'N309DN', blk:135}),
    seg(2, 'flight',  11,'09:30',  11,'13:00', 'LGA','ATL', {fn:'DL 712', tail:'N309DN', blk:150}),
    // May 26-27: off
    off(2,12,'ATL'), off(2,13,'ATL'),
    // May 28-30: ATL-ORD-SEA
    seg(2, 'flight',  14,'07:00',  14,'09:10', 'ATL','ORD', {fn:'DL 322', tail:'N310DN', blk:130}),
    seg(2, 'flight',  14,'11:30',  14,'15:45', 'ORD','SEA', {fn:'DL 441', tail:'N310DN', blk:255}),
    seg(2, 'flight',  15,'13:00',  15,'21:30', 'SEA','ATL', {fn:'DL 560', tail:'N310DN', blk:270}),
    // May 31: off
    off(2,16,'ATL'),
];

// ── CASEY WALSH — Southwest, DEN based ───────────────────────────────────
const casey = [
    // May 1-3
    seg(3, 'flight', -14,'05:45', -14,'07:50', 'DEN','PHX', {fn:'WN 614', tail:'N8616G', blk:125}),
    seg(3, 'flight', -14,'09:10', -14,'11:20', 'PHX','LAS', {fn:'WN 702', tail:'N8616G', blk:70}),
    seg(3, 'flight', -14,'12:45', -14,'15:30', 'LAS','DEN', {fn:'WN 819', tail:'N8616G', blk:105}),
    seg(3, 'flight', -13,'06:30', -13,'10:15', 'DEN','MDW', {fn:'WN 215', tail:'N7737V', blk:145}),
    seg(3, 'flight', -13,'12:00', -13,'13:45', 'MDW','STL', {fn:'WN 307', tail:'N7737V', blk:65}),
    seg(3, 'flight', -13,'15:00', -13,'16:45', 'STL','MDW', {fn:'WN 418', tail:'N7737V', blk:65}),
    seg(3, 'flight', -13,'18:30', -13,'21:15', 'MDW','DEN', {fn:'WN 530', tail:'N7737V', blk:105}),
    // May 4-6: off
    off(3,-11,'DEN'), off(3,-10,'DEN'), off(3,-9,'DEN'),
    // May 7-9
    seg(3, 'flight',  -8,'06:00',  -8,'09:45', 'DEN','HOU', {fn:'WN 120', tail:'N8622C', blk:165}),
    seg(3, 'flight',  -8,'11:30',  -8,'13:15', 'HOU','DAL', {fn:'WN 234', tail:'N8622C', blk:65}),
    seg(3, 'flight',  -8,'15:00',  -8,'16:45', 'DAL','HOU', {fn:'WN 348', tail:'N8622C', blk:65}),
    seg(3, 'flight',  -8,'19:00',  -8,'21:45', 'HOU','DEN', {fn:'WN 462', tail:'N8622C', blk:165}),
    seg(3, 'flight',  -7,'07:00',  -7,'10:30', 'DEN','PHX', {fn:'WN 576', tail:'N8616G', blk:110}),
    seg(3, 'flight',  -7,'12:15',  -7,'16:00', 'PHX','DEN', {fn:'WN 688', tail:'N8616G', blk:105}),
    off(3, -6,'DEN'),
    // May 11-13
    seg(3, 'flight',  -4,'06:15',  -4,'10:00', 'DEN','MDW', {fn:'WN 115', tail:'N7745V', blk:145}),
    seg(3, 'flight',  -4,'11:30',  -4,'13:30', 'MDW','DTW', {fn:'WN 229', tail:'N7745V', blk:80}),
    seg(3, 'flight',  -4,'15:15',  -4,'17:00', 'DTW','MDW', {fn:'WN 343', tail:'N7745V', blk:65}),
    seg(3, 'flight',  -4,'19:00',  -4,'22:45', 'MDW','DEN', {fn:'WN 457', tail:'N7745V', blk:105}),
    seg(3, 'flight',  -3,'07:20',  -3,'11:05', 'DEN','MDW', {fn:'WN 571', tail:'N7737V', blk:145}),
    seg(3, 'flight',  -3,'12:30',  -3,'14:15', 'MDW','STL', {fn:'WN 683', tail:'N7737V', blk:65}),
    seg(3, 'flight',  -3,'15:45',  -3,'17:30', 'STL','MDW', {fn:'WN 791', tail:'N7737V', blk:65}),
    seg(3, 'flight',  -3,'19:00',  -3,'21:45', 'MDW','DEN', {fn:'WN 905', tail:'N7737V', blk:105}),
    // May 14-15: off
    off(3,-1,'DEN'), off(3,0,'DEN'),
    // May 16-18
    seg(3, 'flight',   1,'07:20',   1,'11:05', 'DEN','MDW', {fn:'WN 345', tail:'N7737V', blk:145}),
    seg(3, 'flight',   1,'12:30',   1,'14:15', 'MDW','STL', {fn:'WN 411', tail:'N7737V', blk:65}),
    seg(3, 'flight',   1,'15:45',   1,'17:30', 'STL','MDW', {fn:'WN 522', tail:'N7737V', blk:65}),
    seg(3, 'flight',   1,'19:00',   1,'21:45', 'MDW','DEN', {fn:'WN 638', tail:'N7737V', blk:105}),
    seg(3, 'flight',   2,'06:00',   2,'08:55', 'DEN','ORD', {fn:'WN 215', tail:'N8622C', blk:115}),
    seg(3, 'flight',   2,'10:15',   2,'12:00', 'ORD','STL', {fn:'WN 307', tail:'N8622C', blk:65}),
    seg(3, 'flight',   2,'13:30',   2,'17:55', 'STL','DEN', {fn:'WN 490', tail:'N8622C', blk:145}),
    // May 19-21: off
    off(3, 4,'DEN'), off(3, 5,'DEN'), off(3, 6,'DEN'),
    // May 22-24
    seg(3, 'flight',   7,'05:45',   7,'07:50', 'DEN','PHX', {fn:'WN 614', tail:'N8630G', blk:125}),
    seg(3, 'flight',   7,'09:10',   7,'11:20', 'PHX','LAS', {fn:'WN 726', tail:'N8630G', blk:70}),
    seg(3, 'flight',   7,'13:00',   7,'16:30', 'LAS','DEN', {fn:'WN 840', tail:'N8630G', blk:150}),
    seg(3, 'flight',   8,'07:00',   8,'10:30', 'DEN','HOU', {fn:'WN 952', tail:'N8622C', blk:165}),
    seg(3, 'flight',   8,'12:15',   8,'16:00', 'HOU','DEN', {fn:'WN 104', tail:'N8622C', blk:165}),
    seg(3, 'flight',   9,'08:00',   9,'11:45', 'DEN','DAL', {fn:'WN 218', tail:'N8622C', blk:105}),
    seg(3, 'flight',   9,'14:00',   9,'17:45', 'DAL','DEN', {fn:'WN 330', tail:'N8622C', blk:105}),
    // May 25-27: off
    off(3,10,'DEN'), off(3,11,'DEN'), off(3,12,'DEN'),
    // May 28-30
    seg(3, 'flight',  13,'06:30',  13,'10:15', 'DEN','MDW', {fn:'WN 445', tail:'N7751V', blk:145}),
    seg(3, 'flight',  13,'11:45',  13,'14:30', 'MDW','DTW', {fn:'WN 559', tail:'N7751V', blk:105}),
    seg(3, 'flight',  13,'16:00',  13,'19:45', 'DTW','DEN', {fn:'WN 673', tail:'N7751V', blk:165}),
    seg(3, 'flight',  14,'07:00',  14,'09:45', 'DEN','PHX', {fn:'WN 787', tail:'N7737V', blk:105}),
    seg(3, 'flight',  14,'12:00',  14,'15:30', 'PHX','DEN', {fn:'WN 891', tail:'N7737V', blk:110}),
    // May 31
    off(3,16,'DEN'),
];

// ── JORDAN ELLIS — American, JFK based ────────────────────────────────────
const jordan = [
    // May 1-3: JFK-LHR transatlantic
    seg(4, 'flight', -14,'09:00', -14,'21:00', 'JFK','LHR', {fn:'AA 100', tail:'N910AN', blk:420}),
    seg(4, 'flight', -12,'11:30', -12,'14:20', 'LHR','JFK', {fn:'AA 107', tail:'N910AN', blk:470}),
    // May 4-6: off
    off(4,-11,'JFK'), off(4,-10,'JFK'), off(4,-9,'JFK'),
    // May 7-8: JFK-ORD-MIA
    seg(4, 'flight',  -8,'08:00',  -8,'10:20', 'JFK','ORD', {fn:'AA 201', tail:'N922AN', blk:140}),
    seg(4, 'flight',  -8,'13:00',  -8,'17:15', 'ORD','MIA', {fn:'AA 315', tail:'N922AN', blk:175}),
    seg(4, 'flight',  -7,'09:30',  -7,'12:45', 'MIA','JFK', {fn:'AA 428', tail:'N922AN', blk:135}),
    seg(4, 'flight',  -7,'16:00',  -7,'17:30', 'JFK','BOS', {fn:'AA 512', tail:'N922AN', blk:90}),
    // May 9: off
    off(4,-6,'JFK'),
    // May 10-13: JFK-MAD transatlantic
    seg(4, 'flight',  -5,'09:15',  -5,'12:40', 'JFK','MIA', {fn:'AA 331', tail:'N922AN', blk:145}),
    seg(4, 'flight',  -5,'15:30',  -4,'05:10', 'MIA','MAD', {fn:'AA 946', tail:'N922AN', blk:520}),
    seg(4, 'flight',  -3,'12:00',  -3,'14:45', 'MAD','JFK', {fn:'AA 261', tail:'N922AN', blk:525}),
    // May 14-15: off
    off(4,-1,'JFK'), off(4,0,'JFK'),
    // May 16-18: JFK-LAX-JFK
    seg(4, 'flight',   1,'08:00',   1,'11:30', 'JFK','LAX', {fn:'AA 2',   tail:'N903AN', blk:360}),
    seg(4, 'flight',   2,'07:00',   2,'15:30', 'LAX','JFK', {fn:'AA 3',   tail:'N903AN', blk:330}),
    seg(4, 'flight',   3,'09:15',   3,'12:30', 'JFK','ORD', {fn:'AA 195', tail:'N903AN', blk:135}),
    // May 19-20: off
    off(4, 4,'JFK'), off(4, 5,'JFK'),
    // May 21-22: JFK-DFW
    seg(4, 'flight',   6,'07:30',   6,'11:00', 'JFK','DFW', {fn:'AA 375', tail:'N911AN', blk:210}),
    seg(4, 'flight',   6,'14:30',   6,'18:00', 'DFW','JFK', {fn:'AA 490', tail:'N911AN', blk:210}),
    seg(4, 'flight',   7,'09:00',   7,'12:30', 'JFK','ORD', {fn:'AA 601', tail:'N911AN', blk:150}),
    seg(4, 'flight',   7,'15:00',   7,'18:30', 'ORD','JFK', {fn:'AA 712', tail:'N911AN', blk:150}),
    // May 23-24: off
    off(4, 8,'JFK'), off(4, 9,'JFK'),
    // May 25-28: JFK-NRT transatlantic
    seg(4, 'flight',  10,'13:20',  10,'16:40', 'JFK','ORD', {fn:'AA 169', tail:'N903AN', dh:true, blk:140}),
    seg(4, 'flight',  10,'20:00',  11,'22:00', 'ORD','NRT', {fn:'AA 169', tail:'N903AN', blk:800}),
    seg(4, 'flight',  13,'11:00',  13,'10:00', 'NRT','JFK', {fn:'AA 170', tail:'N903AN', blk:820}),
    // May 29-31: off
    off(4,14,'JFK'), off(4,15,'JFK'), off(4,16,'JFK'),
];

const DEMO_SEGMENTS = { alex, morgan, casey, jordan };

module.exports = { DEMO_PILOTS, DEMO_SEGMENTS };
