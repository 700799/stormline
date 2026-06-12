# PROGRESS

**Status: M1 built and sandbox-verified. Bedrock live-call acceptance pending user creds (B-checks below). Next: M2 (Composio).**

## Works (verified in the build sandbox, no creds needed)
- `npm start` boots; loop ticks every `POLL_SECONDS` (default 30s); overlap guard.
- `POST /api/demo/inject-storm {intensity?, target?}` → synthetic storm enters the same pipeline live data will use; advances SE each tick; ETA counts down; re-inject replaces (fresh dedupe space); bad input → 400. `POST /api/demo/clear` resets the world.
- Assessment: per-asset haversine distance + status transitions (safe→watch→threatened) with feed events; `handled` sticky until mark_asset_safe/clear.
- Weather-hash skip: clear skies → brain not called; live storm → re-evaluated every tick.
- Brain failure handling: one feed error per distinct message (anti-spam), loop never dies; 25s Bedrock timeout so a hung call can't freeze the loop.
- Guardrails: max 5 actions/tick; dedupe key `tool:asset_id:threatId` — proven via FAKE_BRAIN (re-issued calls get "skipped duplicate", each action recorded exactly once).
- tools.js logs "would execute X", updates asset status + lastAction (status only on `result.ok`).
- SSE `/api/stream`: full state on connect + per tick, `feed` events live mid-tick, heartbeat, proxy-buffering headers, listener cleanup.
- `GET /api/state`, `GET /healthz`, `GET /` (debug dashboard until M3).
- `[AGENT LOG]` console instrumentation: per-tick context sent to the brain → (real path) raw Bedrock response JSON → thought process → decision summary → per-tool execution + guardrail lines.

## Pending user verification (sandbox has no creds + restricted egress)
- **B1 Bedrock smoke test** (run locally):
  ```bash
  export AWS_REGION=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
  node -e "import('@anthropic-ai/bedrock-sdk').then(async ({AnthropicBedrock}) => { const c = new AnthropicBedrock(); const m = await c.messages.create({ model: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-sonnet-4-6', max_tokens: 64, messages: [{ role: 'user', content: 'Reply with exactly: pong' }] }); console.log(m.content[0]); }).catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); })"
  ```
  Model-not-found? Try `BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6` (inference profile) or the variant enabled in your Bedrock console.
- **B2 = M1 acceptance gate**: `cp .env.example .env` (fill AWS vars) → `POLL_SECONDS=10 npm run dev` → inject storm → console + `/api/state` show Claude's reasoning and tool calls; no duplicate action per asset+storm across ticks; after `clear`, brain goes quiet.

## Stubbed
- `src/data/jua.js` (M4) — returns null; normalized-shape contract documented in the file.
- `src/log/clickhouse.js` (M5) — placeholder.
- M1 executors are log-only ("would execute X") — M2 swaps bodies for Composio.

## Known quirks (accepted for the demo)
- Failed tool results are still dedupe-recorded → no retry storms (and no auto-retries).
- After `mark_asset_safe`, the same storm can't re-alert that asset (new storm id → fresh keys).
- Map movement is intentionally ~10× the narrative speed_kmh/ETA so the demo reads from a distance.

## Next
M2 — wire `@composio/core`: real Slack alert first, then Gmail, then Google Calendar. User prerequisite: connect those apps in the Composio dashboard + set `COMPOSIO_API_KEY` (optional `SLACK_CHANNEL_ID`, `DEMO_EMAIL_TO` overrides).
