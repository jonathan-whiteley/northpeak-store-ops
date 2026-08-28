import { sql } from 'drizzle-orm';
import type { AppDb } from './index.js';

/**
 * Demo reset — NorthPeak Store Ops.
 *
 * The read-only position / shortfall / recovery data now lives in Unity
 * Catalog Lakebase Synced Tables:
 *   - northpeak.app_store_sku_position
 *   - northpeak.app_open_shortfalls
 *   - northpeak.app_recovery_recommendations
 * managed, continuous Delta→Postgres replication with UC governance. The app
 * READS them directly (see db/queries/stores.ts); there is no boot-time copy
 * to run and nothing to re-sync — the synced tables are always live. (Earlier
 * builds pulled a one-shot Delta→Lakebase mirror into `app.*` at boot; that
 * step is gone now that the synced tables exist.)
 *
 * So "Reset demo" only clears the app's OWN writable state: the ops_actions
 * table (approved transfers / markdown-holds / reorders) + chat state. The
 * synced tables are read-only in Postgres and are never touched — after a
 * reset the backlog simply reflects the live synced data again.
 */
export async function resetDemoState(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.messages RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.conversations RESTART IDENTITY CASCADE`);
    // The writable action table — the only place agent writes land.
    await tx.execute(sql`TRUNCATE TABLE app.ops_actions RESTART IDENTITY CASCADE`);
  });
}
