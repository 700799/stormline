// The agent's brain: Bedrock/Claude call — prompt build, tool definitions, parse.
// One-shot by design: each tick is a fresh messages.create with fresh context;
// tool_use blocks are treated as structured decisions (no tool_result round-trip).
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { getComposioOpenAITools } from './tools.js';

// Pinned to Sonnet 4.5 — do NOT default to 4.6 or higher (account constraint).
export const DEFAULT_MODEL = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';
// Tried in order after the primary model fails; all ≤ 4.5 on purpose.
const DEFAULT_OPENROUTER_FALLBACKS = 'anthropic/claude-sonnet-4,anthropic/claude-3.5-sonnet';

function openRouterModels() {
  const primary = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  const extras = (process.env.OPENROUTER_FALLBACK_MODELS || DEFAULT_OPENROUTER_FALLBACKS)
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([primary, ...extras])];
}

// Bedrock on-demand vs inference-profile: many accounts only allow the
// geo-prefixed inference profile (us./eu./apac.) — try that flavor FIRST,
// then the bare id, then pinned ≤4.5 last resorts.
function bedrockGeo() {
  const region = process.env.AWS_REGION || 'us-west-2';
  if (region.startsWith('eu')) return 'eu';
  if (region.startsWith('ap')) return 'apac';
  return 'us';
}

function bedrockModels() {
  const geo = bedrockGeo();
  const configured = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL;
  const flavors = configured.startsWith(`${geo}.`)
    ? [configured, configured.slice(geo.length + 1)]
    : [`${geo}.${configured}`, configured];
  return [
    ...new Set([
      ...flavors,
      `${geo}.anthropic.claude-sonnet-4-5-20250929-v1:0`,
      'anthropic.claude-sonnet-4-5-20250929-v1:0',
      `${geo}.anthropic.claude-3-5-sonnet-20241022-v2:0`,
    ]),
  ];
}

// FAKE_BRAIN wins; then explicit BRAIN_PROVIDER; else auto-detect by key.
function brainProvider() {
  const forced = process.env.BRAIN_PROVIDER;
  if (forced === 'openrouter' || forced === 'bedrock') return forced;
  return process.env.OPENROUTER_API_KEY ? 'openrouter' : 'bedrock';
}

export function activeModelLabel() {
  if (process.env.FAKE_BRAIN === 'true') return 'fake-brain';
  return brainProvider() === 'openrouter'
    ? `openrouter:${process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL}`
    : process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL;
}

// Every tool carries these two: `rationale` powers the dashboard reasoning feed,
// `asset_id` gives dedupe a uniform asset identity (key = tool:asset_id:threatId).
const rationale = {
  type: 'string',
  description: 'One short sentence explaining this action. Shown verbatim on a live ops dashboard.',
};
const asset_id = {
  type: 'string',
  description: 'ID of the tracked asset this action protects, e.g. "route-7". For reschedule_event/reroute_delivery this matches event_id/route_id.',
};

export const TOOLS = [
  {
    name: 'send_slack_alert',
    description: 'Send an alert to an internal Slack channel. Call this when a field crew or internal ops team must be warned about an approaching threat, or to confirm all-clear after handling.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel name, e.g. "#field-crew-north"' },
        message: { type: 'string' },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        asset_id,
        rationale,
      },
      required: ['channel', 'message', 'severity', 'asset_id', 'rationale'],
    },
  },
  {
    name: 'send_customer_email',
    description: 'Email an external contact (e.g. an event organizer) about a weather threat affecting them. Call this when an outdoor event or customer-facing asset is threatened.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        asset_id,
        rationale,
      },
      required: ['to', 'subject', 'body', 'asset_id', 'rationale'],
    },
  },
  {
    name: 'reschedule_event',
    description: "Move an event to a new start time. Call this when an outdoor event's time window overlaps a high-confidence threat.",
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        new_start_iso: { type: 'string', description: 'ISO-8601 UTC, after the threat has passed' },
        reason: { type: 'string' },
        asset_id,
        rationale,
      },
      required: ['event_id', 'new_start_iso', 'reason', 'asset_id', 'rationale'],
    },
  },
  {
    name: 'reroute_delivery',
    description: 'Issue a reroute instruction for a delivery route (state update only, no real routing API). Call this when a route passes inside or near the threat area during its time window.',
    input_schema: {
      type: 'object',
      properties: {
        route_id: { type: 'string' },
        instruction: { type: 'string', description: 'Plain-language reroute instruction for dispatch' },
        asset_id,
        rationale,
      },
      required: ['route_id', 'instruction', 'asset_id', 'rationale'],
    },
  },
  {
    name: 'mark_asset_safe',
    description: 'Mark an asset as safe. Call this when a previously threatened or handled asset is no longer at risk (threat passed or moved away).',
    input_schema: {
      type: 'object',
      properties: {
        asset_id,
        reason: { type: 'string' },
        rationale,
      },
      required: ['asset_id', 'reason', 'rationale'],
    },
  },
];

const SYSTEM_PROMPT = `You are Stormline, an autonomous severe-weather and wildfire operations agent for the California Bay Area. You protect the business assets listed in each update. No human reviews your decisions — you act, or you don't.

Rules:
- Act decisively when threat confidence is >= 0.7 AND an asset is inside or near the threat area, or its time window overlaps the threat window.
- If the incoming threat data shows "severe" or "extreme" levels, you MUST dispatch a live emergency alert — via send_slack_alert, or the SLACK_SEND_MESSAGE external tool when available — detailing the threat's ETA and the affected assets, before any other action.
- Every tool call's "rationale" must be one short sentence; it is shown live on an ops dashboard.
- NEVER repeat an action listed under ACTIONS ALREADY TAKEN. If everything necessary is already done, make no tool calls.
- When the threat to a previously alerted asset has passed or moved away, call mark_asset_safe.
- If no asset is threatened, make no tool calls and reply with one short all-clear status line.
- At most 5 tool calls per turn. Handle the most urgent assets first (closest, soonest time window, highest sensitivity).
Keep all prose to terse ops-log lines.`;

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Min distance from an asset's geometry (point or polyline vertices) to a point.
export function assetDistanceKm(asset, center) {
  const pts = asset.geometry.type === 'point' ? [asset.geometry.coordinates] : asset.geometry.coordinates;
  return Math.min(...pts.map(([lat, lon]) => haversineKm({ lat, lon }, center)));
}

const hhmm = (iso) => `${iso.slice(11, 16)}Z`;

// Rebuilt every tick. Distances are pre-computed in JS — never make the model do geo math.
export function buildUserMessage({ tick, now, weather, assets, actionsTaken }) {
  const lines = [`TICK ${tick} — ${now} (all times UTC)`, '', 'THREAT:'];
  if (weather && weather.kind === 'wildfire') {
    lines.push(
      `${weather.severity.toUpperCase()} WILDFIRE ${weather.id}: fire front at ${weather.center.lat.toFixed(2)},${weather.center.lon.toFixed(2)}, ` +
        `burn radius ${weather.radius_km} km and GROWING (~${weather.spread_km} km per update), wind ${weather.wind_kph} kph pushing it bearing ${weather.movement.bearing_deg}° (toward the SW). ` +
        `Confidence ${weather.confidence}, ETA to in-path assets ~${weather.eta_minutes} min.`
    );
  } else if (weather) {
    lines.push(
      `${weather.severity.toUpperCase()} ${weather.kind} ${weather.id}: center ${weather.center.lat.toFixed(2)},${weather.center.lon.toFixed(2)}, ` +
        `radius ${weather.radius_km} km, moving at ${weather.movement.speed_kmh} km/h bearing ${weather.movement.bearing_deg}°. ` +
        `Wind ${weather.wind_kph} kph, rain ${weather.rain_mm_h} mm/h, confidence ${weather.confidence}, ETA ~${weather.eta_minutes} min.`
    );
  } else {
    lines.push('No active threats.');
  }

  lines.push('', 'ASSETS:');
  for (const a of assets) {
    const parts = [a.type === 'outdoor_event' ? `${a.id} "${a.name}"` : a.id];
    parts.push(a.type.replaceAll('_', ' ') + (a.sensitivity === 'low' ? ' (low sensitivity)' : ''));
    parts.push(`status: ${a.status}`);
    parts.push(a.timeWindow ? `window ${hhmm(a.timeWindow.start)}–${hhmm(a.timeWindow.end)}` : 'static');
    if (a.contact?.email) parts.push(`contact ${a.contact.email}`);
    if (a.contact?.slack) parts.push(`slack ${a.contact.slack}`);
    if (weather && a.distanceKm != null) {
      let tag = '';
      if (a.distanceKm <= weather.radius_km) tag = ` (INSIDE ${weather.radius_km} km radius)`;
      else if (a.distanceKm <= weather.radius_km + 15) tag = ' (NEAR)';
      parts.push(`${a.distanceKm.toFixed(1)} km from storm center${tag}`);
    }
    lines.push(`- ${parts.join(' | ')}`);
  }

  lines.push('', 'ACTIONS ALREADY TAKEN (do not repeat):');
  const recent = actionsTaken.slice(-15);
  if (recent.length === 0) lines.push('none');
  for (const r of recent) lines.push(`- [${hhmm(r.at)}] ${r.tool} → ${r.assetId} (${r.threatId}): "${r.rationale}"`);

  lines.push('', 'Decide now. Call tools only for NEW actions.');
  return lines.join('\n');
}

let client = null;

// Demo logging: one labeled line per step of the decision so the agent's
// thought process is followable straight from the server console.
function logDecision(decision, source) {
  console.log(`[AGENT LOG] thought process (${source}): ${decision.reasoning || '(no prose returned)'}`);
  if (decision.toolCalls.length === 0) {
    console.log('[AGENT LOG] decision: no action needed this tick');
  } else {
    console.log(
      `[AGENT LOG] decision: ${decision.toolCalls.length} action(s) → ` +
        decision.toolCalls.map((c) => `${c.name}(${c.input?.asset_id})`).join(', ')
    );
  }
  return decision;
}

// → { reasoning: string, toolCalls: [{id, name, input}], stopReason }
export async function decide(ctx) {
  const userMessage = buildUserMessage(ctx);
  console.log(`[AGENT LOG] ── tick ${ctx.tick}: context sent to the brain ──\n${userMessage}\n[AGENT LOG] ── end context ──`);

  if (process.env.FAKE_BRAIN === 'true') {
    console.log('[AGENT LOG] FAKE_BRAIN=true — canned decision, no model call');
    return logDecision(fakeDecision(ctx), 'fake brain');
  }

  // Demo-resilience policy (user-directed): a failed model call must never
  // surface as an error on the dashboard. Fall back — first across models
  // (OpenRouter chain), then to the local rules engine. Every failover is
  // recorded loudly here in [AGENT LOG]; the feed just keeps acting.
  try {
    if (brainProvider() === 'openrouter') return await decideOpenRouter(userMessage);
    return await decideBedrock(userMessage);
  } catch (e) {
    console.log(`[AGENT LOG] FALLBACK: all model calls failed (${e?.message ?? e}) — local rules engine takes this tick`);
    return logDecision(fakeDecision(ctx, ''), 'rules-engine fallback');
  }
}

async function decideBedrock(userMessage) {
  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
    throw new Error('no model credentials configured (OPENROUTER_API_KEY or AWS_*)');
  }
  // SDK default timeout is 10 minutes — combined with the loop's overlap guard
  // that would freeze all future ticks behind one hung call.
  client ??= new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION || 'us-west-2',
    timeout: 25_000,
    maxRetries: 1,
  });

  let lastError;
  for (const model of bedrockModels()) {
    try {
      console.log(`[AGENT LOG] calling Claude on Bedrock (${model}) with ${TOOLS.length} tools…`);
      const msg = await client.messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: [{ role: 'user', content: userMessage }],
      });
      console.log(`[AGENT LOG] raw Bedrock response (stop_reason=${msg.stop_reason}):\n${JSON.stringify(msg.content, null, 2)}`);
      return logDecision(
        {
          reasoning: msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
          toolCalls: msg.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })),
          stopReason: msg.stop_reason,
        },
        model
      );
    } catch (e) {
      lastError = e;
      console.log(`[AGENT LOG] model ${model} failed (${e?.message ?? e}) — trying next in chain`);
    }
  }
  throw lastError ?? new Error('Bedrock: empty model chain');
}

// Claude via OpenRouter (OpenAI-compatible chat completions + function calling).
// Same one-shot pattern as the Bedrock path; tool defs are reused via a 1:1 map.
async function decideOpenRouter(userMessage) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter not configured: set OPENROUTER_API_KEY (or unset BRAIN_PROVIDER to use Bedrock)');
  }
  const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  // Composio's own OpenAI-formatted tool defs, appended to the curated five
  // (empty when no COMPOSIO_API_KEY or Composio is unreachable).
  const dynamicTools = await getComposioOpenAITools();

  let lastError;
  for (const model of openRouterModels()) {
    try {
      console.log(`[AGENT LOG] calling Claude via OpenRouter (${model}) with ${TOOLS.length}+${dynamicTools.length} tools…`);
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(25_000), // same hang-protection rationale as the Bedrock client
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          tools: [
            ...TOOLS.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.input_schema },
            })),
            ...dynamicTools,
          ],
        }),
      });
      if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const data = await r.json();
      const msg = data.choices?.[0]?.message ?? {};
      const finishReason = data.choices?.[0]?.finish_reason ?? 'unknown';
      console.log(`[AGENT LOG] raw OpenRouter response (finish_reason=${finishReason}):\n${JSON.stringify(msg, null, 2)}`);

      const toolCalls = [];
      for (const c of msg.tool_calls ?? []) {
        try {
          toolCalls.push({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') });
        } catch (e) {
          // fail soft, consistent with the dispatcher: one bad call never kills the tick
          console.log(`[AGENT LOG] skipping malformed tool call ${c.function?.name ?? '?'} — ${e.message}`);
        }
      }
      return logDecision({ reasoning: (msg.content ?? '').trim(), toolCalls, stopReason: finishReason }, `openrouter:${model}`);
    } catch (e) {
      lastError = e;
      console.log(`[AGENT LOG] model ${model} failed (${e?.message ?? e}) — trying next in chain`);
    }
  }
  throw lastError ?? new Error('OpenRouter: empty model chain');
}

// Deterministic canned decisions. Used two ways: FAKE_BRAIN=true dev mode
// (labeled "(fake brain) ") and as the silent last-resort fallback when every
// model call fails (label '' — the feed stays clean; the failover is recorded
// in [AGENT LOG]). Re-issues the same calls every tick on purpose — that
// exercises the dedupe guardrail end to end.
function fakeDecision({ weather, assets }, label = '(fake brain) ') {
  if (!weather) {
    return { reasoning: `${label}All clear — no active threats.`, toolCalls: [], stopReason: 'end_turn' };
  }
  const kind = weather.kind ?? 'storm';
  const nearby = assets
    .filter((a) => a.distanceKm != null && a.distanceKm <= weather.radius_km + 15)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  if (nearby.length === 0) {
    return { reasoning: `${label}${kind} ${weather.id} active but no asset within range yet. Monitoring.`, toolCalls: [], stopReason: 'end_turn' };
  }
  // Act on the 3 closest in-range assets (loop still enforces the 5-action cap;
  // re-issuing the same calls every tick exercises the dedupe guardrail).
  const targets = nearby.slice(0, 3);
  const toolCalls = [];
  for (const target of targets) {
    toolCalls.push({
      id: `fake-${toolCalls.length + 1}`,
      name: 'send_slack_alert',
      input: {
        channel: target.contact?.slack ?? '#ops',
        message: `${weather.severity} ${kind} ${weather.id} approaching ${target.id} — ETA ~${weather.eta_minutes} min`,
        severity: 'critical',
        asset_id: target.id,
        rationale: `${label}${target.id} is ${target.distanceKm.toFixed(1)} km from the ${kind} front.`,
      },
    });
    if (target.type === 'delivery_route' && toolCalls.length < 5) {
      toolCalls.push({
        id: `fake-${toolCalls.length + 1}`,
        name: 'reroute_delivery',
        input: {
          route_id: target.id,
          instruction: kind === 'wildfire' ? 'Hold departures and route around the fire perimeter to the east.' : 'Hold departures and route around the storm cell to the east.',
          asset_id: target.id,
          rationale: `${label}Route intersects the ${kind} track during its active window.`,
        },
      });
    }
    if (toolCalls.length >= 5) break;
  }
  return {
    reasoning: `${label}${weather.severity} ${kind} ${weather.id} threatens ${targets.map((t) => `${t.id} (${t.distanceKm.toFixed(1)} km)`).join(', ')}. Alerting and protecting the closest assets first.`,
    toolCalls,
    stopReason: 'tool_use',
  };
}
