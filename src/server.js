// Express app: dashboard, world-state API, SSE stream, demo triggers.
// NOTE: never add compression middleware — it buffers SSE.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { state, bus, pushFeed, pushAgentLog, broadcastState, getPublicState, resetWorld } from './state.js';
import { createStorm } from './data/injected.js';
import { startLoop, triggerTickNow } from './agent/loop.js';
import { initClickHouse } from './log/clickhouse.js';

// UI-layer tap: mirror every '[AGENT LOG]' console line into state + SSE so the
// dashboard can show the live agent log. Purely additive — the agent code and
// polling loop are untouched.
const consoleLog = console.log.bind(console);
console.log = (...args) => {
  consoleLog(...args);
  try {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (line.startsWith('[AGENT LOG]')) pushAgentLog(line);
  } catch {
    /* never let UI logging break the agent */
  }
};

const app = express();
app.use(express.json());

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(fileURLToPath(new URL('../public/dashboard.html', import.meta.url)));
});

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/api/state', (req, res) => res.json(getPublicState()));

// Demo trigger: controls WHEN a storm happens, never WHAT the agent does about it.
app.post('/api/demo/inject-storm', (req, res) => {
  const body = req.body ?? {};
  if (body.intensity && !['moderate', 'severe', 'extreme'].includes(body.intensity)) {
    return res.status(400).json({ error: 'intensity must be moderate|severe|extreme' });
  }
  try {
    const storm = createStorm(body, state.assets);
    state.injectedStorm = storm; // re-inject replaces: new id → fresh dedupe space
    state.weather = storm;
    pushFeed({
      type: 'weather',
      text: `Injected ${storm.severity} storm targeting ${body.target ?? 'route-7'} — ETA ~${storm.eta_minutes} min, confidence ${storm.confidence}`,
    });
    triggerTickNow('inject-storm'); // not awaited: decisions arrive over SSE seconds later
    res.status(202).json({ ok: true, storm });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/demo/clear', (req, res) => {
  resetWorld();
  broadcastState();
  res.json({ ok: true });
});

// OpenUI (3rd sponsor): generate a professional status-card component from the
// live world state. OpenAI-chat-completions-compatible endpoint; everything is
// env-overridable. Without a key → 503 and the dashboard shows a labeled local
// fallback card (never a silent fake).
app.get('/api/ui/openui-card', async (req, res) => {
  const key = process.env.OPENUI_API_KEY || process.env.THESYS_API_KEY;
  if (!key) {
    return res.status(503).json({ error: 'OpenUI key not set (OPENUI_API_KEY or THESYS_API_KEY) — using local fallback card' });
  }
  const base = (process.env.OPENUI_BASE_URL || 'https://api.thesys.dev/v1/embed').replace(/\/$/, '');
  const model = process.env.OPENUI_MODEL || 'c1/anthropic/claude-sonnet-4/v-20250617';
  const s = getPublicState();
  const summary = {
    tick: s.tick,
    weather: s.weather
      ? { severity: s.weather.severity, kind: s.weather.kind, eta_minutes: s.weather.eta_minutes, confidence: s.weather.confidence }
      : null,
    assets: s.assets.map((a) => ({ id: a.id, status: a.status, distanceKm: a.distanceKm })),
    actionsTaken: s.actionsTaken.length,
    lastActions: s.actionsTaken.slice(-3).map((a) => a.result?.summary ?? a.tool),
  };
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'You render a single professional dark-theme ops status card for a severe-weather operations dashboard. Respond with ONE self-contained HTML fragment: inline CSS only, background #11161d, text #e8eef5, status colors green #22c55e / amber #f59e0b / red #ef4444 / blue #3b82f6, no scripts, no external resources, no markdown fences.',
          },
          { role: 'user', content: `Live Stormline state, render the status card now: ${JSON.stringify(summary)}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenUI HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('OpenUI returned an empty completion');
    res.json({ ok: true, generatedAt: new Date().toISOString(), content });
  } catch (e) {
    res.status(502).json({ error: e?.message ?? String(e) });
  }
});

// SSE: named events `state` (full state on connect + per tick) and `feed`
// (one human-readable event, pushed live mid-tick). Heartbeat comment every 25s.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // defeat proxy buffering (Render)
  });
  res.write('retry: 3000\n\n');
  res.flushHeaders();

  const send = (event, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  send('state', getPublicState());

  const onFeed = (ev) => send('feed', ev);
  const onState = (s) => send('state', s);
  const onAgentLog = (entry) => send('agentlog', entry);
  bus.on('feed', onFeed);
  bus.on('state', onState);
  bus.on('agentlog', onAgentLog);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': hb\n\n');
  }, 25_000);

  state.agent.sseClients += 1;
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('feed', onFeed);
    bus.off('state', onState);
    bus.off('agentlog', onAgentLog);
    state.agent.sseClients -= 1;
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[stormline] listening on :${port} — demoMode=${process.env.DEMO_MODE !== 'false'}`);
  initClickHouse();
  startLoop();
});
