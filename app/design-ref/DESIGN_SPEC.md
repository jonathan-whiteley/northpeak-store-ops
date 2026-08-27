# NorthPeak Store Ops — design implementation spec

Source: Claude Design project "Databricks App Scaffold Design", mockup `NorthPeak Store Ops.dc.html`.
Theme tokens: `design-ref/nocturne.css`. Brand assets already copied to `client/public/brand/` (see below).
**The mockup layout is a strong reference, not gospel. The mockup's data is mock (LOCAL/PARTNER arrays) — DO NOT copy it. Wire every surface to the app's REAL endpoints/queries.**

## Theme (apply app-wide, in `client/src/index.css`)
Dark "nocturne": ground `#161826`, surfaces `#232532`, text `#e9e9ed`, blurple accent `#9184d9`, Inter font, radius 4/8/14, hairline+ambient shadows. Map nocturne `:root` tokens onto the app's existing token names (the template documents that editing `:root` rebrands the whole app). Page ground uses the radial gradient noted in nocturne.css. Add domain tokens:
- `--np-short: #ff6a52` — stockout / at_risk (northern shortfalls)
- `--np-long: #ffab00` — overstock (southern markdown clock)
- `--np-land: #1e2132`, `--np-land-edge: #3a3f5c` — map
Signature detail: freestanding rules fade at both ends (`.hr`). Keep it subtle; spend boldness on the map + KPI color coding.

## Brand assets (in `client/public/brand/`, reference as `/brand/...`)
- `/brand/northpeak-mark-only.svg`, `/brand/northpeak-lockup-primary-dark.svg` — app logo/wordmark
- `/brand/db/databricks-logo-white.svg` — sidebar footer "governed on Databricks"
- `/brand/db/lakebase.svg` — marks live store state + write-back
- `/brand/db/genie.svg` — marks the ranking + the chat assistant
- `/brand/db/unity-catalog.svg` — marks the AI-gateway line on the chat input

## Layout (Operations = the hero screen)
Sidebar nav (NorthPeak mark + wordmark; section "Today": Cold snap recovery [active], Transfers [count badge], Stores, Markdowns, Approvals; footer: "Data, writes & assistant governed on" + databricks logo). Main column:
1. **Header** — kicker "Cold snap · week 3", h1 ("Winter apparel is short in the North and piling up in the South"), sub ("5 cold-weather styles · 400 stores · refreshed …"), a segmented control (Last 7 days / Since cold snap), persona chip (DR · Dana Ruiz · SVP Retail Operations).
2. **KPI row (4 tiles)** — Lost sales exposure (`--np-short`), Markdown exposure (`--np-long`), Recoverable this week, Approved today (accent + lakebase icon).
3. **Map + queue row** — left: card "Same five styles, opposite problems" + legend (short/long/healthy) + the US store map + footer "Click any store…" and a `lakebase` "live store state" marker. Right: "Worst shortfalls" card — a ranked list of short stores; clicking one selects it into the detail panel.
4. **Store detail card** — kicker (Sold out / Dead stock / Healthy · style), "Store {id} · {name}", 3 stats (On hand; Weekly demand/sales; Lost sales / Markdown exposure / Weeks of cover), an approved banner (shown after approval, with a `lakebase` "written back" marker), 3 **ranked move cards** (rank #, title, badge Recommended/Costlier/Fallback, sub, and metric / eta / confidence), then Approve + "Ask why" buttons and a `genie` "ranked the moves" marker.
5. **Floating Genie chat dock** — closed = pill "Ask about this store" (genie icon); open = panel: messages, suggested prompts, input with a `unity-catalog` "Unity AI Gateway" marker.

## Data wiring (REAL — from `server/db/queries/stores.ts` via the app's routes)
- **KPI tiles** ← `positionSummary()`: `lostSalesExposureUsd`, `markdownExposureUsd`, `openShortfalls`/`recoveriesInProgress`. "Approved today" ← count of `ops_actions` (recoveriesInProgress or recentActivity length).
- **Map** ← `storeBreakdown()` (the app's store/by-city route). Dot color by `status`: stockout/at_risk → `--np-short`, overstock → `--np-long`, healthy → neutral. **Restyle the existing `client/src/operations/CityMap.tsx` (react-leaflet) to nocturne** (dark/neutral tiles, colored markers, accent selection ring). Do NOT port `store-map.js` (it depends on external d3/topojson/world-atlas CDNs; the leaflet map already carries the real data).
- **Worst shortfalls queue** ← `listPositions({ statusGroup:'open', sort:'exposure' })`, top ~8. Click → selects that store×SKU into the detail panel and focuses the map.
- **Store detail** ← `getPosition(id)` + `getShortfall()` + `getRecommendation()`. Ranked move cards ← `recommendation.moveRanking` (transfer/expedite/substitute with `predictedRecapturedUsd`, `predictedNetValueUsd`, units, cost). Recommended = rank 1.
- **Approve** → the app's existing decide/execute route (or the agent's `execute_recovery_action`) → emits `dataMutated` → KPIs + queue + map refetch live. Keep this cascade.
- **Chat dock** ← the app's existing chat stack (`dockController`, `useChatTurn`, `streamChat`, `config.assistantScript` prompts). Keep the real agent + SSE + Thinking panel; only restyle to the nocturne dock. The agent already streams `ask_data`/`rank_recovery_moves`/etc.

## Constraints
- Keep the app's routing and every real endpoint/data flow. No mock arrays.
- Apply nocturne app-wide; make Operations match this mockup; theme Home/Analytics/Dashboard consistently (Home can adopt the narrative framing).
- Keep `npm run typecheck` and `npm run build` green. Do not boot the dev server against Lakebase without the running env; use the app's placeholder/loading states for visual iteration where data isn't live.
- Databricks capability icons are quiet inline markers (13–22px), not decoration — place them exactly where a capability actually shows (Lakebase = live reads + writeback; Genie = ranking + chat; Unity Catalog = gateway).
