-- ============================================================================
-- Live view (Build 2 · Visualize) — the ranked, flagged shortfall queue.
--
-- This is the query behind the Operations queue / map. It reads the READ-ONLY
-- Build-1 synced Unity Catalog tables (northpeak.app_*) and LEFT JOINs the
-- app's WRITABLE tables so the view reflects the closed loop:
--   • northpeak.app_store_sku_position     — the scored positions (synced UC)
--   • northpeak.app_recovery_recommendations — the ML model's ranked move (synced UC)
--   • app.ops_actions (latest, non-hold)   — the live recovery state (writable)
--
-- Ranked by lost-sales exposure (most $ at risk first) and flagged by
-- position_status. The scheduler (app.workflow_state trigger events) re-scores
-- this on a schedule so the top rows surface without a human opening the page.
--
-- NOTE: the app filters to open shortfalls (position_status IN
-- ('stockout','at_risk')). This export runs that same view.
-- ============================================================================

SELECT
  p.store_id || ':' || p.product_id            AS id,
  p.store_id,
  p.store_name,
  p.region,
  p.climate_zone,
  p.product_id,
  p.product_name,
  p.on_hand_units,
  p.avg_daily_velocity,
  p.weeks_of_supply,
  p.position_status,                            -- the flag
  round(p.lost_sales_exposure_usd::numeric, 2)  AS lost_sales_exposure_usd,  -- the rank key
  rr.recommended_move,
  rr.recommended_source_store_id,
  rr.recommended_units,
  round(rr.predicted_recaptured_usd::numeric, 2) AS predicted_recaptured_usd,
  la.move_type   AS live_move_type,             -- from the writable table (closed loop)
  la.status      AS action_status
FROM northpeak.app_store_sku_position p
LEFT JOIN northpeak.app_recovery_recommendations rr
  ON rr.store_id = p.store_id AND rr.product_id = p.product_id
LEFT JOIN LATERAL (
  SELECT a.move_type, a.status
  FROM app.ops_actions a
  WHERE a.store_id = p.store_id AND a.product_id = p.product_id
    AND a.move_type <> 'markdown_hold'
  ORDER BY a.created_at DESC
  LIMIT 1
) la ON true
WHERE p.position_status IN ('stockout', 'at_risk')
ORDER BY p.lost_sales_exposure_usd DESC NULLS LAST
LIMIT 50;
