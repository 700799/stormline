// In-memory world state, feed ring buffer, and the broadcast bus.
// server.js subscribes to `bus`; loop.js/tools.js publish through pushFeed/broadcastState.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const FEED_MAX = 200;

function loadAssets() {
  const raw = JSON.parse(readFileSync(new URL('./data/assets.json', import.meta.url), 'utf8'));
  const boot = Date.now();
  return raw.map((a) => ({
    ...a,
    // time windows are stored as boot-relative offsets so demo day never has stale dates
    timeWindow: a.timeWindow
      ? {
          start: new Date(boot + a.timeWindow.startOffsetMin * 60_000).toISOString(),
          end: new Date(boot + (a.timeWindow.startOffsetMin + a.timeWindow.durationMin) * 60_000).toISOString(),
        }
      : null,
    status: 'safe', // safe | watch | threatened | handled
    distanceKm: null,
    lastAction: null, // { tool, summary, at }
    instruction: null, // set by reroute_delivery
  }));
}

export const state = {
  startedAt: new Date().toISOString(),
  tick: 0,
  weather: null, // normalized storm shape (see src/data/injected.js) or null
  injectedStorm: null,
  assets: loadAssets(),
  actionsTaken: [], // { dedupeKey, tool, assetId, threatId, input, rationale, at, result }
  actionKeys: new Set(),
  feed: [],
  lastWeatherHash: null,
  lastErrorText: null,
  agent: {
    running: false,
    ticking: false,
    lastTickAt: null,
    lastDecisionAt: null,
    lastError: null,
    sseClients: 0,
    model: process.env.FAKE_BRAIN === 'true' ? 'fake-brain' : process.env.BEDROCK_MODEL_ID || 'anthropic.claude-sonnet-4-6',
  },
};

let feedSeq = 0;

export function pushFeed({ type, text, data }) {
  const ev = { id: ++feedSeq, ts: new Date().toISOString(), type, text, ...(data ? { data } : {}) };
  state.feed.push(ev);
  if (state.feed.length > FEED_MAX) state.feed.splice(0, state.feed.length - FEED_MAX);
  console.log(`[${type}] ${text}`);
  bus.emit('feed', ev);
  return ev;
}

export function getPublicState() {
  return {
    service: 'stormline',
    demoMode: process.env.DEMO_MODE !== 'false',
    startedAt: state.startedAt,
    now: new Date().toISOString(),
    tick: state.tick,
    weather: state.weather,
    assets: state.assets,
    actionsTaken: state.actionsTaken.slice(-100),
    feed: state.feed.slice(-50),
    agent: { ...state.agent },
  };
}

export function broadcastState() {
  bus.emit('state', getPublicState());
}

export function recordAction(rec) {
  state.actionsTaken.push(rec);
  state.actionKeys.add(rec.dedupeKey);
}

export function hasAction(dedupeKey) {
  return state.actionKeys.has(dedupeKey);
}

export function resetWorld() {
  state.injectedStorm = null;
  state.weather = null;
  state.actionsTaken = [];
  state.actionKeys.clear();
  state.lastWeatherHash = null;
  state.lastErrorText = null;
  state.agent.lastError = null;
  for (const a of state.assets) {
    a.status = 'safe';
    a.distanceKm = null;
    a.lastAction = null;
    a.instruction = null;
  }
  pushFeed({ type: 'system', text: 'World state cleared — all assets reset to safe' });
}
