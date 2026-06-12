// Action executors. The dispatcher (runToolCall) owns validation, asset status
// updates, and feed output; the executor BODIES are the Composio integration
// point. Asset status changes only when result.ok AND mutateAsset — a failed
// real send must never mark an asset handled.
//
// With COMPOSIO_API_KEY set, send_slack_alert / send_customer_email /
// reschedule_event execute for real via Composio (@composio/core), each with a
// slug fallback chain (same philosophy as the brain's model chain); without a
// key they stay in the clearly-labeled WOULD-EXECUTE dry-run mode.
// reroute_delivery and mark_asset_safe are state-only by spec.
import { Composio } from '@composio/core';
import { state, pushFeed } from '../state.js';

let composio = null;
const hasComposio = () => Boolean(process.env.COMPOSIO_API_KEY);
const composioUserId = () => process.env.COMPOSIO_USER_ID || 'default';

function client() {
  composio ??= new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false });
  return composio;
}

// Try each slug in order — catalogs vary by account/version; the first one that
// the account knows wins. Throws the last error if the whole chain fails.
async function executeComposio(slugs, args) {
  let lastError;
  for (const slug of slugs) {
    try {
      console.log(`[AGENT LOG] composio execute ${slug} — args: ${JSON.stringify(args)}`);
      const res = await client().tools.execute(slug, {
        userId: composioUserId(),
        arguments: args,
        // Hackathon: skip toolkit version pinning; pin versions for production.
        dangerouslySkipVersionCheck: true,
      });
      console.log(`[AGENT LOG] composio ${slug} → successful=${res.successful}${res.error ? ` error=${res.error}` : ''}`);
      if (!res.successful) throw new Error(res.error || `${slug} reported failure`);
      return res;
    } catch (e) {
      lastError = e;
      console.log(`[AGENT LOG] composio ${slug} failed (${e?.message ?? e}) — trying next slug in chain`);
    }
  }
  throw lastError ?? new Error('composio: empty slug chain');
}

// ── Composio dynamic tools (appended to the OpenRouter tools array) ──
// composio.tools.get() returns OpenAI-formatted tool definitions (OpenRouter
// speaks OpenAI), so the brain can call SLACK_SEND_MESSAGE / GMAIL_SEND_EMAIL
// directly. Cached after first fetch; empty when no key or unreachable —
// the curated five tools always remain.
let dynamicTools = null;
const dynamicToolNames = new Set();
const DYNAMIC_SLUGS = ['SLACK_SEND_MESSAGE', 'GMAIL_SEND_EMAIL'];

export async function getComposioOpenAITools() {
  if (!hasComposio()) return [];
  if (dynamicTools) return dynamicTools;
  const fetched = [];
  for (const slug of DYNAMIC_SLUGS) {
    try {
      const got = await client().tools.get(composioUserId(), slug);
      for (const tool of Array.isArray(got) ? got : [got]) {
        const name = tool?.function?.name ?? tool?.name;
        if (name) {
          dynamicToolNames.add(name);
          fetched.push(tool);
        }
      }
      console.log(`[AGENT LOG] composio dynamic tool loaded: ${slug}`);
    } catch (e) {
      console.log(`[AGENT LOG] composio dynamic tool ${slug} unavailable — ${e?.message ?? e}`);
    }
  }
  dynamicTools = fetched;
  if (fetched.length) {
    pushFeed({ type: 'system', text: `Composio direct tools armed for the brain: ${[...dynamicToolNames].join(', ')}` });
  }
  return dynamicTools;
}

export const isDynamicComposioTool = (name) => dynamicToolNames.has(name);

// Direct execution for a dynamic Composio tool call (no curated executor, no
// asset to mutate — feed line + result only).
async function runDynamicComposio(call) {
  const target = call.input?.channel ?? call.input?.recipient_email ?? '';
  const summary = `${call.name} (composio direct)${target ? ` → ${target}` : ''}`;
  try {
    console.log(`[AGENT LOG] executing dynamic composio tool ${call.name} — input: ${JSON.stringify(call.input)}`);
    await executeComposio([call.name], call.input ?? {});
    pushFeed({
      type: 'action',
      text: `EXECUTED ${summary} — ${call.input?.rationale ?? 'live emergency alert'}`,
      data: { tool: call.name, input: call.input, simulated: false },
    });
    return { ok: true, simulated: false, summary };
  } catch (e) {
    const error = e?.message ?? String(e);
    pushFeed({ type: 'system', text: `⚠ ${call.name} could not be delivered — see console log` });
    return { ok: false, error };
  }
}

// Boot-time visibility: list connected accounts so a missing Slack/Gmail
// connection is obvious BEFORE the demo, not during it. Never blocks boot.
export async function initComposio() {
  if (!hasComposio()) {
    console.log('[stormline] Composio off (no COMPOSIO_API_KEY) — actions run in labeled dry-run mode');
    return;
  }
  try {
    const res = await client().connectedAccounts.list({ userId: composioUserId() });
    const items = res?.items ?? (Array.isArray(res) ? res : []);
    const toolkits = [...new Set(items.map((a) => a?.toolkit?.slug ?? a?.toolkit ?? a?.appName).filter(Boolean))];
    pushFeed({
      type: 'system',
      text: toolkits.length
        ? `Composio connected — accounts: ${toolkits.join(', ')}`
        : `Composio key set but no connected accounts for user "${composioUserId()}" — connect Slack/Gmail/GCal in the Composio dashboard`,
    });
  } catch (e) {
    console.log(`[AGENT LOG] composio boot check failed — ${e?.message ?? e}`);
    pushFeed({ type: 'system', text: '⚠ Composio key set but boot check failed — real sends may fail (see console log)' });
  }
}

const executors = {
  async send_slack_alert(input) {
    const channel = process.env.SLACK_CHANNEL_ID || input.channel;
    const summary = `send_slack_alert → ${channel} [${input.severity}]: "${input.message}"`;
    if (!hasComposio()) {
      console.log('[tool] would execute send_slack_alert', JSON.stringify(input));
      return { ok: true, simulated: true, summary };
    }
    await executeComposio(['SLACK_SEND_MESSAGE', 'SLACK_CHAT_POST_MESSAGE'], {
      channel: String(channel).replace(/^#/, ''), // accepts channel name or ID; '#' is display-only
      text: `:fire: [${input.severity.toUpperCase()}] ${input.message}\n_— Stormline autonomous agent_`,
    });
    return { ok: true, simulated: false, summary };
  },

  async send_customer_email(input, asset) {
    const to = process.env.DEMO_EMAIL_TO || input.to || asset.contact?.email || 'ops@stormline.example';
    const summary = `send_customer_email → ${to}: "${input.subject}"`;
    if (!hasComposio()) {
      console.log('[tool] would execute send_customer_email', JSON.stringify(input));
      return { ok: true, simulated: true, summary };
    }
    await executeComposio(['GMAIL_SEND_EMAIL'], {
      recipient_email: to,
      subject: input.subject,
      body: `${input.body}\n\n— Stormline autonomous weather & wildfire agent`,
    });
    return { ok: true, simulated: false, summary };
  },

  async reschedule_event(input, asset) {
    // Always apply the state-only shift so the dashboard reflects the move.
    const start = new Date(input.new_start_iso);
    if (asset.timeWindow && !Number.isNaN(start.getTime())) {
      const durationMs = new Date(asset.timeWindow.end) - new Date(asset.timeWindow.start);
      asset.timeWindow = { start: start.toISOString(), end: new Date(start.getTime() + durationMs).toISOString() };
    }
    const summary = `reschedule_event → ${input.event_id} to ${input.new_start_iso} (${input.reason})`;
    // A real Google Calendar move needs a real event id — set DEMO_CALENDAR_EVENT_ID
    // to the id of the calendar event that stands in for this asset.
    if (!hasComposio() || !process.env.DEMO_CALENDAR_EVENT_ID) {
      console.log('[tool] would execute reschedule_event', JSON.stringify(input));
      return { ok: true, simulated: true, summary };
    }
    await executeComposio(['GOOGLECALENDAR_UPDATE_EVENT', 'GOOGLECALENDAR_PATCH_EVENT'], {
      calendar_id: 'primary',
      event_id: process.env.DEMO_CALENDAR_EVENT_ID,
      start_datetime: input.new_start_iso,
    });
    return { ok: true, simulated: false, summary };
  },

  // State-only by spec: updates route status + records the new route note.
  async reroute_delivery(input, asset) {
    console.log('[tool] state-only reroute_delivery', JSON.stringify(input));
    asset.instruction = input.instruction;
    return { ok: true, simulated: true, summary: `reroute_delivery → ${input.route_id}: "${input.instruction}"` };
  },

  async mark_asset_safe(input) {
    console.log('[tool] state-only mark_asset_safe', JSON.stringify(input));
    return { ok: true, simulated: true, summary: `mark_asset_safe → ${input.asset_id} (${input.reason})` };
  },
};

// call = { name, input } → { ok, simulated, summary } | { ok: false, error }. Never throws.
// options.mutateAsset=false runs the action without touching asset status/lastAction
// (used by the /api/demo/test-notification connectivity check).
export async function runToolCall(call, { mutateAsset = true } = {}) {
  try {
    const exec = executors[call.name];
    if (!exec) {
      if (isDynamicComposioTool(call.name)) return runDynamicComposio(call);
      const error = `unknown tool: ${call.name}`;
      pushFeed({ type: 'system', text: `⚠ Tool call skipped — ${error}` });
      return { ok: false, error };
    }
    const asset = state.assets.find((a) => a.id === call.input?.asset_id);
    if (!asset) {
      const error = `unknown asset_id: ${call.input?.asset_id}`;
      pushFeed({ type: 'system', text: `⚠ Tool call skipped — ${error}` });
      return { ok: false, error };
    }

    console.log(`[AGENT LOG] executing tool ${call.name} for ${asset.id} — input: ${JSON.stringify(call.input)}`);
    const result = await exec(call.input, asset);
    console.log(`[AGENT LOG] tool ${call.name} result: ok=${result.ok}${result.simulated ? ' (simulated)' : ''}${result.error ? ` error=${result.error}` : ''}`);

    if (result.ok) {
      if (mutateAsset) {
        asset.status = call.name === 'mark_asset_safe' ? 'safe' : 'handled';
        asset.lastAction = { tool: call.name, summary: result.summary, at: new Date().toISOString() };
      }
      const prefix = result.simulated ? 'WOULD EXECUTE ' : 'EXECUTED ';
      pushFeed({
        type: 'action',
        text: `${prefix}${result.summary} — ${call.input.rationale}`,
        data: { tool: call.name, input: call.input, simulated: result.simulated === true },
      });
    }
    return result;
  } catch (e) {
    const error = e?.message ?? String(e);
    // Soft-fail on the dashboard (no red card); full detail stays in the console.
    pushFeed({ type: 'system', text: `⚠ ${call.name} for ${call.input?.asset_id} could not be delivered — see console log` });
    return { ok: false, error };
  }
}
