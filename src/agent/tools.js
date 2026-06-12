// Action executors. The dispatcher (runToolCall) owns validation, asset status
// updates, and feed output; the executor BODIES are the only thing M2 swaps for
// real Composio calls. Asset status changes only when result.ok — a failed real
// send must never mark an asset handled.
import { state, pushFeed } from '../state.js';

const executors = {
  async send_slack_alert(input) {
    console.log('[tool] would execute send_slack_alert', JSON.stringify(input));
    return { ok: true, simulated: true, summary: `send_slack_alert → ${input.channel} [${input.severity}]: "${input.message}"` };
  },

  async send_customer_email(input) {
    console.log('[tool] would execute send_customer_email', JSON.stringify(input));
    return { ok: true, simulated: true, summary: `send_customer_email → ${input.to}: "${input.subject}"` };
  },

  async reschedule_event(input, asset) {
    console.log('[tool] would execute reschedule_event', JSON.stringify(input));
    const start = new Date(input.new_start_iso);
    if (asset.timeWindow && !Number.isNaN(start.getTime())) {
      const durationMs = new Date(asset.timeWindow.end) - new Date(asset.timeWindow.start);
      asset.timeWindow = { start: start.toISOString(), end: new Date(start.getTime() + durationMs).toISOString() };
    }
    return { ok: true, simulated: true, summary: `reschedule_event → ${input.event_id} to ${input.new_start_iso} (${input.reason})` };
  },

  // State-only by spec: updates route status + records the new route note.
  async reroute_delivery(input, asset) {
    console.log('[tool] would execute reroute_delivery', JSON.stringify(input));
    asset.instruction = input.instruction;
    return { ok: true, simulated: true, summary: `reroute_delivery → ${input.route_id}: "${input.instruction}"` };
  },

  async mark_asset_safe(input) {
    console.log('[tool] would execute mark_asset_safe', JSON.stringify(input));
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
      const prefix = result.simulated ? 'WOULD EXECUTE ' : '';
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
    pushFeed({ type: 'error', text: `Tool ${call.name} threw — ${error}` });
    return { ok: false, error };
  }
}
