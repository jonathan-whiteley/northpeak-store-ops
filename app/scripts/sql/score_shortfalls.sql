-- Scored trigger: rank the live shortfall view and record ONE trigger event.
--
-- This is the routine the scheduler (server.ts, default every 30 min) and the
-- SDP pipeline-update webhook both call; it is also runnable standalone. It
-- ranks open shortfalls by lost-sales exposure over the READ-ONLY synced
-- northpeak.app_* tables and writes a `trigger` row to app.workflow_state so
-- the important positions are surfaced without a human opening the page.
--
-- Parameter :source is the trigger driver ('scheduled_scoring' by default).
-- Parameter :priority ranks it above a person opening the view (user_open=10).

INSERT INTO app.workflow_state (event_type, source, priority, entity_ref, score, payload)
SELECT
  'trigger',
  :'source',
  :priority,
  top.entity_ref,
  top.top_exposure_usd,
  jsonb_build_object(
    'trigger',            :'source',
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
      count(*)                                   AS open_shortfalls,
      COALESCE(SUM(lost_sales_exposure_usd), 0)  AS total_exposure_usd,
      (SELECT count(*) FROM northpeak.app_store_sku_position
        WHERE position_status IN ('stockout','at_risk')) AS scored_rows
    FROM northpeak.app_open_shortfalls) agg,
  (SELECT store_id || ':' || product_id AS entity_ref,
          lost_sales_exposure_usd       AS top_exposure_usd
     FROM northpeak.app_open_shortfalls
    ORDER BY lost_sales_exposure_usd DESC NULLS LAST
    LIMIT 1) top
RETURNING id, source, priority, entity_ref, score, created_at;
