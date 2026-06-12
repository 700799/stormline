# PROGRESS

**Status: M1 + M2 + M3 + submission pivot built and sandbox-verified (dry-run). Live-call acceptance pending user creds (B-checks below). Next: your local verification (`npm run demo`), then Render deploy.**

## Submission pivot (final)
- **Jua aborted.** `src/data/jua.js` deleted; `JUA_*` env vars removed. `DEMO_MODE=false` now ingests `src/data/mock-payload.json` via `src/data/forecast.js normalizePayload()` → same canonical storm shape, identical agent path. Verified: mock storm drives statuses + one deduped action, stable id keeps the brain quiet after the first decision. Edit the JSON to change the "live" storm.
- **OpenUI integrated (3rd sponsor).** `GET /api/ui/openui-card` calls an OpenAI-chat-completions-compatible OpenUI endpoint (`OPENUI_BASE_URL`/`OPENUI_MODEL`/`OPENUI_API_KEY` env-overridable, `THESYS_API_KEY` fallback) to generate a professional status-card component from live world state; the dashboard's new bottom panel renders it in a sandboxed iframe and refreshes every 45s. **No key → labeled "local fallback — no OpenUI key" card (verified). Generated path is key-dependent and was NOT verifiable offline** (sponsor endpoints egress-blocked in the build sandbox) — first run with a key will confirm; errors surface in the panel badge.
- **Live `[AGENT LOG]` on the dashboard.** UI-layer console tap in `server.js` mirrors every `[AGENT LOG]` line into `state.agentLog` (ring buffer, in `/api/state`) and a new additive SSE event `agentlog`; the panel streams it terminal-style. Core loop/brain/tools untouched (only the forecast import changed, forced by the Jua removal).
- **Verify locally with one command:** `npm run demo` → open http://localhost:3000 (FAKE_BRAIN + 5s ticks; click ⚡ Inject storm). With your `.env` creds use `npm run dev` instead for the real brain.

## M3 — The face (dashboard)
- `public/dashboard.html` rewritten: single file, CDN-only (Leaflet 1.9.4 via cdnjs + CARTO dark basemap — loads browser-side), dark high-contrast, large fonts.
- Map: storm = translucent red circle (true `radius_km`) + center dot + dashed heading line, moving every tick; assets = thick polylines/markers colored by status (green safe / amber watch / red threatened / blue handled); auto-fits to all assets on first state.
- Right column: **reasoning/actions feed is the most prominent panel** (newest-first, type-badged, id-deduped against SSE reconnect replays); asset cards with status pills + last action; header with live dot, tick, weather one-liner, action count.
- Demo controls in the header: ⚡ Inject storm (severe @ route-7) and Reset.
- Sandbox-verified: `GET /` 200 with expected markup; SSE carries `feed` + `state` events through a full FAKE_BRAIN storm arc (incl. `extreme` @ `event-bayfest` variant). **Visual check is browser-side → part of B4.**
- **B4 = M3 acceptance gate (user):** open `/` during an inject — storm circle moves, cards flip colors, feed streams; then deploy to Render (new Web Service off `main`, build `npm install`, start `npm start`, add env vars, health check `/healthz`) and run the same arc there. DEMO_SCRIPT.md has the full demo beats.

## M2 — Composio (real hands)
- `@composio/core` wired in `src/agent/tools.js` executor bodies: `tools.execute(slug, { userId, arguments, dangerouslySkipVersionCheck })` (API confirmed against the package's type definitions).
  - `send_slack_alert` → `SLACK_SEND_MESSAGE` (channel: `SLACK_CHANNEL_ID` override, else asset contact)
  - `send_customer_email` → `GMAIL_SEND_EMAIL` (to: `DEMO_EMAIL_TO` override, else asset contact)
  - `reschedule_event` → `GOOGLECALENDAR_UPDATE_EVENT` — only when `DEMO_CALENDAR_EVENT_ID` is set (a real calendar event id standing in for event-bayfest); always applies the state-only timeWindow shift for the dashboard
  - `reroute_delivery` / `mark_asset_safe` stay state-only per spec
- No `COMPOSIO_API_KEY` → labeled `WOULD EXECUTE` dry-run (verified in sandbox: actions once, dedupe skips, statuses correct). Real runs feed as `EXECUTED …`; failures feed as errors and never change asset status.
- **Caveat for first real run:** Slack/Gmail/Calendar argument names follow Composio's standard catalog but couldn't be verified offline (their API is egress-blocked in the build sandbox). If a name is off, the exact Composio error text appears in the feed/console — fix is a one-liner in the `executors` map.
- **User prerequisites:** Composio dashboard → connect Slack, Gmail, Google Calendar under your user/entity (set `COMPOSIO_USER_ID` if it isn't `default`), set `COMPOSIO_API_KEY` (+ optional `SLACK_CHANNEL_ID`, `DEMO_EMAIL_TO`, `DEMO_CALENDAR_EVENT_ID`).
- **B3 = M2 acceptance gate (user):** inject storm → real Slack message lands; next tick logs "Skipped duplicate" instead of re-sending; then email; then calendar.

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
