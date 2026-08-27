/**
 * "Worst shortfalls" — the ranked queue beside the map. Presentational:
 * OperationsView passes the open positions (sorted by lost-sales exposure);
 * clicking a row selects that store×SKU into the StoreDetailCard and focuses
 * the map. Rows that flip status between `dataMutated` refetches pulse.
 */
import { AlertCircle } from 'lucide-react';
import { usePulseOnChange } from '@/lib/usePulseOnChange';
import { StatusBadge, MoveBadge } from '@/shared/badges';
import type { PositionRow } from '@/shared/types';

export function WorstShortfalls({
  rows,
  selectedId,
  onSelect,
  loading,
}: {
  rows: PositionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}) {
  const top = rows.slice(0, 8);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle className="size-4 shrink-0" style={{ color: 'var(--np-short)' }} />
          <h3 className="text-sm font-semibold truncate">Worst shortfalls</h3>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">by exposure</span>
      </div>

      <ul className="divide-y divide-border overflow-y-auto flex-1 max-h-[360px]">
        {loading && top.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">
            Loading…
          </li>
        )}
        {!loading && top.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            No open shortfalls. The backlog is clear.
          </li>
        )}
        {top.map((r, i) => (
          <QueueRow
            key={r.id}
            row={r}
            rank={i + 1}
            selected={r.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function QueueRow({
  row: r,
  rank,
  selected,
  onSelect,
}: {
  row: PositionRow;
  rank: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const statusKey = r.liveMoveType
    ? `${r.positionStatus}:${r.liveMoveType}`
    : r.positionStatus;
  const pulse = usePulseOnChange(statusKey);

  return (
    <li
      onClick={() => onSelect(r.id)}
      className={`px-4 py-3 cursor-pointer transition-colors ${
        selected ? '' : 'hover:bg-muted/50'
      } ${pulse ? 'animate-pulse-row' : ''}`}
      style={
        selected
          ? {
              boxShadow: 'inset 3px 0 0 0 var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
            }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground w-4 shrink-0">
              {rank}
            </span>
            <span className="font-medium text-sm truncate">
              {r.storeName ?? `Store ${r.storeId}`}
            </span>
          </div>
          <div className="text-xs text-muted-foreground truncate pl-6">
            {r.productName ?? r.productId}
            {r.city ? ` · ${r.city}` : ''}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-sm text-foreground">
            $
            {r.lostSalesExposureUsd?.toLocaleString(undefined, {
              maximumFractionDigits: 0,
            }) ?? '—'}
          </div>
          <div className="mt-1">
            {r.liveMoveType ? (
              <MoveBadge move={r.liveMoveType} />
            ) : (
              <StatusBadge status={r.positionStatus} />
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
