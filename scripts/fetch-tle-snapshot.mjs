// Refresh public/tle-snapshot.txt (the bundled full-sky TLE catalog) from
// GitHub-hosted CelesTrak mirrors that are refreshed daily by their CI.
// Run occasionally: node scripts/fetch-tle-snapshot.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tle-snapshot.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SOURCES = [
  // Full active catalog first, then fresher per-group overlays
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
  'https://raw.githubusercontent.com/satvisorcom/satvisor-data/master/celestrak/tle/active.tle',
  'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/starlink.tle',
  'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/geo.tle',
  'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/oneweb.tle',
  'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/stations.tle',
  'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/weather.tle',
  'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/science.tle',
  'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/resource.tle',
  'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/military.tle',
];

function toMap(text) {
  const map = new Map();
  const lines = text.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      const name = lines[i];
      if (!name || name.startsWith('1 ') || name.startsWith('2 ')) continue;
      const id = lines[i + 1].substring(2, 7).trim();
      if (id) map.set(id, { name, l1: lines[i + 1], l2: lines[i + 2] });
      i += 2;
    }
  }
  return map;
}

const epoch = (e) => parseFloat(e.l1.substring(18, 32)) || 0;

const merged = new Map();
for (const url of SOURCES) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const map = toMap(await res.text());
    let newer = 0;
    for (const [id, e] of map) {
      const cur = merged.get(id);
      if (!cur || epoch(e) > epoch(cur)) { merged.set(id, e); newer++; }
    }
    console.log(`${url}\n  -> ${map.size} objects (${newer} added/updated), total ${merged.size}`);
  } catch (err) {
    console.log(`${url}\n  -> FAILED: ${err.message}`);
  }
}

// Non-fatal by design: this runs at build time. If the live sources are
// unreachable (or return too little), we KEEP the snapshot already committed
// in the repo and exit 0 so the deploy still succeeds with the last-known-good
// full catalog bundled into the site.
if (merged.size < 5000) {
  const existing = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
  if (existing > 0) {
    console.warn(
      `WARNING: only ${merged.size} objects fetched — keeping existing snapshot (${existing} bytes). Build continues.`
    );
    process.exit(0);
  }
  console.error(`FAILED: only ${merged.size} objects and no existing snapshot to fall back on.`);
  process.exit(1);
}

const parts = [];
for (const e of merged.values()) parts.push(`${e.name}\n${e.l1}\n${e.l2}`);
fs.writeFileSync(OUT, parts.join('\n') + '\n');
console.log(`WROTE ${OUT}: ${merged.size} objects`);
