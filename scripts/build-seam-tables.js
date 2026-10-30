// Parses data/seam-table-a.txt and data/seam-table-b.txt (NetJets 7&7/8&6 line-switch
// transition data, confirmed directly against the real line-visualizer/seam-visualizer tools'
// own source) into public/seam-tables.json -- one JSON lookup, loaded identically by server.js
// (fs.readFileSync) and app.html (fetch), same pattern as airports.json.
//
// Each source line: fromKey \t toKey \t <28 tab-separated fields, "X" = work day, "" = off day>.
// fromKey/toKey are like "7Line1" (7&7 family) or "8Line2" (8&6 family -- only lines 2,4,6,9,11,13
// are valid for 8&6, confirmed via the tool's own valid8And6Lines list).
const fs = require('fs');
const path = require('path');

function parseTable(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r\n|\n/).filter(Boolean);
    const table = {};
    for (const line of lines) {
        const cols = line.split('\t');
        const fromKey = cols[0], toKey = cols[1];
        const days = cols.slice(2, 30).map(c => c.trim().toUpperCase() === 'X' ? 1 : 0);
        if (days.length !== 28) throw new Error(`Expected 28 day columns, got ${days.length} for ${fromKey}->${toKey}`);
        if (!table[fromKey]) table[fromKey] = {};
        table[fromKey][toKey] = days;
    }
    return table;
}

const a = parseTable(path.join(__dirname, '..', 'data', 'seam-table-a.txt'));
const b = parseTable(path.join(__dirname, '..', 'data', 'seam-table-b.txt'));
const out = { a, b };
fs.writeFileSync(path.join(__dirname, '..', 'public', 'seam-tables.json'), JSON.stringify(out));
console.log(`Built public/seam-tables.json -- table a: ${Object.keys(a).length} from-keys, table b: ${Object.keys(b).length} from-keys`);
