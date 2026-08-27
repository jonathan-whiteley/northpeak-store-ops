/**
 * "Stores by shortfall position" — nocturne bubble map.
 *
 * Real world map (CARTO dark raster tiles via react-leaflet) with one
 * CircleMarker per store. Radius = sqrt-scaled recent velocity. Color by
 * position status: stockout/at_risk → --np-short, overstock → --np-long,
 * healthy → neutral. The selected store gets an accent selection ring and
 * the map pans to it. When the agent's bulk write fires `dataMutated`, every
 * store bucket is refetched and bubbles whose status changed pulse (stroke).
 *
 * Implementation notes (Leaflet has sharp edges):
 *   - radius is a top-level prop → react-leaflet calls setRadius() on diff.
 *   - pathOptions go through setStyle() — color, fillColor, weight all work.
 *   - className on pathOptions only applies at layer-create time, so the
 *     pulse varies `weight` (stroke width) for 1s instead of CSS keyframes.
 *   - FitBounds only re-fits when the SET of store IDs changes.
 *   - Leaflet CSS is imported in client/src/index.css (not here).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Waypoints } from 'lucide-react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet';
import { fetchStoreBreakdown, fetchTransferLinks } from '@/lib/stores';
import { dataMutated } from '@/lib/events';
import { CapabilityMarker } from '@/shared/CapabilityMarker';
import type { StoreBucket, StoreTransferLink, PositionStatus } from '@/shared/types';

type Props = {
  statusGroup?: 'open' | 'all';
  zone?: string;
  onSelectStore?: (storeId: string) => void;
  /** The store currently selected into the detail card — gets an accent ring
   *  and the map pans to it. */
  selectedStoreId?: string | null;
};

// Nocturne domain colors. Leaflet SVG fills can't take var(...), so these
// mirror --np-short / --np-long / --pos-healthy from index.css.
const NP_SHORT = '#ff6a52';
const NP_LONG = '#ffab00';
const NEUTRAL = '#8a8fa6';
const ACCENT = '#9184d9';

const STATUS_COLORS: Record<PositionStatus, string> = {
  stockout: NP_SHORT,
  at_risk: NP_SHORT,
  overstock: NP_LONG,
  healthy: NEUTRAL,
};

const RADIUS_MIN = 5;
const RADIUS_MAX = 32;
const RADIUS_SCALE = 2.6;
const PULSE_MS = 1100;
const PULSE_WEIGHT = 4;
const REST_WEIGHT = 1.5;

function radiusFor(velocity: number): number {
  return Math.max(
    RADIUS_MIN,
    Math.min(RADIUS_MAX, Math.sqrt(Math.max(1, velocity)) * RADIUS_SCALE),
  );
}

// Re-fit only when the SET of store keys changes.
function FitBoundsOnSetChange({ stores }: { stores: StoreBucket[] }) {
  const map = useMap();
  const lastKey = useRef<string>('');

  useEffect(() => {
    if (stores.length === 0) return;
    const key = stores
      .map((s) => `${s.storeId}`)
      .sort()
      .join('|');
    if (key === lastKey.current) return;
    lastKey.current = key;

    const lats = stores.map((s) => s.lat);
    const lngs = stores.map((s) => s.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    if (Math.abs(maxLat - minLat) < 0.5 && Math.abs(maxLng - minLng) < 0.5) {
      map.setView([stores[0].lat, stores[0].lng], 6, { animate: true });
      return;
    }
    map.fitBounds(
      [
        [minLat, minLng],
        [maxLat, maxLng],
      ],
      { padding: [40, 40], animate: true },
    );
  }, [stores, map]);
  return null;
}

// Fly to the selected store (zoom in a touch so its ring + transfer arc land
// in view) — nicer than a flat pan, and it frames the arc's other endpoint.
function FlyToSelected({
  stores,
  selectedStoreId,
}: {
  stores: StoreBucket[];
  selectedStoreId?: string | null;
}) {
  const map = useMap();
  useEffect(() => {
    if (!selectedStoreId) return;
    const s = stores.find((x) => x.storeId === selectedStoreId);
    if (!s) return;
    map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 5), { duration: 0.6 });
  }, [selectedStoreId, stores, map]);
  return null;
}

// ── Transfer arcs ─────────────────────────────────────────────────────────
// A gentle quadratic-bezier curve between the shortfall store and its surplus
// source, so the "hero move" reads as a routed transfer rather than a chord.
type LatLng = [number, number];

function arcPoints(a: LatLng, b: LatLng, bend = 0.2): LatLng[] {
  const [lat1, lng1] = a;
  const [lat2, lng2] = b;
  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const dist = Math.hypot(dLat, dLng) || 1;
  // Perpendicular unit vector (lat/lng space; fine at map scale).
  const nx = -dLng / dist;
  const ny = dLat / dist;
  const off = bend * dist;
  const cLat = (lat1 + lat2) / 2 + nx * off;
  const cLng = (lng1 + lng2) / 2 + ny * off;
  const pts: LatLng[] = [];
  const STEPS = 24;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const u = 1 - t;
    pts.push([
      u * u * lat1 + 2 * u * t * cLat + t * t * lat2,
      u * u * lng1 + 2 * u * t * cLng + t * t * lng2,
    ]);
  }
  return pts;
}

// Stroke weight from the route's size (recommended units, else recaptured $).
function arcWeight(link: StoreTransferLink): number {
  const basis = link.units ?? (link.recapturedUsd ? link.recapturedUsd / 4000 : 0);
  return Math.max(2, Math.min(6, 2 + Math.sqrt(Math.max(0, basis))));
}

function fmtArcLabel(link: StoreTransferLink): string {
  const parts: string[] = [];
  if (link.units != null) parts.push(`${Math.round(link.units)} units`);
  if (link.recapturedUsd)
    parts.push(
      `$${new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(link.recapturedUsd)} recaptured`,
    );
  return parts.join(' · ') || `${link.skuCount} SKU${link.skuCount === 1 ? '' : 's'}`;
}

function TransferArcs({
  links,
  selectedStoreId,
  showAll,
}: {
  links: StoreTransferLink[];
  selectedStoreId?: string | null;
  showAll: boolean;
}) {
  // Which links touch the selected store (as shortfall origin OR surplus source).
  const selected = useMemo(
    () =>
      selectedStoreId
        ? links.filter(
            (l) =>
              l.storeId === selectedStoreId || l.surplusStoreId === selectedStoreId,
          )
        : [],
    [links, selectedStoreId],
  );
  const selectedKeys = new Set(
    selected.map((l) => `${l.storeId}->${l.surplusStoreId}`),
  );

  return (
    <>
      {/* Faint context arcs for every transfer-viable route (toggle). */}
      {showAll &&
        links.map((l) => {
          const key = `${l.storeId}->${l.surplusStoreId}`;
          if (selectedKeys.has(key)) return null; // drawn bright below
          return (
            <Polyline
              key={`all-${key}`}
              positions={arcPoints([l.storeLat, l.storeLng], [l.surplusLat, l.surplusLng])}
              pathOptions={{
                color: ACCENT,
                weight: 1,
                opacity: 0.18,
                dashArray: '3 6',
              }}
            />
          );
        })}

      {/* Bright arc(s) for the selected store's transfer route. */}
      {selected.map((l) => {
        const key = `${l.storeId}->${l.surplusStoreId}`;
        return (
          <Polyline
            key={`sel-${key}`}
            positions={arcPoints([l.storeLat, l.storeLng], [l.surplusLat, l.surplusLng])}
            pathOptions={{
              color: ACCENT,
              weight: arcWeight(l),
              opacity: 0.95,
              dashArray: '8 6',
              lineCap: 'round',
            }}
          >
            <Tooltip direction="top" opacity={1} sticky>
              <div className="text-xs">
                <div className="font-semibold">
                  {l.surplusStoreId} → {l.storeId}
                </div>
                <div className="text-muted-foreground">transfer · {fmtArcLabel(l)}</div>
              </div>
            </Tooltip>
          </Polyline>
        );
      })}
    </>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span
        className="inline-block size-2.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 0 3px ${color}22` }}
      />
      {label}
    </span>
  );
}

export function StoreMap({ statusGroup, zone, onSelectStore, selectedStoreId }: Props) {
  const [stores, setStores] = useState<StoreBucket[] | null>(null);
  const [links, setLinks] = useState<StoreTransferLink[]>([]);
  const [showAllArcs, setShowAllArcs] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    function reload() {
      fetchStoreBreakdown({
        statusGroup,
        zone: zone || undefined,
      })
        .then((data) => {
          if (cancelled) return;
          setStores(data);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setError((e as Error).message);
        });
      // Transfer arcs are global (not zone-scoped) — the hero move can cross
      // zones (North shortfall → South surplus). Non-fatal on failure.
      fetchTransferLinks()
        .then((data) => {
          if (!cancelled) setLinks(data);
        })
        .catch(() => {
          if (!cancelled) setLinks([]);
        });
    }
    reload();
    const unsub = dataMutated.subscribe(reload);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [statusGroup, zone]);

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        Couldn't load the map: {error}
      </div>
    );
  }

  if (stores === null) {
    return (
      <div className="rounded-xl border border-border bg-card h-[340px] flex items-center justify-center text-sm text-muted-foreground gap-2">
        <RefreshCw className="size-3.5 animate-spin" />
        Loading map…
      </div>
    );
  }

  const totalPositions = stores.reduce((a, s) => a + s.positions, 0);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">
            Same five styles, opposite problems
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <LegendChip color={NP_SHORT} label="Short" />
            <LegendChip color={NP_LONG} label="Overstocked" />
            <LegendChip color={NEUTRAL} label="Healthy" />
          </div>
        </div>
        <div className="text-xs text-muted-foreground shrink-0 text-right">
          {stores.length} {stores.length === 1 ? 'store' : 'stores'}
          <div>{totalPositions} positions</div>
        </div>
      </div>
      <div className="h-[300px] sm:h-[360px] relative">
        {stores.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            No affected stores in the current scope.
          </div>
        ) : (
          <MapContainer
            center={[38, -96]}
            zoom={4}
            minZoom={2}
            scrollWheelZoom={false}
            worldCopyJump
            className="h-full w-full"
            style={{ background: 'var(--np-land)' }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_2dkr_1_4d0428bc4c060fcc874d15d7"
              subdomains={['a', 'b', 'c', 'd']}
              maxZoom={19}
            />
            <FitBoundsOnSetChange stores={stores} />
            <FlyToSelected stores={stores} selectedStoreId={selectedStoreId} />
            <TransferArcs
              links={links}
              selectedStoreId={selectedStoreId}
              showAll={showAllArcs}
            />
            {stores.map((s) => (
              <StoreBubble
                key={s.storeId}
                store={s}
                onSelect={onSelectStore}
                selected={s.storeId === selectedStoreId}
              />
            ))}
          </MapContainer>
        )}
      </div>
      <div className="px-4 py-2.5 border-t border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[11px] text-muted-foreground hidden sm:inline">
            Click any store to trace its transfer.
          </span>
          {links.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAllArcs((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors"
              style={
                showAllArcs
                  ? { borderColor: ACCENT, color: ACCENT, boxShadow: `inset 0 0 0 1px ${ACCENT}` }
                  : { borderColor: 'var(--border)', color: 'var(--muted-foreground)' }
              }
              title="Toggle all transfer-viable routes"
            >
              <Waypoints className="size-3" />
              {showAllArcs ? 'Hide routes' : `All routes (${links.length})`}
            </button>
          )}
        </div>
        <CapabilityMarker icon="lakebase" label="Live store state · Lakebase" />
      </div>
    </div>
  );
}

function StoreBubble({
  store,
  onSelect,
  selected,
}: {
  store: StoreBucket;
  onSelect?: (storeId: string) => void;
  selected?: boolean;
}) {
  // Track whether `store.status` changed between renders to decide if we
  // should pulse.
  const prevStatus = useRef<PositionStatus | null>(null);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (prevStatus.current === null) {
      prevStatus.current = store.status;
      return;
    }
    if (prevStatus.current === store.status) return;
    prevStatus.current = store.status;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => clearTimeout(t);
  }, [store.status]);

  // pathOptions identity must change for react-leaflet to call setStyle().
  const pathOptions = useMemo(() => {
    const fill = STATUS_COLORS[store.status];
    // Selected → accent stroke ring; pulsing → thicker status stroke.
    const stroke = selected ? ACCENT : fill;
    return {
      color: stroke,
      fillColor: fill,
      fillOpacity: pulsing ? 0.8 : selected ? 0.7 : 0.55,
      weight: selected ? 3.5 : pulsing ? PULSE_WEIGHT : REST_WEIGHT,
    };
  }, [pulsing, store.status, selected]);

  return (
    <CircleMarker
      center={[store.lat, store.lng]}
      radius={radiusFor(store.recentVelocity) + (selected ? 3 : 0)}
      pathOptions={pathOptions}
      eventHandlers={
        onSelect
          ? {
              click: () => onSelect(store.storeId),
            }
          : {}
      }
    >
      <Tooltip direction="top" offset={[0, -4]} opacity={1}>
        <div className="text-xs">
          <div className="font-semibold">
            {store.storeName ?? `Store ${store.storeId}`}
            <span className="text-muted-foreground"> · {store.city}</span>
          </div>
          <div>{store.status}</div>
          <div>{store.positions} positions</div>
          <div>
            $
            {store.lostSalesExposureUsd.toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}{' '}
            lost-sales
          </div>
          {store.markdownExposureUsd > 0 && (
            <div>
              $
              {store.markdownExposureUsd.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}{' '}
              markdown
            </div>
          )}
        </div>
      </Tooltip>
    </CircleMarker>
  );
}
