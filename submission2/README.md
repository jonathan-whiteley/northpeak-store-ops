# NorthPeak Store Ops — Build 2 (Databricks Apps) submission

**Hero decision:** Store 214 (Denver) is out of the Summit Down Parka mid cold-snap.
The app surfaces it, prescribes the ranked recovery move, drafts the memo, and commits
the approved transfer back to Postgres with a human in the loop — a decision, not a dashboard.

- **Deployed app:** https://northpeak-store-ops-7474660579265348.aws.databricksapps.com (RUNNING)
- **Workspace / profile:** `wishcraft` (fe-sandbox-team-wishcraft)
- **Build 1 synced UC tables (READ-ONLY):** `northpeak.app_store_sku_position`,
  `app_open_shortfalls`, `app_recovery_recommendations` (Lakebase synced tables)
- **Writable Postgres (app-owned):** `app.ops_actions`, `app.workflow_state`, chat tables

## Layer-by-layer (built on the `development` branch off `main`)

- **Visualize** — ranked, flagged live view (`view_query.sql`) over the synced UC tables,
  re-scored on a schedule. A scored **trigger** is logged to `app.workflow_state`
  (`scheduled_scoring`/`pipeline_update`, priority > a person opening the page).
- **Assist** — the agent explains why a position is flagged (`find_shortfall`), runs
  what-if scenarios and ranks moves (`rank_recovery_moves`), and auto-drafts the memo.
  Retrieval is grounded in the Lakebase synced tables (positions/recommendations).
- **Act** — on human approval the agent commits the move to `app.ops_actions`
  (`execute_recovery_action`), logs a **decision** event to `app.workflow_state`
  atomically, and the committed decision shows on the next read of the live view.

## Evidence files (maps to the required exports)

| File | Requirement |
|---|---|
| `writeback_table.json` | Writable Postgres action table (`app.ops_actions`): proposed action, approval status + approver, created + committed timestamps |
| `state_table.json` | Lakebase workflow-state + observability table (`app.workflow_state`): trigger events + recorded decisions with timestamps |
| `view_query.sql` / `view_result.json` | Query behind the live ranked/flagged view + its returned rows |
| `assist_log.jsonl` | Assistant interactions (request + response + tool calls): includes an **explanation**, a **what-if** run, the draft, and the act turn |
| `drafted_sample.md` | Auto-drafted transfer memo (verbatim agent output) |
| `hero_question.txt` | Hero question + the linked record IDs forming the decision chain across the exports |
| `git_history.txt` | `git log --graph --oneline --decorate --all` — layered build on `development` off `main` |

## Notes / scope

- **Closed loop is provable in the data:** the hero row `STORE-0214:SKU-APP-04412` appears
  in `view_result.json` with `live_move_type: transfer`, `action_status: approved` — the
  committed decision reflected on the next read. The matching `app.ops_actions` row and the
  `app.workflow_state` decision event share `action_id 7a81e5a4-...`.
- **Model transport:** the Build 3 Unity AI Gateway model service is budget-capped in this
  sandbox; the interactions in `assist_log.jsonl` were generated via the direct FMAPI
  fallback (`AGENT_TRANSPORT=chat_completions`, `databricks-claude-sonnet-5`). Default
  transport remains the governed gateway.
- **Deferred:** Lakebase Search over the product catalog (the `search_products` substitute
  path). The product catalog table + hybrid index were never built in Build 1 (no
  `products`/`description` source), so the Assist layer's drafting retrieves from the
  synced position/recommendation tables rather than a Lakebase Search index.
