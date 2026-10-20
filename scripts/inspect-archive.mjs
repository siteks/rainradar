// Prints a summary of a model archive day file written by archive-model.mjs.
// Run: node scripts/inspect-archive.mjs data/model-archive/ukv-YYYY-MM-DD.bin.gz
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const buf = gunzipSync(readFileSync(process.argv[2]));
const headerLength = buf.readUInt32LE(0);
const header = JSON.parse(buf.subarray(4, 4 + headerLength).toString());
const payload = buf.subarray(4 + headerLength);
const view = (Type, { offset, length }) =>
  new Type(payload.buffer.slice(payload.byteOffset + offset, payload.byteOffset + offset + length));

console.log(`${header.format} v${header.version}, ${header.model}, ${header.day}`);
console.log(`grid ${header.grid.cols}×${header.grid.rows} (${header.grid.rowOrder}), wind ${header.windCols}×${header.windRows}`);
for (const run of header.runs) {
  const rows = run.fields.map((f) => {
    const p = view(Uint16Array, f.precipitation);
    let wet = 0;
    let max = 0;
    let missing = 0;
    for (const v of p) {
      if (v === header.precipitation.missing) missing++;
      else {
        if (v >= 1) wet++;
        if (v > max) max = v;
      }
    }
    return missing === p.length ? '  —  ' : `${String(Math.round((100 * wet) / p.length)).padStart(2)}%/${(max * header.precipitation.scale).toFixed(0)}`;
  });
  console.log(`run ${run.reference_time}  wet%/max mm by lead: ${rows.join(' ')}`);
}
