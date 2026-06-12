// ClickHouse decision/action log (M5). Purely additive: subscribes to the feed
// bus, buffers rows, and flushes them to ClickHouse's HTTP interface every few
// seconds — the agent loop never waits on it and a dead ClickHouse never hurts
// the demo. Without CLICKHOUSE_URL this module stays inert (documented, not
// silent-faked: /api/state shows stats.loggedRows only when enabled).
import { bus, state, pushFeed } from '../state.js';

const FLUSH_MS = 5000;
const MAX_BUFFER = 500;

let buffer = [];
let lastErrorText = null;

function table() {
  return process.env.CLICKHOUSE_TABLE || 'stormline_events';
}

async function chQuery(query, body) {
  const url = process.env.CLICKHOUSE_URL.replace(/\/$/, '');
  const r = await fetch(`${url}/?query=${encodeURIComponent(query)}`, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': process.env.CLICKHOUSE_USER || 'default',
      'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD || '',
      'content-type': 'text/plain',
    },
    signal: AbortSignal.timeout(8000),
    body: body ?? '',
  });
  if (!r.ok) throw new Error(`ClickHouse HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

// ts kept as an ISO String on purpose — lexicographic order == time order, and
// it sidesteps DateTime parse settings. Hackathon-simple, query-friendly.
async function ensureTable() {
  await chQuery(
    `CREATE TABLE IF NOT EXISTS ${table()} (
      ts String, tick UInt32, type String, text String,
      tool String, asset_id String, threat_id String, ok UInt8
    ) ENGINE = MergeTree ORDER BY ts`
  );
}

function reportError(e) {
  const msg = e?.message ?? String(e);
  if (msg !== lastErrorText) {
    lastErrorText = msg;
    pushFeed({ type: 'error', text: `ClickHouse log error — ${msg}` });
  }
}

async function flush() {
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  try {
    await chQuery(`INSERT INTO ${table()} FORMAT JSONEachRow`, rows.map((r) => JSON.stringify(r)).join('\n'));
    state.stats.loggedRows = (state.stats.loggedRows ?? 0) + rows.length;
    lastErrorText = null;
  } catch (e) {
    // keep rows for one retry, bounded so a long outage can't grow memory
    buffer = rows.concat(buffer).slice(-MAX_BUFFER);
    reportError(e);
  }
}

export function initClickHouse() {
  if (!process.env.CLICKHOUSE_URL) {
    console.log('[stormline] ClickHouse logging off (no CLICKHOUSE_URL)');
    return;
  }
  state.stats.loggedRows = 0;
  bus.on('feed', (ev) => {
    buffer.push({
      ts: ev.ts,
      tick: state.tick,
      type: ev.type,
      text: ev.text,
      tool: ev.data?.tool ?? '',
      asset_id: ev.data?.input?.asset_id ?? '',
      threat_id: state.weather?.id ?? '',
      ok: ev.type === 'error' ? 0 : 1,
    });
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  });
  setInterval(flush, FLUSH_MS).unref?.();
  ensureTable()
    .then(() => pushFeed({ type: 'system', text: `ClickHouse decision log enabled → table ${table()}` }))
    .catch(reportError);
}
