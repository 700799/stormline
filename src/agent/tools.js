// Action executors. The dispatcher (runToolCall) owns validation, asset status
// updates, and feed output; the executor BODIES are the Composio integration
// point (M2). Asset status changes only when result.ok — a failed real send
// must never mark an asset handled.
//
// With COMPOSIO_API_KEY set, send_slack_alert / send_customer_email /
// reschedule_event execute for real via Composio (@composio/core);
// without it they stay in the clearly-labeled WOULD-EXECUTE dry-run mode.
// reroute_delivery and mark_asset_safe are state-only by spec.
import { Composio } from '@composio/core';
import { state, pushFeed } from '../state.js';

let composio = null;
const hasComposio = () => Boolean(process.env.COMPOSIO_API_KEY);

async function executeComposio(slug, args) {
  composio ??= new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false });
  console.log(`[AGENT LOG] composio execute ${slug} — args: ${JSON.stringify(args)}`);
  const res = await composio.tools.execute(slug, {
    userId: process.env.COMPOSIO_USER_ID || 'default',
    arguments: args,
    // Hackathon: skip toolkit version pinning; pin versions for production.
    dangerouslySkipVersionCheck: true,
  });
  console.log(`[AGENT LOG] composio ${slug} → successful=${res.successful}${res.error ? ` error=${res.error}` : ''}`);
  if (!res.successful) throw new Error(res.error || `${slug} reported failure`);
  return res;
}

const executors = {
  async send_slack_alert(input) {
    const channel = process.env.SLACK_CHANNEL_ID || input.channel;
    const summary = `send_slack_alert → ${channel} [${input.severity}]: "${input.message}"`;
    if (!hasComposio()) {
      console.log('[tool] would execute send_slack_alert', JSON.stringify(input));
      return { ok: true, simulated: true, summary };
    }
    await executeComposio('SLACK_SEND_MESSAGE', {
      channel,
      text: `:thunder_cloud_and_rain: [${input.severity.toUpperCase()}] ${input.message}\n_— Stormline autonomous agent_`,
    });
    return { ok: true, simulated: false, summary };
  },

  async send_customer_email(input) {
    const to = process.env.DEMO_EMAIL_TO || input.to;
    const summary = `send_customer_email → ${to}: "${input.subject}"`;
    if (!hasComposio()) {
      console.log('[tool] would execute send_customer_email', JSON.stringify(input));
      return { ok: true, simulated: true, summary };
    }
    await executeComposio('GMAIL_SEND_EMAIL', {
      recipient_email: to,
      subject: input.subject,
      body: `${input.body}\n\n— Stormline autonomous weather agent`,
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
    await executeComposio('GOOGLECALENDAR_UPDATE_EVENT', {
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
export async function runToolCall(call) {
  try {
    const exec = executors[call.name];
    if (!exec) {
      const error = `unknown tool: ${call.name}`;
      pushFeed({ type: 'error', text: `Tool call rejected — ${error}` });
      return { ok: false, error };
    }
    const asset = state.assets.find((a) => a.id === call.input?.asset_id);
    if (!asset) {
      const error = `unknown asset_id: ${call.input?.asset_id}`;
      pushFeed({ type: 'error', text: `Tool call rejected — ${error}` });
      return { ok: false, error };
    }

    console.log(`[AGENT LOG] executing tool ${call.name} for ${asset.id} — input: ${JSON.stringify(call.input)}`);
    const result = await exec(call.input, asset);
    console.log(`[AGENT LOG] tool ${call.name} result: ok=${result.ok}${result.simulated ? ' (simulated)' : ''}${result.error ? ` error=${result.error}` : ''}`);

    if (result.ok) {
      asset.status = call.name === 'mark_asset_safe' ? 'safe' : 'handled';
      asset.lastAction = { tool: call.name, summary: result.summary, at: new Date().toISOString() };
      const prefix = result.simulated ? 'WOULD EXECUTE ' : 'EXECUTED ';
      pushFeed({
        type: 'action',
        text: `${prefix}${result.summary} — ${call.input.rationale}`,
        data: { tool: call.name, input: call.input, simulated: result.simulated === true },
      });
    } else {
      pushFeed({ type: 'error', text: `Action failed: ${call.name} for ${call.input?.asset_id} — ${result.error}` });
    }
    return result;
  } catch (e) {
    const error = e?.message ?? String(e);
    pushFeed({ type: 'error', text: `Tool ${call.name} failed — ${error}` });
    return { ok: false, error };
  }
}
