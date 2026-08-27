/**
 * The Operations page — the WRITE SURFACE for the use case, reshaped to the
 * nocturne mockup.
 *
 * Layout (top → bottom):
 *   Header       — kicker / headline / data-driven sub / sort segmented /
 *                  persona chip
 *   KpiCards     — lost-sales · markdown · recoverable · approved (Lakebase)
 *   Map + queue  — StoreMap (dark, colored bubbles) beside WorstShortfalls
 *   StoreDetail  — ranked recovery moves + Approve / Ask why (Genie)
 *   Full queue   — the complete filterable ShortfallTable + PositionDrawer
 *
 * Data: every surface is wired to the real store-ops routes. Selection state:
 *   - `detailId`   → the store×SKU in the inline StoreDetailCard + map focus
 *   - `selectedId` → the table row open in the slide-over drawer
 * The `dataMutated` pub/sub keeps KPIs, queue, map and detail in sync when
 * the agent's write lands.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { fetchPositions, fetchPositionSummary } from '@/lib/stores';
import { dataMutated } from '@/lib/events';
import type {
  PositionRow,
  PositionStatus,
  PositionSummary,
} from '@/shared/types';

import { StoreMap } from './StoreMap';
import { KpiCards } from './KpiCards';
import { WorstShortfalls } from './WorstShortfalls';
import { StoreDetailCard } from './StoreDetailCard';
import { ShortfallTable } from './ShortfallTable';
import { PositionDrawer } from './PositionDrawer';

const PERSONA = {
  initials: 'DR',
  name: 'Dana Ruiz',
  role: 'SVP Retail Operations',
};

export function OperationsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const storeFromUrl = searchParams.get('store') ?? '';
  const skuFromUrl = searchParams.get('sku') ?? '';

  const [filter, setFilter] = useState<PositionStatus | 'all' | 'recovery'>(
    (searchParams.get('status') as PositionStatus | 'recovery' | null) ?? 'all',
  );
  const [storeFilter, setStoreFilter] = useState(storeFromUrl);
  const [skuFilter, setSkuFilter] = useState(skuFromUrl);
  const [zoneFilter, setZoneFilter] = useState<string | null>(
    searchParams.get('zone') ?? null,
  );
  const [sort, setSort] = useState<'exposure' | 'velocity'>(
    (searchParams.get('sort') as 'exposure' | 'velocity') ?? 'exposure',
  );
  const [search, setSearch] = useState('');

  // Sync all queue filters → URL so deep links + back/forward work.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const setOrDelete = (key: string, value: string | null) => {
      if (value) next.set(key, value);
      else next.delete(key);
    };
    setOrDelete('store', storeFilter || null);
    setOrDelete('sku', skuFilter || null);
    setOrDelete('zone', zoneFilter);
    setOrDelete('status', filter === 'all' ? null : filter);
    setOrDelete('sort', sort === 'exposure' ? null : sort);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFilter, skuFilter, zoneFilter, filter, sort]);

  // Update state when URL changes (e.g. user clicks a link from Analytics).
  useEffect(() => {
    const urlStore = searchParams.get('store') ?? '';
    if (urlStore !== storeFilter) setStoreFilter(urlStore);
    const urlSku = searchParams.get('sku') ?? '';
    if (urlSku !== skuFilter) setSkuFilter(urlSku);
    const urlZone = searchParams.get('zone');
    if (urlZone !== zoneFilter) setZoneFilter(urlZone);
    const urlStatus = (searchParams.get('status') as PositionStatus | 'recovery' | null) ?? 'all';
    if (urlStatus !== filter) setFilter(urlStatus);
    const urlSort = (searchParams.get('sort') as 'exposure' | 'velocity') ?? 'exposure';
    if (urlSort !== sort) setSort(urlSort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [rows, setRows] = useState<PositionRow[]>([]);
  const [openRows, setOpenRows] = useState<PositionRow[]>([]);
  const [summary, setSummary] = useState<PositionSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openLoading, setOpenLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      // Convert 'recovery' filter to the actual API statusGroup
      let statusParam: PositionStatus | undefined;
      const statusGroup: 'open' | 'all' = 'all';
      if (filter === 'recovery' || filter === 'all') {
        statusParam = undefined;
      } else {
        statusParam = filter;
      }

      const [list, sum] = await Promise.all([
        fetchPositions({
          statusGroup,
          status: statusParam,
          zone: zoneFilter ?? undefined,
          store: storeFilter || undefined,
          sku: skuFilter || undefined,
          sort,
        }),
        fetchPositionSummary(),
      ]);
      setRows(list);
      setSummary(sum);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // The open-shortfall backlog (fixed scope: open + by exposure) drives the
  // "Worst shortfalls" queue AND the "Recoverable this week" KPI. Kept
  // independent of the table's filter so the hero queue stays stable.
  async function reloadOpen() {
    setOpenLoading(true);
    try {
      const list = await fetchPositions({ statusGroup: 'open', sort: 'exposure' });
      setOpenRows(list);
    } catch {
      /* non-fatal — queue shows empty state */
    } finally {
      setOpenLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, storeFilter, skuFilter, zoneFilter, sort]);

  useEffect(() => {
    void reloadOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return dataMutated.subscribe(() => {
      void reload();
      void reloadOpen();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, storeFilter, skuFilter, zoneFilter, sort]);

  // Recoverable this week — sum of the model's recaptured $ over open rows.
  const recoverableUsd = useMemo(
    () =>
      openRows.reduce(
        (a, r) => a + (r.predictedRecapturedUsd ?? 0),
        0,
      ),
    [openRows],
  );

  // Apply client-side filtering for "recovery in progress" + search.
  const filteredRows = useMemo(() => {
    let result = rows;
    if (filter === 'recovery') {
      result = result.filter((r) => r.liveMoveType !== null);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (r) =>
          (r.storeName ?? '').toLowerCase().includes(q) ||
          (r.city ?? '').toLowerCase().includes(q) ||
          (r.productName ?? '').toLowerCase().includes(q) ||
          (r.productId ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [rows, filter, search]);

  const detailStoreId = detailId ? detailId.split(':')[0] : null;

  const subline = summary
    ? `${summary.openShortfalls} open shortfalls · ${fmtUsd(recoverableUsd)} recoverable · ${summary.recoveriesInProgress} in recovery · refreshed just now`
    : 'Loading the shortfall backlog…';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-6 sm:py-10 space-y-6 sm:space-y-8">
        {/* Header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div
              className="text-xs font-semibold uppercase tracking-[0.18em]"
              style={{ color: 'var(--np-short)' }}
            >
              Cold snap · week 3
            </div>
            <h1 className="display text-3xl sm:text-4xl font-semibold tracking-tight text-foreground mt-2">
              Short in the North, piling up in the South.
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
              {subline}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <SortSegmented value={sort} onChange={setSort} />
            <PersonaChip />
          </div>
        </div>

        {summary && <KpiCards summary={summary} recoverableUsd={recoverableUsd} />}

        {/* Map + Worst shortfalls */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-4 lg:gap-6 items-start">
          <StoreMap
            statusGroup="all"
            zone={zoneFilter ?? undefined}
            onSelectStore={setStoreFilter}
            selectedStoreId={detailStoreId}
          />
          <WorstShortfalls
            rows={openRows}
            selectedId={detailId}
            onSelect={setDetailId}
            loading={openLoading}
          />
        </div>

        {/* Store detail — ranked recovery moves */}
        <StoreDetailCard id={detailId} />

        {/* Full filterable queue */}
        <div className="space-y-4 pt-2">
          <hr className="hr" />
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Full shortfall queue
          </div>
          <ShortfallTable
            rows={filteredRows}
            loading={loading}
            error={error}
            statusFilter={filter}
            onStatusFilter={setFilter}
            search={search}
            onSearch={setSearch}
            zone={zoneFilter ?? undefined}
            onZoneFilter={setZoneFilter}
            sort={sort}
            onSortChange={setSort}
            onSelect={setSelectedId}
          />
        </div>
      </div>

      <PositionDrawer
        id={selectedId}
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onMutated={() => {
          setSelectedId(null);
          void reload();
          void reloadOpen();
        }}
      />
    </div>
  );
}

function fmtUsd(n: number): string {
  return `$${new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n)}`;
}

function SortSegmented({
  value,
  onChange,
}: {
  value: 'exposure' | 'velocity';
  onChange: (v: 'exposure' | 'velocity') => void;
}) {
  const opts: { value: 'exposure' | 'velocity'; label: string }[] = [
    { value: 'exposure', label: 'By exposure' },
    { value: 'velocity', label: 'By velocity' },
  ];
  return (
    <div className="inline-flex rounded-lg border border-border overflow-hidden">
      {opts.map((o, i) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 text-[13px] transition-colors ${
              i > 0 ? 'border-l border-border' : ''
            } ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            style={
              active
                ? { boxShadow: 'inset 0 0 0 1px var(--accent)', color: 'var(--accent)' }
                : undefined
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PersonaChip() {
  return (
    <div className="inline-flex items-center gap-2.5 rounded-full border border-border bg-card pl-1.5 pr-3 py-1.5">
      <span
        className="inline-flex size-7 items-center justify-center rounded-full text-[11px] font-semibold"
        style={{ background: 'var(--accent)', color: 'var(--primary-foreground)' }}
      >
        {PERSONA.initials}
      </span>
      <span className="leading-tight">
        <span className="block text-xs font-semibold text-foreground">{PERSONA.name}</span>
        <span className="block text-[10px] text-muted-foreground">{PERSONA.role}</span>
      </span>
    </div>
  );
}
