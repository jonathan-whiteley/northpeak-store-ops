import type { Application } from 'express';
import express from 'express';
import { getPosition, listPositions, recordReorder } from '../db/queries/index.js';
import { getCurrentUserEmail } from '../lib/user.js';
import type { AppDb } from '../db/index.js';

/**
 * Supply write-back routes — the DIRECT (non-agent) restock path.
 *
 * Contrast with routes/stores.ts (all read-only) and the agent's
 * `execute_recovery_action` tool (the Genie-mediated recovery write): this
 * is a plain manager button. `POST /api/supply/reorder` takes a store×SKU +
 * a unit count, attributes it to the OBO viewing user, and INSERTs one
 * `ops_actions` row with `move_type='reorder'` (see recordReorder). The
 * Operations queue / KPIs / map / activity feed all cascade off that row.
 *
 * Modeled on the homebase `POST /api/supply/release-po` pattern: a direct
 * button → REST → a Lakebase write → a live cascade, kept separate from the
 * read-only synced mirrors.
 */

type Deps = { db: AppDb };

function intUnits(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), 100000);
}

export function registerSupplyRoutes(app: Application, deps: Deps): void {
  const { db } = deps;

  // --- POST /api/supply/reorder (direct restock write-back) --------------
  // Body: { store_id, product_id, units }. Returns { action_id }.
  app.post('/api/supply/reorder', express.json(), async (req, res) => {
    const body = (req.body ?? {}) as {
      store_id?: unknown;
      product_id?: unknown;
      units?: unknown;
    };
    const storeId =
      typeof body.store_id === 'string' && body.store_id.length > 0
        ? body.store_id
        : null;
    const productId =
      typeof body.product_id === 'string' && body.product_id.length > 0
        ? body.product_id
        : null;
    const units = intUnits(body.units);

    if (!storeId || !productId) {
      res.status(400).json({ error: 'store_id and product_id are required' });
      return;
    }
    if (units === null) {
      res.status(400).json({ error: 'units must be a positive integer' });
      return;
    }

    // Resolve a friendly product name for the drafted memo (best-effort).
    const position = await getPosition(db, `${storeId}:${productId}`);
    const userEmail = getCurrentUserEmail(req);
    const { actionId } = await recordReorder(db, {
      storeId,
      productId,
      units,
      productName: position?.productName ?? null,
      userEmail,
    });
    res.json({ action_id: actionId });
  });

  // --- GET /api/supply/reorder-queue (open shortfalls to restock) --------
  // The stockout / at-risk backlog, worst exposure first — the candidates
  // for a direct reorder. Reuses listPositions('open').
  app.get('/api/supply/reorder-queue', async (_req, res) => {
    const rows = await listPositions(db, { statusGroup: 'open', sort: 'exposure' });
    res.json(rows);
  });
}
