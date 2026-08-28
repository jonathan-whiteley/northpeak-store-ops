import type { Application } from 'express';
import { recentActivity, listWorkflowState } from '../db/queries/index.js';
import type { AppDb } from '../db/index.js';

/**
 * Activity feed — recorded recovery actions (transfers, expedites,
 * substitutes, markdown holds) from app.ops_actions, newest first.
 * Powers the home-page "Recent activity" list. Also exposes the
 * workflow-state/observability log (trigger + decision events).
 */
export function registerActivityRoutes(
  app: Application,
  deps: { db: AppDb },
): void {
  app.get('/api/activity/recent', async (req, res) => {
    // `?limit=abc` → fallback 20; clamp to 100. Guards against NaN/array
    // values that would otherwise bind as `LIMIT NaN` and throw cryptically.
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 100) : 20;
    const events = await recentActivity(deps.db, limit);
    res.json(events);
  });

  // Observability log — trigger events (scheduled/system re-scores) +
  // decision events (committed actions), newest first.
  app.get('/api/activity/workflow-state', async (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 500) : 200;
    const events = await listWorkflowState(deps.db, limit);
    res.json(events);
  });
}
