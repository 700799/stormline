# DEMO SCRIPT (~3 minutes)

Creds-free rehearsal any time: `npm run demo` → http://localhost:3000 → ⚡ Inject storm.

**Presentation screen:** open `/?present=1` — controls are hidden; trigger storms from your phone/laptop with the curl below (or a second normal tab). Booth idle: `/?attract=1`.

Pre-flight (before showtime):
- `curl -s https://<render-url>/healthz` → wakes the instance, expect `ok`.
- Open the dashboard at `/`, confirm header says **live** and all 5 assets are green.
- `curl -X POST <url>/api/demo/clear` to reset between rehearsals.
- If Bedrock flakes on stage: restart with `FAKE_BRAIN=true` (labeled fallback — say so if asked).

## Beats

1. **Set the scene (30s).** "Stormline watches 45 real Bay Area business assets — delivery routes, outdoor events, field crews, warehouses — and acts on wildfire and severe-weather threats with zero human input." Point at the all-green map.

2. **Trigger (10s).** "Red-flag conditions — a fire just ignited in the Oakland Hills." Pick **🔥 extreme fire @ Oakland Hills** and click **Inject threat** (or:)
   ```bash
   curl -X POST <url>/api/demo/inject-storm -H 'content-type: application/json' \
     -d '{"kind":"wildfire","intensity":"extreme","target":"route-21"}'
   ```
   Emphasize: *this only controls when and where the fire starts — everything after is the agent.*

3. **Watch it think (60–90s).** Narrate the reasoning feed: the fire front pulses orange and **grows** while Diablo winds push it southwest → assets cascade green→amber→red as the perimeter expands → Claude's reasoning types itself out → actions fire with a blue sonar ping at each protected asset (Slack alert lands in the channel — show the phone, email, calendar move). Cards flash and flip blue (handled), the timeline strip fills with activity.

4. **Prove autonomy (20s).** Point at the header scoreboard: "X decisions, Y actions — and **Z repeats blocked**: every tick it re-evaluates the spreading fire, protects newly threatened assets, and refuses to spam what it already handled." Nobody touched anything since the inject.

   Optional second beat: **🔥 severe fire @ North Bay** or **⛈ extreme storm @ route-12** — a new threat, fresh decisions, different assets.

5. **Close (10s).** "Same pipeline ingests live provider data — the injected fire is just a time machine for the demo." `POST /api/demo/clear` resets for the next run.
