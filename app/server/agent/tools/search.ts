/**
 * `search_products` — Lakebase Search (Build 2 · Assist retrieval).
 *
 * Hybrid product retrieval over the Build-1 Lakebase Search index
 * `northpeak.product_search` (a synced mirror of the catalog with a BM25
 * full-text index `idx_product_search_bm25` + a pgvector ANN index
 * `idx_product_search_ann` over a databricks-gte-large-en embedding). We
 * embed the natural-language query with the SAME gte-large-en endpoint, then
 * fuse BM25 + ANN candidates with Reciprocal Rank Fusion (k=60).
 *
 * This is what the agent calls when drafting a SUBSTITUTE recovery move — it
 * retrieves comparable in-stock products FROM the Lakebase Search index rather
 * than a separate vector store. Read-only. Ported from the reference
 * implementation in scripts/search_products.py.
 */
import { sql } from 'drizzle-orm';
import * as mlflow from 'mlflow-tracing';
import { z } from 'zod';
import { loggedTool as tool } from './logged-tool.js';
import { authHeaders } from '../../lib/auth.js';
import type { AppDb } from '../../db/index.js';
import type { Request } from 'express';

const EMBED_ENDPOINT = 'databricks-gte-large-en';
const RRF_K = 60;

export type ProductCandidate = {
  product_id: string;
  product_name: string | null;
  category: string | null;
  subcategory: string | null;
  price_usd: number | null;
  seasonality: string | null;
  description: string | null;
  bm25_rank: number | null;
  ann_rank: number | null;
  cosine_sim: number | null;
  rrf_score: number | null;
};

/** Embed a query string with the gte-large-en FMAPI endpoint (1024-dim). */
async function embedQuery(
  req: Request,
  host: string,
  text: string,
): Promise<number[]> {
  const headers = await authHeaders(req);
  headers.set('Content-Type', 'application/json');
  const resp = await fetch(
    `${host}/serving-endpoints/${EMBED_ENDPOINT}/invocations`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: [text] }),
      signal: AbortSignal.timeout(60 * 1000),
    },
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`embedding endpoint ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('embedding endpoint returned no vector');
  return vec;
}

/**
 * Hybrid RRF search over northpeak.product_search. Mirrors HYBRID_SQL in
 * scripts/search_products.py: BM25 (lakebase_bm25) fused with pgvector ANN
 * (cosine) via Reciprocal Rank Fusion.
 */
export async function searchProducts(
  db: AppDb,
  req: Request,
  host: string,
  query: string,
  limit = 8,
): Promise<ProductCandidate[]> {
  const vec = await embedQuery(req, host, query);
  const vecStr = `[${vec.join(',')}]`;
  const res = await db.execute(sql`
    WITH bm25 AS (
      SELECT productid, productname, category, subcategory, description,
             priceusd, seasonality,
             RANK() OVER (
               ORDER BY search_tsv <@> to_bm25query(
                 to_tsvector('english', ${query}), 'northpeak.idx_product_search_bm25') DESC
             ) AS bm25_rank
      FROM northpeak.product_search
      WHERE search_tsv @@ plainto_tsquery('english', ${query})
      ORDER BY bm25_rank
      LIMIT 40
    ),
    ann AS (
      SELECT productid, productname, category, subcategory, description,
             priceusd, seasonality,
             1 - (embedding <=> ${vecStr}::vector) AS cosine_sim,
             RANK() OVER (ORDER BY embedding <=> ${vecStr}::vector) AS ann_rank
      FROM northpeak.product_search
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vecStr}::vector
      LIMIT 40
    )
    SELECT
      COALESCE(b.productid, a.productid)     AS product_id,
      COALESCE(b.productname, a.productname) AS product_name,
      COALESCE(b.category, a.category)       AS category,
      COALESCE(b.subcategory, a.subcategory) AS subcategory,
      COALESCE(b.priceusd, a.priceusd)       AS price_usd,
      COALESCE(b.seasonality, a.seasonality) AS seasonality,
      LEFT(COALESCE(b.description, a.description), 160) AS description,
      b.bm25_rank,
      a.ann_rank,
      ROUND(a.cosine_sim::numeric, 4)        AS cosine_sim,
      ROUND((COALESCE(1.0/(${RRF_K} + b.bm25_rank), 0)
           + COALESCE(1.0/(${RRF_K} + a.ann_rank), 0))::numeric, 6) AS rrf_score
    FROM bm25 b
    FULL OUTER JOIN ann a ON a.productid = b.productid
    ORDER BY rrf_score DESC
    LIMIT ${limit}
  `);
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    product_id: String(r.product_id),
    product_name: (r.product_name as string) ?? null,
    category: (r.category as string) ?? null,
    subcategory: (r.subcategory as string) ?? null,
    price_usd: num(r.price_usd),
    seasonality: (r.seasonality as string) ?? null,
    description: (r.description as string) ?? null,
    bm25_rank: num(r.bm25_rank),
    ann_rank: num(r.ann_rank),
    cosine_sim: num(r.cosine_sim),
    rrf_score: num(r.rrf_score),
  }));
}

/** OpenAI Agents SDK tool wrapper. */
export function searchProductsTool(ctx: {
  db: AppDb;
  req: Request;
  databricksHost: string;
}) {
  return tool({
    name: 'search_products',
    description:
      'Lakebase Search: find comparable in-stock products for a SUBSTITUTE recovery move. Hybrid (BM25 full-text + pgvector semantic) retrieval over the Build-1 Lakebase Search index northpeak.product_search — NOT a separate vector store. Pass a natural-language description of the needed item (e.g. "insulated warm mid-layer jacket for a cold snap") and get ranked candidate SKUs (product_id, name, category, price, seasonality) to offer in the draft. Read-only.',
    parameters: z.object({
      query: z
        .string()
        .describe(
          'Natural-language description of the substitute item needed (material / warmth / category), e.g. "insulated warm parka alternative".',
        ),
      limit: z
        .number()
        .int()
        .nullable()
        .describe('Max candidates to return (default 8).'),
    }),
    execute: async ({ query, limit }) =>
      mlflow.withSpan(
        async () => {
          const results = await searchProducts(
            ctx.db,
            ctx.req,
            ctx.databricksHost,
            query,
            limit ?? 8,
          );
          return { query, count: results.length, results };
        },
        {
          name: 'search_products',
          spanType: mlflow.SpanType.TOOL,
          inputs: { query, limit },
        },
      ),
  });
}
