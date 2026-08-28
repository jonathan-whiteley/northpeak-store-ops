-- Workflow-state + observability table (Build 2 · Act/observability).
--
-- The ONE place the app records BOTH:
--   1. trigger events  — every time the ranked live view is (re)scored, by
--      whom/what. A scheduled/system trigger (`scheduled_scoring`,
--      `pipeline_update`) is the intended driver and carries a higher
--      `priority` than a person merely opening the view (`user_open`): the
--      important shortfalls surface without a human going to look.
--   2. recorded decisions — one row per committed action in app.ops_actions
--      (the approve/act step), linked by `action_id`, so the state table is a
--      standalone audit of what fired and what was decided, with timestamps.
--
-- Writable Postgres (the synced northpeak.app_* tables are read-only), so this
-- lives in the app-owned `app` schema alongside ops_actions.

CREATE TABLE IF NOT EXISTS app.workflow_state (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'trigger' (the view was scored) | 'decision' (an action was committed)
  event_type     text NOT NULL,
  -- For triggers: 'scheduled_scoring' | 'pipeline_update' | 'user_open'.
  -- For decisions: the move type ('transfer' | 'reorder' | ...).
  source         text NOT NULL,
  -- Higher = more autonomous. Scheduled/system triggers outrank user_open so a
  -- schedule surfaces the work instead of waiting for someone to open the page.
  priority       integer NOT NULL DEFAULT 0,
  -- 'STORE-xxxx:SKU-xxxx' — the top-ranked / decided position (nullable).
  entity_ref     text,
  -- For decisions: the committed app.ops_actions row.
  action_id      uuid,
  -- Snapshot of the decision status at record time (proposed/approved/...).
  status         text,
  -- Priority/severity score for a trigger (top lost-sales exposure $).
  score          double precision,
  -- Full detail: for triggers the scored-view summary + the defined schedule;
  -- for decisions the move/units/predicted-recaptured + approver.
  payload        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_state_type_idx    ON app.workflow_state (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_state_entity_idx  ON app.workflow_state (entity_ref);
CREATE INDEX IF NOT EXISTS workflow_state_action_idx  ON app.workflow_state (action_id);
