-- products_search.sql
-- Lakebase Search (Beta) — hybrid vector + full-text index over app_products.
--
-- Prerequisites (run once per Lakebase database):
--   1. Lakebase Search must be enabled on the project in workspace settings.
--   2. Extensions must be created in order: vector FIRST (pgvector, required by
--      lakebase_vector), then lakebase_vector, then lakebase_text independently.
--
-- Run against: project=northpeak-store-ops, branch=production, db=northpeak
--   databricks postgres generate-database-credential \
--     projects/northpeak-store-ops/branches/production/endpoints/primary \
--     --profile wishcraft -o json
--   PGPASSWORD=<token> psql "host=<host> user=<user> dbname=northpeak sslmode=require" \
--     -f app/scripts/sql/products_search.sql
--
-- Embedding endpoint: databricks-gte-large-en (1024 dims, READY)
-- Embeddings are pre-computed via app/scripts/populate_product_embeddings.py
-- and stored in northpeak.product_search.embedding.

-- ── 1. Extensions (order matters) ─────────────────────────────────────────

-- pgvector: prerequisite for lakebase_vector (provides VECTOR type + operators)
CREATE EXTENSION IF NOT EXISTS vector;

-- lakebase_vector: lakebase_ann index type (ANN, companion to pgvector)
-- CASCADE automatically brings in vector if not yet present
CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;

-- lakebase_text: lakebase_bm25 index type (BM25 full-text)
CREATE EXTENSION IF NOT EXISTS lakebase_text;

-- ── 2. Companion search table ─────────────────────────────────────────────
-- Cannot add columns to the synced app_products table (read-only; only
-- SELECT, CREATE INDEX, DROP TABLE allowed on synced tables).
-- product_search is a writable mirror that adds the embedding + tsvector
-- columns needed for hybrid indexing, populated from app_products.

CREATE TABLE IF NOT EXISTS northpeak.product_search (
    productid   TEXT PRIMARY KEY,         -- mirrors app_products."productId"
    productname TEXT NOT NULL,            -- mirrors app_products."productName"
    category    TEXT,
    subcategory TEXT,
    priceusd    DOUBLE PRECISION,
    seasonality TEXT,
    description TEXT,
    launchdate  DATE,
    isactive    BOOLEAN,
    -- Vector column: 1024 dims, matching databricks-gte-large-en output
    embedding   VECTOR(1024),
    -- tsvector: generated column combining productname + description for BM25
    search_tsv  TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english',
            coalesce(productname, '') || ' ' || coalesce(description, ''))
    ) STORED
);

-- ── 3. Populate from synced table ─────────────────────────────────────────
-- Idempotent: ON CONFLICT DO NOTHING skips already-loaded rows.
INSERT INTO northpeak.product_search
    (productid, productname, category, subcategory, priceusd,
     seasonality, description, launchdate, isactive)
SELECT
    "productId", "productName", category, subcategory, "priceUsd",
    seasonality, description, "launchDate", "isActive"
FROM northpeak.app_products
ON CONFLICT (productid) DO NOTHING;

-- ── 4. Indexes ─────────────────────────────────────────────────────────────

-- BM25 full-text index (lakebase_text): over the generated tsvector column
-- covering productname + description.
CREATE INDEX IF NOT EXISTS idx_product_search_bm25
    ON northpeak.product_search USING lakebase_bm25 (search_tsv);

-- ANN vector index (lakebase_vector): cosine similarity over embedding column.
-- Populated AFTER embeddings are inserted (see populate_product_embeddings.py).
-- Re-run: CREATE INDEX IF NOT EXISTS is idempotent.
CREATE INDEX IF NOT EXISTS idx_product_search_ann
    ON northpeak.product_search USING lakebase_ann (embedding vector_cosine_ops);

-- ── 5. App SP grants ────────────────────────────────────────────────────────
-- Grant the app service-principal USAGE on northpeak schema + SELECT on
-- the new search table. Run after lakebase_grant_app_credential.sh to ensure
-- the SP role exists; replace <SP_CLIENT_ID> with the app SP UUID.
--
-- GRANT USAGE ON SCHEMA northpeak TO "<SP_CLIENT_ID>";
-- GRANT SELECT ON northpeak.product_search TO "<SP_CLIENT_ID>";
-- GRANT SELECT ON northpeak.app_products TO "<SP_CLIENT_ID>";
-- ALTER DEFAULT PRIVILEGES IN SCHEMA northpeak GRANT SELECT ON TABLES TO "<SP_CLIENT_ID>";

-- ── 6. Hybrid search template (RRF) ───────────────────────────────────────
-- Replace :query_text and :query_embedding at call time.
-- :query_embedding must be a 1024-dim float array from databricks-gte-large-en.
--
-- WITH
--   bm25_cands AS (
--     SELECT productid, productname, category, subcategory, description,
--            priceusd, seasonality, isactive,
--            search_tsv <@> to_bm25query(to_tsvector('english', :query_text),
--                                        'idx_product_search_bm25') AS bm25_score
--     FROM northpeak.product_search
--     WHERE search_tsv @@ plainto_tsquery('english', :query_text)
--     ORDER BY bm25_score DESC
--     LIMIT 40
--   ),
--   ann_cands AS (
--     SELECT productid, productname, category, subcategory, description,
--            priceusd, seasonality, isactive,
--            1 - (embedding <=> :query_embedding::vector) AS cosine_sim
--     FROM northpeak.product_search
--     WHERE embedding IS NOT NULL
--     ORDER BY embedding <=> :query_embedding::vector
--     LIMIT 40
--   ),
--   bm25_ranked AS (
--     SELECT *, RANK() OVER (ORDER BY bm25_score DESC) AS bm25_rank FROM bm25_cands
--   ),
--   ann_ranked AS (
--     SELECT *, RANK() OVER (ORDER BY cosine_sim DESC) AS ann_rank FROM ann_cands
--   )
-- SELECT
--   coalesce(b.productid,   a.productid)   AS productid,
--   coalesce(b.productname, a.productname) AS productname,
--   coalesce(b.category,    a.category)    AS category,
--   coalesce(b.subcategory, a.subcategory) AS subcategory,
--   coalesce(b.description, a.description) AS description,
--   coalesce(b.priceusd,    a.priceusd)    AS priceusd,
--   coalesce(b.seasonality, a.seasonality) AS seasonality,
--   coalesce(1.0/(60 + b.bm25_rank), 0) + coalesce(1.0/(60 + a.ann_rank), 0) AS rrf_score,
--   b.bm25_score,
--   a.cosine_sim
-- FROM bm25_ranked b
-- FULL OUTER JOIN ann_ranked a ON b.productid = a.productid
-- ORDER BY rrf_score DESC
-- LIMIT 10;
