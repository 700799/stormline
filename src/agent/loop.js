// The autonomous loop: poll → assess → decide → act → broadcast.
// Guardrails live here: overlap guard, weather-hash skip, max 5 actions/tick,
// asset+threat dedupe, and try/catch around every external call.
import { state, pushFeed, broadcastState, recordAction, hasAction } from '../state.js';
import { advanceStorm } from '../data/injected.js';
import { decide, assetDistanceKm } from './brain.js';
import { runToolCall } from './tools.js';
import { getForecast } from '../data/jua.js';

const MAX_ACTIONS_PER_TICK = 5;

// Canonical key for "has the weather meaningfully changed since last tick?"
// 'clear' is stable (no Claude calls on quiet ticks); a live storm moves every
// tick, so the key changes and Claude re-evaluates — exactly per spec.
function weatherKey(w) {
  if (!w) return 'clear';
  return [w.id, w.severity, w.center.lat.toFixed(3), w.center.lon.toFixed(3), w.radius_km, Math.round(w.eta_minutes / 5) * 5].join('|');
}

async function tick() {
  state.tick += 1;
  const now = new Date().toISOString();

  // 1. SENSE — injected storm wins; else live forecast (M4) unless DEMO_MODE
  if (state.injectedStorm) {
    advanceStorm(state.injectedStorm);
    state.weather = state.injectedStorm;
    pushFeed({
      type: 'weather',
      text: `${state.weather.severity} storm ${state.weather.id} at ${state.weather.center.lat.toFixed(2)},${state.weather.center.lon.toFixed(2)} — ETA ~${state.weather.eta_minutes} min`,
    });
  } else if (process.env.DEMO_MODE === 'false') {
    try {
      state.weather = await getForecast();
    } catch (e) {
      pushFeed({ type: 'error', text: `Jua fetch failed — ${e?.message ?? e}` });
      state.weather = null;
    }
  } else {
    state.weather = null;
  }

  // 2. ASSESS — recompute distances + geometry-driven statuses before asking the brain
  for (const a of state.assets) {
    if (!state.weather) {
      a.distanceKm = null;
      continue;
    }
    a.distanceKm = Math.round(assetDistanceKm(a, state.weather.center) * 10) / 10;
    if (a.status === 'handled') continue; // sticky until mark_asset_safe or /api/demo/clear
    const prev = a.status;
    const next =
      a.distanceKm <= state.weather.radius_km ? 'threatened' : a.distanceKm <= state.weather.radius_km + 15 ? 'watch' : 'safe';
    if (next !== prev) {
      a.status = next;
      pushFeed({ type: 'status', text: `${a.id}: ${prev} → ${next} (${a.distanceKm} km from storm center)` });
    }
  }

  // 3. Skip the brain when nothing changed
  const key = weatherKey(state.weather);
  if (key === state.lastWeatherHash) {
    console.log(`[AGENT LOG] tick ${state.tick}: weather unchanged (${key === 'clear' ? 'clear skies' : key}) — skipping brain call`);
    broadcastState();
    return;
  }

  // 4. DECIDE
  let decision;
  try {
    decision = await decide({ tick: state.tick, now, weather: state.weather, assets: state.assets, actionsTaken: state.actionsTaken });
  } catch (e) {
    const msg = e?.message ?? String(e);
    state.agent.lastError = msg;
    console.log(`[AGENT LOG] brain call failed — ${msg}`);
    if (msg !== state.lastErrorText) {
      state.lastErrorText = msg; // anti-spam: feed only on a NEW error message
      pushFeed({ type: 'error', text: `Brain error — ${msg}` });
    }
    state.lastWeatherHash = key; // retry happens naturally on the next weather change
    broadcastState();
    return;
  }
  state.lastErrorText = null;
  state.agent.lastError = null;
  state.lastWeatherHash = key;
  state.agent.lastDecisionAt = now;

  if (decision.reasoning) pushFeed({ type: 'reasoning', text: decision.reasoning });

  // 5. ACT — guardrails: cap per tick, never repeat an action for the same asset+threat
  const threatId = state.weather?.id ?? 'clear';
  let executed = 0;
  for (const call of decision.toolCalls) {
    if (executed >= MAX_ACTIONS_PER_TICK) {
      console.log(`[AGENT LOG] guardrail: action cap (${MAX_ACTIONS_PER_TICK}) reached — skipping ${call.name}`);
      pushFeed({ type: 'system', text: `Action cap (${MAX_ACTIONS_PER_TICK}) reached — skipped ${call.name}` });
      continue;
    }
    const dedupeKey = `${call.name}:${call.input?.asset_id}:${threatId}`;
    if (hasAction(dedupeKey)) {
      console.log(`[AGENT LOG] guardrail: duplicate ${dedupeKey} — already done, skipping`);
      pushFeed({ type: 'system', text: `Skipped duplicate ${call.name} for ${call.input?.asset_id} (already handled this threat)` });
      continue;
    }
    const result = await runToolCall(call); // never throws
    recordAction({
      dedupeKey,
      tool: call.name,
      assetId: call.input?.asset_id,
      threatId,
      input: call.input,
      rationale: call.input?.rationale,
      at: new Date().toISOString(),
      result,
    });
    executed += 1;
  }

  // 6. SHOW
  broadcastState();
}

async function safeTick(reason) {
  if (state.agent.ticking) return; // overlap guard — never run two ticks at once
  state.agent.ticking = true;
  try {
    await tick();
  } catch (e) {
    state.agent.lastError = e?.message ?? String(e);
    pushFeed({ type: 'error', text: `Tick failed — ${state.agent.lastError}` });
  } finally {
    state.agent.ticking = false;
    state.agent.lastTickAt = new Date().toISOString();
  }
}

export function startLoop() {
  const pollMs = (Number(process.env.POLL_SECONDS) || 30) * 1000;
  state.agent.running = true;
  safeTick('boot');
  setInterval(() => safeTick('interval'), pollMs);
  console.log(`[loop] started — polling every ${pollMs / 1000}s (DEMO_MODE=${process.env.DEMO_MODE !== 'false'})`);
}

// Fire-and-forget extra tick (used by /api/demo/inject-storm for a snappy demo).
export function triggerTickNow(reason) {
  console.log(`[AGENT LOG] immediate tick triggered (${reason})`);
  safeTick(reason);
}
