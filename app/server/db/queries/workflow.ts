import { sql } from 'drizzle-orm';
import type { AppDb } from '../index.js';

// Accepts either the top-level db handle or an open transaction — both expose
// `.execute`. Lets logDecision run inside recordRecoveryAction's transaction.
type Executor = Pick<AppDb, 'execute'>;

// ============================================================================
// Workflow-state + observability (app.workflow_state).
//
// Two writers:
//   • scoreAndLogTrigger — the scheduled/system re-score of the live view.
//   • logDecision        — one row per committed ops_actions write (called
//                          inside the write transaction in stores.ts).
// One reader: listWorkflowState — the state_table export + any observability UI.
// ============================================================================

export type TriggerSource = 'scheduled_scoring' | 'pipeline_update' | 'user_open';

/** Priority ranks how autonomous the trigger is — a schedule/system update
 *  surfaces the work without a human opening the page, so it outranks a
 *  user_open. Higher = more autonomous. */
export const TRIGGER_PRIORITY: Record<TriggerSource, number> = {
  scheduled_scoring: 100,
  pipeline_update: 90,
  user_open: 10,
};

export type WorkflowEvent = {
  id: string;
  eventType: 'trigger' | 'decision';
  source: string;
  priority: number;
  entityRef: string | null;
  actionId: string | null;
  status: string | null;
  score: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type WorkflowSqlRow = {
  id: string;
  event_type: 'trigger' | 'decision';
  source: string;
  priority: number;
  entity_ref: string | null;
  action_id: string | null;
  status: string | null;
  score: number | string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

function toWorkflowEvent(r: WorkflowSqlRow): WorkflowEvent {
  return {
    id: r.id,
    eventType: r.event_type,
    source: r.source,
    priority: Number(r.priority),
    entityRef: r.entity_ref,
    actionId: r.action_id,
    status: r.status,
    score: r.score === null ? null : Number(r.score),
    payload: r.payload ?? {},
    createdAt: r.created_at,
  };
}

/**
 * Score the live shortfall view and record ONE `trigger` event. Ranks open
 * shortfalls by lost-sales exposure over the READ-ONLY synced northpeak.app_*
 * tables and writes a row to app.workflow_state so the top position surfaces
 * without a human opening the page. This is what the server.ts scheduler
 * calls on an interval (and the pipeline-update hook can call with
 * source='pipeline_update').
 */
export async function scoreAndLogTrigger(
  db: AppDb,
  source: TriggerSource = 'scheduled_scoring',
  priority: number = TRIGGER_PRIORITY[source],
): Promise<WorkflowEvent | null> {
  const res = await db.execute(sql`
    INSERT INTO app.workflow_state (event_type, source, priority, entity_ref, score, payload)
    SELECT
      'trigger', ${source}, ${priority}, top.entity_ref, top.top_exposure_usd,
      jsonb_build_object(
        'trigger',            ${source}::text,
        'schedule',           '*/30 * * * *',
        'note',               'Scheduled re-score of the live shortfall view; system-driven, no human open required.',
        'open_shortfalls',    agg.open_shortfalls,
        'scored_rows',        agg.scored_rows,
        'top_entity',         top.entity_ref,
        'top_exposure_usd',   top.top_exposure_usd,
        'total_exposure_usd', agg.total_exposure_usd
      )
    FROM
      (SELECT
          count(*)                                  AS open_shortfalls,
          COALESCE(SUM(lost_sales_exposure_usd), 0) AS total_exposure_usd,
          (SELECT count(*) FROM northpeak.app_store_sku_position
            WHERE position_status IN ('stockout','at_risk')) AS scored_rows
        FROM northpeak.app_open_shortfalls) agg,
      (SELECT store_id || ':' || product_id AS entity_ref,
              lost_sales_exposure_usd       AS top_exposure_usd
         FROM northpeak.app_open_shortfalls
        ORDER BY lost_sales_exposure_usd DESC NULLS LAST
        LIMIT 1) top
    RETURNING id, event_type, source, priority, entity_ref, action_id, status, score, payload, created_at
  `);
  const row = res.rows[0] as WorkflowSqlRow | undefined;
  return row ? toWorkflowEvent(row) : null;
}

/**
 * Record a `decision` event for a committed ops_actions row. Pass the same
 * `db` handle OR the open transaction (`tx`) from recordRecoveryAction /
 * recordReorder so the decision log commits atomically with the write.
 */
export async function logDecision(
  db: Executor,
  args: {
    actionId: string;
    storeId: string;
    productId: string;
    moveType: string;
    units: number | null;
    sourceStoreId: string | null;
    status: string;
    predictedRecapturedUsd: number | null;
    draftedRequest: string | null;
    approvedBy: string;
  },
): Promise<void> {
  const entityRef = `${args.storeId}:${args.productId}`;
  const payload = {
    move_type: args.moveType,
    units: args.units,
    source_store_id: args.sourceStoreId,
    predicted_recaptured_usd: args.predictedRecapturedUsd,
    approved_by: args.approvedBy,
    drafted_request: args.draftedRequest,
  };
  await db.execute(sql`
    INSERT INTO app.workflow_state
      (event_type, source, priority, entity_ref, action_id, status, score, payload)
    VALUES
      ('decision', ${args.moveType}, 50, ${entityRef}, ${args.actionId},
       ${args.status}, ${args.predictedRecapturedUsd},
       ${JSON.stringify(payload)}::jsonb)
  `);
}

/** Read the workflow-state log (newest first) — state_table export + any UI. */
export async function listWorkflowState(
  db: AppDb,
  limit = 500,
): Promise<WorkflowEvent[]> {
  const res = await db.execute(sql`
    SELECT id, event_type, source, priority, entity_ref, action_id, status,
           score, payload, created_at
    FROM app.workflow_state
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return (res.rows as WorkflowSqlRow[]).map(toWorkflowEvent);
}
