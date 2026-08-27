/**
 * The store-detail card — the hero of the Operations page. Given the
 * store×SKU position id selected from the "Worst shortfalls" queue, it
 * fetches the full detail (position + shortfall + ranked recovery options +
 * recorded actions) and renders:
 *   - a kicker (Sold out / At risk / Dead stock / Healthy · style) + title
 *   - three headline stats (on hand / weekly demand / exposure)
 *   - an "approved & written back to Lakebase" banner once an action exists
 *   - up to three RANKED move cards (Recommended / Costlier / Fallback) with
 *     the model's units, cost, recaptured $ and net value
 *   - Approve + "Ask why" — both route through the Genie assistant dock
 *     (Approve → the agent's execute_recovery_action write; the KPIs/queue/
 *     map then refetch live off `dataMutated`). No client-side write path.
 *
 * Data: /api/positions/:id (getPosition + getShortfall + getRecommendation +
 * listActionsForPosition). Re-fetches on `dataMutated`.
 */
import { useEffect, useState } from 'react';
import { Check, HelpCircle, PackagePlus } from 'lucide-react';
import { fetchPosition, reorderUnits } from '@/lib/stores';
import { dataMutated } from '@/lib/events';
import { dockController } from '@/chat/dockController';
import { CapabilityMarker } from '@/shared/CapabilityMarker';
import { MoveBadge } from '@/shared/badges';
import type { PositionDetail, PositionStatus, MoveOption } from '@/shared/types';

const KICKER: Record<PositionStatus, string> = {
  stockout: 'Sold out',
  at_risk: 'At risk',
  overstock: 'Dead stock',
  healthy: 'Healthy',
};

const RANK_BADGE: { label: string; color: string }[] = [
  { label: 'Recommended', color: 'var(--success)' },
  { label: 'Costlier', color: 'var(--np-long)' },
  { label: 'Fallback', color: 'var(--muted-foreground)' },
];

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function StoreDetailCard({ id }: { id: string | null }) {
  const [detail, setDetail] = useState<PositionDetail | null>(null);
  const [loading, setLoading] = useState(false);

  // Direct reorder / restock write-back UI state (the manager button, distinct
  // from the agent-mediated Approve/Ask why flow). Reset whenever the selected
  // position changes so the inline control doesn't carry over between stores.
  const [reorderOpen, setReorderOpen] = useState(false);
  const [reorderQty, setReorderQty] = useState<number | ''>('');
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [reorderConfirmed, setReorderConfirmed] = useState(false);

  useEffect(() => {
    setReorderOpen(false);
    setReorderQty('');
    setReordering(false);
    setReorderError(null);
    setReorderConfirmed(false);
  }, [id]);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const load = () =>
      fetchPosition(id)
        .then((d) => {
          if (!cancelled) setDetail(d);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    void load();
    const unsub = dataMutated.subscribe(() => void load());
    return () => {
      cancelled = true;
      unsub();
    };
  }, [id]);

  if (!id) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center text-sm text-muted-foreground">
        Pick a store from <span className="text-foreground font-medium">Worst shortfalls</span>{' '}
        to see the ranked recovery moves.
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
        {loading ? 'Loading store detail…' : 'Couldn’t load this store.'}
      </div>
    );
  }

  const { position: p, recommendation } = detail;
  const overstock = p.positionStatus === 'overstock';
  const weeklyDemand =
    p.avgDailyVelocity !== null ? Math.round(p.avgDailyVelocity * 7) : null;
  const ranking: MoveOption[] = recommendation?.moveRanking ?? [];
  const hasAction = detail.actions.some(
    (a) => a.moveType !== 'markdown_hold',
  );

  const approvePrompt = `Approve the recommended recovery move for Store ${p.storeId} on SKU ${p.productId} (${p.productName ?? ''}). Draft the transfer request and record it.`;
  const askWhyPrompt = `Why is Store ${p.storeId} ${overstock ? 'sitting on surplus' : 'short'} on ${p.productName ?? p.productId}? Walk me through the options.`;

  // Direct reorder is offered for shortfalls (stockout / at risk). Default the
  // quantity to ~two weeks of demand (ceil of avg daily velocity × 14), or a
  // round 24 when velocity is unknown.
  const isShortfall =
    p.positionStatus === 'stockout' || p.positionStatus === 'at_risk';
  const defaultReorderQty =
    p.avgDailyVelocity != null && p.avgDailyVelocity > 0
      ? Math.ceil(p.avgDailyVelocity * 14)
      : 24;

  const openReorder = () => {
    setReorderError(null);
    setReorderQty((q) => (q === '' ? defaultReorderQty : q));
    setReorderOpen(true);
  };

  const submitReorder = async () => {
    const units =
      typeof reorderQty === 'number' ? reorderQty : Number(reorderQty);
    if (!Number.isFinite(units) || units < 1) {
      setReorderError('Enter a positive unit count.');
      return;
    }
    setReordering(true);
    setReorderError(null);
    try {
      await reorderUnits({
        storeId: p.storeId,
        productId: p.productId,
        units: Math.floor(units),
      });
      setReorderConfirmed(true);
      setReorderOpen(false);
      // Cascade: KPIs / queue / map / activity refetch off this event.
      dataMutated.emit();
    } catch (e) {
      setReorderError(e instanceof Error ? e.message : 'Reorder failed.');
    } finally {
      setReordering(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="px-5 sm:px-6 pt-5 pb-4 border-b border-border">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.16em]"
          style={{
            color: overstock ? 'var(--np-long)' : 'var(--np-short)',
          }}
        >
          {KICKER[p.positionStatus]} · {p.productName ?? p.productId}
        </div>
        <h3 className="display text-xl sm:text-2xl font-semibold text-foreground mt-1">
          Store {p.storeId}
          {p.storeName ? ` · ${p.storeName}` : ''}
        </h3>
        {(p.city || p.climateZone) && (
          <div className="text-xs text-muted-foreground mt-1">
            {[p.city, p.region, p.climateZone].filter(Boolean).join(' · ')}
          </div>
        )}

        {/* Three stats */}
        <div className="grid grid-cols-3 gap-3 mt-4">
          <Stat label="On hand" value={p.onHandUnits?.toLocaleString() ?? '—'} />
          <Stat
            label={overstock ? 'Weekly sales' : 'Weekly demand'}
            value={weeklyDemand !== null ? weeklyDemand.toLocaleString() : '—'}
          />
          <Stat
            label={overstock ? 'Markdown exposure' : 'Lost-sales exposure'}
            value={usd(overstock ? p.markdownExposureUsd : p.lostSalesExposureUsd)}
            accent={overstock ? 'var(--np-long)' : 'var(--np-short)'}
          />
        </div>
      </div>

      {/* Approved banner */}
      {hasAction && (
        <div
          className="px-5 sm:px-6 py-3 border-b border-border flex items-center justify-between gap-3"
          style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
        >
          <div className="flex items-center gap-2 text-sm">
            <Check className="size-4" style={{ color: 'var(--success)' }} />
            <span className="text-foreground font-medium">Recovery recorded</span>
          </div>
          <CapabilityMarker icon="lakebase" label="Written back · Lakebase" />
        </div>
      )}

      {/* Ranked move cards */}
      <div className="px-5 sm:px-6 py-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            Ranked recovery moves
          </div>
          <CapabilityMarker icon="genie" label="Ranked by the model · Genie" />
        </div>

        {ranking.length === 0 ? (
          <div
            className="rounded-lg px-4 py-3 text-sm"
            style={{
              background: 'color-mix(in srgb, var(--np-long) 12%, transparent)',
              color: 'var(--warning-subtle-foreground)',
            }}
          >
            No recovery recommendation yet — the model scores this shortfall in
            the ranking step.
          </div>
        ) : (
          ranking.slice(0, 3).map((opt, i) => (
            <MoveCard key={i} rank={i} opt={opt} />
          ))
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={() => dockController.openAndSend(approvePrompt)}
            disabled={ranking.length === 0}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
          >
            <Check className="size-4" />
            Approve
          </button>
          <button
            onClick={() => dockController.openAndSend(askWhyPrompt)}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors"
          >
            <HelpCircle className="size-4" />
            Ask why
          </button>

          {/* Direct reorder / restock write-back — a manager action separate
              from the agent-mediated Approve/Ask why. Writes straight to
              Lakebase app.ops_actions (move_type='reorder'). */}
          {isShortfall && !reorderOpen && (
            <button
              onClick={openReorder}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
              style={{
                color: 'var(--move-reorder)',
                background: 'color-mix(in srgb, var(--move-reorder) 16%, transparent)',
                boxShadow:
                  'inset 0 0 0 1px color-mix(in srgb, var(--move-reorder) 42%, transparent)',
              }}
            >
              <PackagePlus className="size-4" />
              Reorder units
            </button>
          )}
        </div>

        {/* Inline reorder control */}
        {isShortfall && reorderOpen && (
          <div
            className="rounded-lg border p-3 mt-1"
            style={{
              borderColor: 'color-mix(in srgb, var(--move-reorder) 42%, transparent)',
              background: 'color-mix(in srgb, var(--move-reorder) 8%, transparent)',
            }}
          >
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: 'var(--move-reorder)' }}>
              <PackagePlus className="size-3.5" />
              Reorder from DC
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Expedite fresh stock to Store {p.storeId} for{' '}
              {p.productName ?? p.productId}. Records a reorder in Lakebase and
              cascades to the queue.
            </p>
            <div className="flex flex-wrap items-end gap-3 mt-3">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Units
                </span>
                <input
                  type="number"
                  min={1}
                  value={reorderQty}
                  onChange={(e) =>
                    setReorderQty(
                      e.target.value === '' ? '' : Number(e.target.value),
                    )
                  }
                  className="w-28 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm text-foreground outline-none focus:border-[var(--move-reorder)]"
                />
              </label>
              <button
                onClick={() => void submitReorder()}
                disabled={reordering}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{ background: 'var(--move-reorder)' }}
              >
                <Check className="size-4" />
                {reordering ? 'Recording…' : 'Confirm reorder'}
              </button>
              <button
                onClick={() => {
                  setReorderOpen(false);
                  setReorderError(null);
                }}
                disabled={reordering}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
            {reorderError && (
              <div className="text-xs mt-2" style={{ color: 'var(--np-short)' }}>
                {reorderError}
              </div>
            )}
          </div>
        )}

        {/* Success confirmation */}
        {reorderConfirmed && !reorderOpen && (
          <div
            className="rounded-lg px-3 py-2 mt-1 flex items-center gap-2 text-sm"
            style={{
              background: 'color-mix(in srgb, var(--move-reorder) 12%, transparent)',
              color: 'var(--move-reorder)',
            }}
          >
            <Check className="size-4" />
            <span className="font-medium">
              Reorder recorded and written back to Lakebase.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div
        className="mt-1 font-mono text-lg font-semibold"
        style={{ color: accent ?? 'var(--foreground)' }}
      >
        {value}
      </div>
    </div>
  );
}

function MoveCard({ rank, opt }: { rank: number; opt: MoveOption }) {
  const badge = RANK_BADGE[rank] ?? RANK_BADGE[2];
  const recommended = rank === 0;

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: recommended
          ? 'color-mix(in srgb, var(--success) 45%, transparent)'
          : 'var(--border)',
        background: recommended
          ? 'color-mix(in srgb, var(--success) 8%, transparent)'
          : 'var(--background)',
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted-foreground">#{rank + 1}</span>
          <MoveBadge move={opt.move} />
        </div>
        <span
          className="text-[10px] font-semibold uppercase tracking-wider rounded px-2 py-0.5"
          style={{
            color: badge.color,
            background: `color-mix(in srgb, ${badge.color} 16%, transparent)`,
          }}
        >
          {badge.label}
        </span>
      </div>

      <div className="text-sm font-mono text-foreground mt-2">
        {opt.units != null ? `${opt.units} units` : 'Units TBD'}
        {opt.sourceStoreId ? ` from Store ${opt.sourceStoreId}` : ''}
        {opt.substituteProductId ? ` · sub ${opt.substituteProductId}` : ''}
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2 text-xs">
        <Metric label="Net value" value={usd(opt.predictedNetValueUsd)} accent="var(--success)" />
        <Metric label="Recaptured" value={usd(opt.predictedRecapturedUsd)} />
        <Metric label="Cost" value={usd(opt.costUsd)} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div>
      <div className="text-muted-foreground font-semibold">{label}</div>
      <div className="font-mono" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
    </div>
  );
}
