# Stormline — agent notes

Autonomous severe-weather ops agent (hackathon, ~7h to demo). SENSES weather (injected storms now, Jua live data in M4) → Claude on AWS Bedrock DECIDES via tool use → ACTS through Composio (Slack/Gmail/Calendar) → SHOWS a live dashboard over SSE.

## Source of truth (read these first, every session)
- **PLAN.md** — milestones + acceptance criteria. Build strictly in order; don't start M(n+1) until M(n) passes.
- **PROGRESS.md** — what works, what's stubbed, what's verified vs pending, what's next.
- **DEMO_SCRIPT.md** — the demo arc and exact commands.

## Hard requirements (never trade away)
- Zero human input after a weather event enters the pipeline — autonomy is the product.
- Agent reasoning must stream human-readably to the dashboard — reasoning nobody can see might as well not exist.
- `POST /api/demo/inject-storm` controls **when** a storm happens, never **what** the agent does about it.
- Runs on Render from `npm start`, binding `process.env.PORT`.
- Secrets only via env vars. Maintain `.env.example`. **Never commit `.env`.**

## Working rules
- Simplest thing that demos well: no tests, no TypeScript, no DB (in-memory state), no abstractions for futures.
- No new dependencies beyond PLAN.md's list without asking.
- Sponsor API blocking >20 min → stub behind the existing interface, note in PROGRESS.md, move on. **Never silently fake an integration** (FAKE_BRAIN is explicit + labeled, that's the bar).

## Stack & commands
Node ≥20.6 (ES modules), Express 5, SSE, `@anthropic-ai/bedrock-sdk`, `@composio/core` (M2).
- Brain provider: `OPENROUTER_API_KEY` set → Claude via OpenRouter (OpenAI-compatible, default model `anthropic/claude-sonnet-4.5`); else AWS Bedrock; `FAKE_BRAIN=true` overrides both; `BRAIN_PROVIDER` forces a choice.
- Setup: `cp .env.example .env`, fill creds → `npm run dev` (uses `--env-file`). Prod: `npm start`.
- `npm run demo` — zero-creds rehearsal: FAKE_BRAIN + fast ticks; open http://localhost:3000.
- Fast iteration: `POLL_SECONDS=5`. No AWS creds: `FAKE_BRAIN=true` (canned decisions, clearly labeled — also the live-demo fallback if Bedrock flakes).
- Inject: `curl -X POST localhost:3000/api/demo/inject-storm -H 'content-type: application/json' -d '{"intensity":"severe","target":"route-7"}'`
- Reset: `curl -X POST localhost:3000/api/demo/clear`
- Console shows `[AGENT LOG]` lines: context sent to the brain → raw Bedrock response → thought process → decision → tool execution → guardrails.

## Frozen contracts (dashboard + M4 depend on these — don't reshape)
- **Weather/storm shape**: defined in `src/data/injected.js`; `forecast.js normalizePayload()` (mock-payload ingestion, DEMO_MODE=false) emits the same shape. The loop never knows the source. (Jua was aborted for submission — do not reintroduce it.)
- **Public state**: `getPublicState()` in `src/state.js` (served by `/api/state` and SSE `state` events).
- **SSE protocol**: named events `state` (full state: on connect + once per tick) and `feed` (`{id, ts, type, text}`); `: hb` heartbeat every 25s. New event types may be ADDED; these two are never renamed/reshaped.
- **Dedupe key**: `tool:asset_id:threatId` — every tool's input_schema requires `asset_id` + `rationale`.
- **tools.js seam**: the dispatcher owns validation/status/feed; executor **bodies** are the only Composio swap point (M2). Asset status changes only when `result.ok`.
- **Gotchas**: never add compression middleware (buffers SSE). Express 5 `sendFile` needs an absolute path. Don't `pkill -f` patterns that match your own shell.
