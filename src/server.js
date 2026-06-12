// Express app: dashboard, world-state API, SSE stream, demo triggers.
// NOTE: never add compression middleware — it buffers SSE.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { state, bus, pushFeed, broadcastState, getPublicState, resetWorld } from './state.js';
import { createStorm } from './data/injected.js';
import { startLoop, triggerTickNow } from './agent/loop.js';

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
  bus.on('feed', onFeed);
  bus.on('state', onState);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': hb\n\n');
  }, 25_000);

  state.agent.sseClients += 1;
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('feed', onFeed);
    bus.off('state', onState);
    state.agent.sseClients -= 1;
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[stormline] listening on :${port} — demoMode=${process.env.DEMO_MODE !== 'false'}`);
  startLoop();
});
