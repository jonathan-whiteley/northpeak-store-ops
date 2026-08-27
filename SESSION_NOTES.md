# NorthPeak Store Ops — session notes

Working notes for the build session on 2026-08-27. Written so context survives a compaction.

## Goal
Build the **NorthPeak Retail "Stockout & Markdown Rescue"** app (Tech Summit FY27 AI Customer Challenge workshop) in the **wishcraft** workspace. Store-ops console: US store map, worst-shortfalls queue, ranked recovery moves (transfer / expedite / substitute), a Genie assistant, and an approve to write-back to Lakebase. Origin README: `/Users/josh.rosenberg@databricks.com/northpeak-retail/README.md` (in wishcraft).

## Environment / IDs (profile `wishcraft`)
- Local project: `~/Desktop/Projects/northpeak-store-ops` (app in `app/`).
- Data (UC/Delta): `team_wishcraft_catalog.northpeak` (owned by josh.rosenberg).
- Genie space: `01f1a239a6e8167f8ac0914cb0836fd5`.
- SQL warehouse: `1de6579bcd984117` (Serverless Starter).
- Lakebase: project `northpeak-store-ops`, endpoint `projects/northpeak-store-ops/branches/production/endpoints/primary`, db `northpeak`, host `ep-late-thunder-d1n8nnzh.database.us-west-2.cloud.databricks.com`.
- SDP pipeline: `northpeak_operations`, id `4ab40194-4cc9-4a2b-92ad-4efe8353b3c1` (Josh's; source at `/Users/josh.rosenberg@databricks.com/northpeak_operations_cf968b6a/transformations/`).
- Agent model endpoint: `databricks-gpt-5-4` (READY; needs the Responses API).

## Stack
Databricks AppKit (`@databricks/appkit` 0.66.1): Node/React/Express/TS + Lakebase + Genie + MLflow + OBO. The runnable scaffold was reconstructed from the public `github.com/databricks/appkit` `template/` (package.json + lockfile), because go/solution-builder is inaccessible to Jonathan and the workspace export drops the npm manifest.

## Done (verified)
- **App runs end-to-end locally**: `cd app && DATABRICKS_CONFIG_PROFILE=wishcraft ./start.sh` (http://localhost:8765). Boot sync populates Lakebase in ~2s: **317 positions / 150 shortfalls / 150 recovery recs**.
- **Lakebase** provisioned (`scripts/lakebase_setup_db.sh`) and wired in `app/.env`.
- **Agent Layer 2/3 tools** implemented in `server/agent/storeops.ts`: `find_shortfall`, `rank_recovery_moves`, `execute_recovery_action` + a transactional `recordRecoveryAction` in `server/db/queries/stores.ts` (approved move + paired markdown-hold, OBO audit). Write/approval path intact.
- **Data pipeline fix (root cause + fix, reran Josh's pipeline):** `gold_store_sku_position` computed `weeks_of_supply = on_hand / NULLIF(velocity*7,0)`, so zero-velocity dead stock got NULL, and the `overstock` branch (`weeks_of_supply > 8 AND markdown_risk >= 0.6`) skipped it, dropping all southern surplus to `healthy`. Fixed the classification to treat NULL/zero-velocity high-on-hand + high markdown-risk as `overstock`. Cascade now correct: 167 overstock, markdown KPI ~$4.6M, lost-sales ~$4.3M, hero `STORE-0214 -> STORE-0377` transfer, 39 transfer / 111 expedite.
- **Nocturne reskin** (whole app; Operations reshaped to the mockup): tokens in `client/src/index.css`, KPI tiles, dark CARTO map with coral/amber bubbles, worst-shortfalls queue, store-detail card with ranked move cards, Genie dock, Databricks capability markers. Brand assets in `client/public/brand/`. Design source-of-truth in `app/design-ref/`.
- **App data-path fixes:** sync scoped to `position_status <> 'healthy'` (was pulling 250K rows past the SQL API 25MB INLINE cap); recovery sync dropped bogus `to_json(move_ranking)` (column is already a JSON string); analytics `config/queries/*.sql` catalog/schema defaults set to `team_wishcraft_catalog`/`northpeak` and `sale_date` (not `sales_date`); CARTO basemap key added to `StoreMap.tsx` tiles (client-side key).

## In flight (background subagent)
Porting two patterns from `github.com/jonathan-whiteley/databricks-geospatial-agent-app` (clone at `/tmp/geo-app-*`): (1) **map transfer arcs** shortfall -> recommended surplus (from `frontend/src/map.js` buildTrade/selectStore); (2) **Genie "shows its work"** — render generated SQL + a grain-adaptive results table + an action callout in the dock (from `frontend/src/geniePanel.jsx` buildTable), by capturing SQL/rows in `server/agent/tools/genie.ts`. Keeping the streaming chat + write path intact.

## Queued / next
1. Review the map+Genie enhancement when it lands; boot smoke test.
2. **Create the PRIVATE GitHub repo + push** (Josh's internal workshop code, so private). Re-scan for secrets first; `app/.env` is gitignored; the CARTO key is a client-side basemap key (ships to browsers anyway).
3. **Build 3 — Unity AI Gateway**: front `databricks-gpt-5-4` with a gateway (spend cap, guardrails, per-store inference logging), point `config/app.json` `agentModel` at it. `ai-gateway` OBO scope already declared in `app.yaml`.
4. Deferred: `search_products` / substitute Lakebase Search (needs `raw_products` + index).
5. Deploy consideration: `app/drizzle/` migrations are gitignored but the deployed `app.yaml` command is `node dist/server.js` with no `db:generate`, so migrations must ship for a real deploy.

## Gotchas / decisions
- Editing Josh's pipeline + rerunning it rebuilt his `northpeak` gold tables in a shared workspace — Jonathan to give Josh a heads-up.
- Genie space description cites ~$38M/$819M exposure vs the README's ~$4.8M/$5.6M; the app KPIs follow the (corrected) data (~$4.3M lost-sales / ~$4.6M markdown).
- `position_status` only had stockout/healthy before the fix; now stockout/overstock/healthy (no at_risk in this data).
