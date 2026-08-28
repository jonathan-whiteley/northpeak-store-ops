# NorthPeak Store Ops — session notes

Working state for the NorthPeak Retail "Stockout & Markdown Rescue" app (Tech Summit FY27 workshop), built in the **wishcraft** workspace. Updated 2026-08-27. Written so context survives a compaction.

## Where it stands right now
- **App code: complete + working locally.** Committed and pushed.
- **GitHub (private):** https://github.com/jonathan-whiteley/northpeak-store-ops (personal `jonathan-whiteley` account). Commits: `831ab9a` (initial) + `6940a0d` (deploy config).
- **Deployed to Databricks Apps (wishcraft):** app `northpeak-store-ops`, URL **https://northpeak-store-ops-7474660579265348.aws.databricksapps.com**, state RUNNING. App SP `2ac55f6d-9c03-43b4-8ac8-6070e8416e28`.
- **ONE open item on the deploy:** first-boot Drizzle migrations FAILED (`CREATE TABLE drizzle.__drizzle_migrations` — the SP couldn't create schemas). Root cause = timing race: the container booted + migrated a moment before the SP `GRANT CREATE ON DATABASE` landed. **The grant is now in place; the app just needs a RESTART so migrations + the Lakebase sync re-run.** (That restart was the very next step when this note was requested.)

## Environment / IDs (profile `wishcraft`)
- Local project: `~/Desktop/Projects/northpeak-store-ops` (app in `app/`).
- Data (UC/Delta): `team_wishcraft_catalog.northpeak` (owned by josh.rosenberg).
- Genie space: `01f1a239a6e8167f8ac0914cb0836fd5`. SQL warehouse: `1de6579bcd984117`.
- Lakebase: project `northpeak-store-ops`, endpoint `projects/northpeak-store-ops/branches/production/endpoints/primary`, db `northpeak`, host `ep-late-thunder-d1n8nnzh.database.us-west-2.cloud.databricks.com`.
- SDP pipeline (Josh's): `northpeak_operations` = `4ab40194-4cc9-4a2b-92ad-4efe8353b3c1`, source `/Users/josh.rosenberg@databricks.com/northpeak_operations_cf968b6a/transformations/`.
- Agent model: **`databricks-claude-sonnet-5`** (Claude), chat-completions transport.
- Two `gh` accounts: `jonathan-whiteley` (personal, where this + operator-homebase + geospatial-agent-app live) and `jonathan-whiteley_data` (work). Pushed to personal.

## Done (this session)
- Scaffold reconstructed from the public `github.com/databricks/appkit` `template/` (go/solution-builder inaccessible; workspace export drops the npm manifest).
- **Data pipeline fix** (in Josh's SDP pipeline, reran it): `gold_store_sku_position` overstock branch treated NULL `weeks_of_supply` (zero-velocity dead stock) as healthy → fixed to classify overstock. Now 167 overstock, hero `STORE-0214 -> STORE-0377` transfer, KPIs ~$4.3M lost / ~$4.6M markdown.
- **Lakebase** provisioned; **agent Layer 2/3 tools** implemented (`find_shortfall`/`rank_recovery_moves`/`execute_recovery_action` + transactional `recordRecoveryAction`).
- **Nocturne reskin** (whole app; Operations to the mockup). Design source-of-truth in `app/design-ref/`; brand assets in `app/client/public/brand/`.
- **Map transfer arcs** (fly-to + arcs to surplus source, "All routes" toggle) + **Genie "shows its work"** (generated SQL + result grid + factual ⚡ callout in the Thinking panel).
- **Inventory reorder write-back** (homebase-style, direct button): `POST /api/supply/reorder` → `app.ops_actions` `move_type='reorder'` → `dataMutated` cascade. Verified (open shortfalls 150→149, in-recovery +1, exposure −$76,835).
- **Today tab**: reshaped `HomeView` into a daily-brief hero (GENIE · YOUR DAILY BRIEF + real numbers + action chips + ask bar) + "Jump into a module" row, existing content kept below; nav renamed **Assistant → Today** (CalendarDays icon).
- **RtPitch "Real-time analytics" banner removed** from the analytics page.
- **Claude switch + fix**: `agentModel=databricks-claude-sonnet-5` + `setOpenAIAPI('chat_completions')`. The request shim in `server/agent/storeops.ts` strips `strict` + `reasoning_effort` + `store` (Databricks' Anthropic passthrough 400s on those). Verified live: reasoning + `ask_data` tool + Genie SQL card + synthesized answer, no 400.
- **App data-path fixes**: sync scoped to `position_status <> 'healthy'` (was blowing the 25MB INLINE cap on 250K rows); recovery sync dropped bogus `to_json(move_ranking)`; analytics `config/queries/*.sql` catalog/schema → team_wishcraft_catalog/northpeak + `sale_date`; `move_ranking` JSONB snake→camel map (`transformMoveRanking`) so ranked cards show real numbers; CARTO basemap key added to the map tiles.

## Uncommitted deploy fixes (commit after the restart verifies)
The (now-stopped) deploy agent changed, beyond the committed `6940a0d`:
- `scripts/deploy.sh` — filtered `rsync` staging so the upload EXCLUDES `node_modules`/`.git`/`.env` (was uploading 740M; container npm-installs from the lockfile).
- `scripts/lakebase_grant_app_credential.sh` — `GRANT CREATE ON DATABASE` to the app SP (so it can create the `app`/`appkit`/`drizzle` schemas).
- `package.json` — restored `build:source` (real build) + no-op `build` (what the container auto-runs); removed the `prebuild` typegen hook that failed in the container.
- SP UC grants applied: `USE CATALOG team_wishcraft_catalog` + `USE SCHEMA`/`SELECT` on `northpeak` to the app SP (boot sync + typegen run as the SP).

## Next steps
1. **Restart the app** (`databricks apps stop` then `start`, profile wishcraft) so migrations + the Lakebase sync re-run with the grant in place. Watch logs for the migrations succeeding + `[sync] Done` (~317/150/150).
2. **Verify on the live URL**: Operations shows real data; the Claude assistant answers ("Why is Store 214 short?") with no 400.
3. **Commit + push** the uncommitted deploy fixes (deploy.sh, grant script, package.json) to the GitHub repo.
4. Optional/deferred: Build 3 (Unity AI Gateway around the Claude endpoint); `search_products`/substitute Lakebase Search.

## Gotchas / decisions
- Rerunning Josh's pipeline rebuilt his shared `northpeak` gold tables — give Josh a heads-up.
- App SP needs BOTH: UC grants (read the gold tables via the warehouse) AND Lakebase `GRANT CREATE ON DATABASE` (create its Postgres schemas). The first boot lost a race with the latter.
- Databricks' Anthropic passthrough (chat-completions) rejects `strict`/`reasoning_effort`/`store` — the shim must strip all three or the agent 400s.
- `app.ops_actions` is the only writable Lakebase table (recovery + reorder); the three gold mirrors are read-only synced; chat tables are read/write.
