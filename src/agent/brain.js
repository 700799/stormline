// The agent's brain: Bedrock/Claude call — prompt build, tool definitions, parse.
// One-shot by design: each tick is a fresh messages.create with fresh context;
// tool_use blocks are treated as structured decisions (no tool_result round-trip).
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

export const DEFAULT_MODEL = 'anthropic.claude-sonnet-4-6';

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

const SYSTEM_PROMPT = `You are Stormline, an autonomous severe-weather operations agent. You protect the business assets listed in each update. No human reviews your decisions — you act, or you don't.

Rules:
- Act decisively when threat confidence is >= 0.7 AND an asset is inside or near the threat area, or its time window overlaps the threat window.
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
  const lines = [`TICK ${tick} — ${now} (all times UTC)`, '', 'WEATHER:'];
  if (weather) {
    lines.push(
      `${weather.severity.toUpperCase()} ${weather.kind} ${weather.id}: center ${weather.center.lat.toFixed(2)},${weather.center.lon.toFixed(2)}, ` +
        `radius ${weather.radius_km} km, moving at ${weather.movement.speed_kmh} km/h bearing ${weather.movement.bearing_deg}°. ` +
        `Wind ${weather.wind_kph} kph, rain ${weather.rain_mm_h} mm/h, confidence ${weather.confidence}, ETA ~${weather.eta_minutes} min.`
    );
  } else {
    lines.push('No active weather threats.');
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
    console.log('[AGENT LOG] FAKE_BRAIN=true — canned decision, no Bedrock call');
    return logDecision(fakeDecision(ctx), 'fake brain');
  }

  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
    throw new Error('Bedrock not configured: set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION (or FAKE_BRAIN=true for a dry run)');
  }
  // SDK default timeout is 10 minutes — combined with the loop's overlap guard
  // that would freeze all future ticks behind one hung call.
  client ??= new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION || 'us-west-2',
    timeout: 25_000,
    maxRetries: 1,
  });

  const model = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL;
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
}

// Deterministic canned decisions (FAKE_BRAIN=true): clearly labeled, re-issues the
// same calls every tick on purpose — that exercises the dedupe guardrail end to end.
function fakeDecision({ weather, assets }) {
  if (!weather) {
    return { reasoning: '(fake brain) All clear — no active threats.', toolCalls: [], stopReason: 'end_turn' };
  }
  const nearby = assets
    .filter((a) => a.distanceKm != null && a.distanceKm <= weather.radius_km + 15)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const target = nearby[0];
  if (!target) {
    return { reasoning: `(fake brain) Storm ${weather.id} active but no asset within range yet. Monitoring.`, toolCalls: [], stopReason: 'end_turn' };
  }
  const toolCalls = [
    {
      id: 'fake-1',
      name: 'send_slack_alert',
      input: {
        channel: target.contact?.slack ?? '#ops',
        message: `${weather.severity} storm ${weather.id} approaching ${target.id} — ETA ~${weather.eta_minutes} min`,
        severity: 'critical',
        asset_id: target.id,
        rationale: `(fake brain) ${target.id} is ${target.distanceKm.toFixed(1)} km from the storm center.`,
      },
    },
  ];
  if (target.type === 'delivery_route') {
    toolCalls.push({
      id: 'fake-2',
      name: 'reroute_delivery',
      input: {
        route_id: target.id,
        instruction: 'Hold departures and route around the storm cell to the east.',
        asset_id: target.id,
        rationale: '(fake brain) Route intersects the storm track during its active window.',
      },
    });
  }
  return {
    reasoning: `(fake brain) ${weather.severity} storm ${weather.id} threatens ${target.id} (${target.distanceKm.toFixed(1)} km). Alerting and protecting it.`,
    toolCalls,
    stopReason: 'tool_use',
  };
}
