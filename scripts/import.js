// Phase C: turn JSON exports of the claude.ai tracker into SQL for D1.
//   node scripts/import.js exports/ > import.sql
//   npx wrangler d1 execute road-to-scratch --remote --file=import.sql
// Each export file is <collection>.json (daily, rounds, tests, body, settings, coach) holding an array of
// documents: either { id, ...fields } or { id, data: { ...fields } }.
import fs from "node:fs";
import path from "node:path";
import { COLLECTIONS, toRow } from "../src/db.js";

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/import.js <exports-dir> > import.sql"); process.exit(1); }

const lit = v => (v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const out = [];
for (const coll of Object.keys(COLLECTIONS)) {
  const file = path.join(dir, `${coll}.json`);
  if (!fs.existsSync(file)) continue;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const docs = Array.isArray(raw) ? raw : raw.items || raw.docs || [];
  let n = 0;
  for (const d of docs) {
    const data = d.data && typeof d.data === "object" ? d.data : d;
    const pk = COLLECTIONS[coll].pk;
    const id = d.id ?? data[pk];
    if (!id) { console.error(`skipping ${coll} doc without id`); continue; }
    const row = toRow(coll, String(id), data);
    const cols = Object.keys(row);
    out.push(`INSERT OR REPLACE INTO ${coll} (${cols.join(", ")}) VALUES (${cols.map(c => lit(row[c])).join(", ")});`);
    n++;
  }
  console.error(`${coll}: ${n} rows`);
}
process.stdout.write(out.join("\n") + "\n");
