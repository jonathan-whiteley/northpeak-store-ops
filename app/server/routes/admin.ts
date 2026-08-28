import type { Application } from 'express';
import { resetDemoState } from '../db/sync.js';
import type { AppDb } from '../db/index.js';

/**
 * Demo-only admin routes. /api/admin/reset truncates the app's writable table
 * (ops_actions) + chat state — click it between demos to start clean. All
 * agent writes are wiped: the backlog returns to the live synced-table state
 * and exposure returns to full. The read-only Lakebase Synced Tables
 * (northpeak.app_*) are always live and are never touched.
 */
export function registerAdminRoutes(
  app: Application,
  deps: { db: AppDb },
): void {
  const { db } = deps;
  app.post('/api/admin/reset', async (_req, res) => {
    await resetDemoState(db);
    res.json({ ok: true });
  });
}
