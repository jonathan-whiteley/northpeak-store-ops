"""
Build artifact: team_wishcraft_catalog.northpeak.raw_products
=============================================================
Creates (or replaces) the governed product catalog Delta table that is
forward-synced into Lakebase and hybrid-indexed for Lakebase Search.

Role in the system
------------------
  Delta (this table) → Lakebase synced mirror (app.products) → hybrid search
  The `description` column is what makes substitute matching meaningful: a
  query like "insulated warm jacket for a cold snap" must rank the Ridgeline
  Insulated Jacket and Timberline Fleece Hoodie as credible substitutes for
  the hero stockout (Summit Down Parka / SKU-APP-04412).

Design
------
  * Product IDs, names, category, subcategory, seasonality, and price are
    pulled DIRECTLY from gold_store_sku_position — never fabricated.
  * The affected SKUs (cold-snap story: stockout/at_risk/overstock) get rich,
    differentiated descriptions naming material, insulation, and use-case.
  * All other products get a short, search-useful one-liner generated from
    seasonality + subcategory + base product type.
  * launchDate is synthetic-deterministic (pmod(hash(productId), 1461) days
    before 2026-08-01) so re-runs produce the same dates.
  * isActive = TRUE for all rows (all 405 products in the position table are
    actively stocked).

Idempotency
-----------
  Uses CREATE OR REPLACE TABLE — fully safe to re-run.

Usage (local, Databricks Connect)
----------------------------------
  python3 data_generation/build_raw_products.py \\
    --catalog team_wishcraft_catalog \\
    --schema  northpeak \\
    [--profile wishcraft]          # defaults to DATABRICKS_CONFIG_PROFILE or DEFAULT

Usage (as a Databricks job / notebook)
---------------------------------------
  Add widgets: catalog, schema. Script auto-detects dbutils.
"""

from __future__ import annotations

import os

# ── Config ──────────────────────────────────────────────────────────────────
IN_NOTEBOOK = "dbutils" in dir()
if IN_NOTEBOOK:
    dbutils.widgets.text("catalog", "", "Catalog")          # noqa: F821
    dbutils.widgets.text("schema",  "", "Schema")           # noqa: F821
    CATALOG = dbutils.widgets.get("catalog")                # noqa: F821
    SCHEMA  = dbutils.widgets.get("schema")                 # noqa: F821
else:
    import argparse
    _p = argparse.ArgumentParser(description="Build raw_products Delta table.")
    _p.add_argument("--catalog", default=os.environ.get("DEMO_CATALOG"))
    _p.add_argument("--schema",  default=os.environ.get("DEMO_SCHEMA"))
    _p.add_argument("--profile", default=os.environ.get("DATABRICKS_CONFIG_PROFILE", "DEFAULT"))
    _a, _ = _p.parse_known_args()
    CATALOG, SCHEMA = _a.catalog, _a.schema
    if _a.profile and not IN_NOTEBOOK:
        os.environ["DATABRICKS_CONFIG_PROFILE"] = _a.profile

assert CATALOG and SCHEMA, (
    "catalog + schema required (widgets in-job, or --catalog/--schema, "
    "or DEMO_CATALOG/DEMO_SCHEMA env vars)"
)

# ── Spark session ────────────────────────────────────────────────────────────
try:
    spark  # noqa: F821  (already provided in notebook/job context)
except NameError:
    from databricks.connect import DatabricksSession
    spark = (
        DatabricksSession.builder
        .profile(os.environ.get("DATABRICKS_CONFIG_PROFILE", "DEFAULT"))
        .serverless(True)
        .getOrCreate()
    )

# ── SQL ──────────────────────────────────────────────────────────────────────
# Affected-SKU descriptions are verbatim from the data-generation AFFECTED list
# (data_generation/generate_data.py) and deliberately made distinct so hybrid
# search can rank them as substitutes for each other:
#   SKU-APP-04412  Summit Down Parka       — hero stockout, Denver / STORE-0214
#   SKU-APP-04418  Ridgeline Insulated Jacket — substitute candidate (outerwear)
#   SKU-APP-04431  Timberline Fleece Hoodie   — substitute candidate (mid-layer)
#   SKU-APP-04455  Alpine Wool Beanie         — accessory, cold-snap affected
#   SKU-APP-04460  Frostguard Thermal Gloves  — accessory, cold-snap affected

BUILD_SQL = f"""
CREATE OR REPLACE TABLE {CATALOG}.{SCHEMA}.raw_products
COMMENT 'Governed product catalog for NorthPeak Store Ops. Read-only from the app
 (synced into Lakebase app.products). The description column drives hybrid text/vector
 search for substitute-product matching. Affected cold-snap SKUs carry rich, differentiated
 warm-layer descriptions so a query like "insulated warm jacket for a cold snap" returns
 credible substitute candidates. Source: distinct product set from gold_store_sku_position.'
AS
WITH source AS (
  -- Pull exactly the distinct product set that exists in the position data.
  -- Do NOT fabricate product IDs or names — they must match downstream joins.
  SELECT DISTINCT
    product_id   AS productId,
    product_name AS productName,
    category,
    subcategory,
    price_usd    AS priceUsd,
    seasonality
  FROM {CATALOG}.{SCHEMA}.gold_store_sku_position
),
with_meta AS (
  SELECT
    productId,
    productName,
    category,
    subcategory,
    priceUsd,
    seasonality,
    -- launchDate: synthetic-deterministic (same result on every re-run).
    -- pmod returns non-negative remainder; scatters dates across 0-4 years
    -- before the demo story's "now" (2026-08-01).
    date_add(DATE '2022-08-01', CAST(pmod(hash(productId), 1461) AS INT)) AS launchDate,
    TRUE AS isActive
  FROM source
),
with_description AS (
  SELECT
    productId,
    productName,
    category,
    subcategory,
    priceUsd,
    seasonality,
    launchDate,
    isActive,
    CASE productId
      -- ── Affected SKUs: rich, differentiated warm-layer descriptions ──────
      -- Hero stockout: Denver / STORE-0214 is out; Colorado Springs has surplus.
      WHEN 'SKU-APP-04412' THEN
        'Heavyweight insulated winter parka, 600-fill down, waterproof shell, storm hood — warmest cold-weather outerwear for extreme cold snaps.'
      -- Substitute candidate 1: similar outerwear, synthetic fill (available when down is stocked out)
      WHEN 'SKU-APP-04418' THEN
        'Insulated winter jacket, synthetic fill, water-resistant shell — a warm midweight outerwear alternative to a down parka for cold-snap conditions.'
      -- Substitute candidate 2: fleece mid-layer, pairs under shell or standalone
      WHEN 'SKU-APP-04431' THEN
        'Heavy fleece hooded pullover, warm mid-layer for cold weather — pairs under an outer shell or wears standalone in cool conditions.'
      -- Cold-snap accessory: wool beanie
      WHEN 'SKU-APP-04455' THEN
        'Warm ribbed wool beanie, cold-weather head layer — essential winter accessory for cold-snap demand.'
      -- Cold-snap accessory: thermal gloves
      WHEN 'SKU-APP-04460' THEN
        'Insulated thermal winter gloves, touchscreen fingertips, water-resistant — cold-weather hand protection for outdoor use.'
      -- ── All other products: short, search-useful one-liner ───────────────
      ELSE
        CONCAT(
          CASE seasonality
            WHEN 'cold_weather' THEN 'Cold-weather '
            WHEN 'warm_weather' THEN 'Warm-weather '
            ELSE                     'All-season '
          END,
          LOWER(subcategory), ' ',
          LOWER(
            CASE
              WHEN productName LIKE 'Boot %'        THEN 'boot'
              WHEN productName LIKE 'Tee %'         THEN 'tee'
              WHEN productName LIKE 'Chino %'       THEN 'chino'
              WHEN productName LIKE 'Denim %'       THEN 'denim'
              WHEN productName LIKE 'Sweater %'     THEN 'sweater'
              WHEN productName LIKE 'Shorts %'      THEN 'shorts'
              WHEN productName LIKE 'Dress %'       THEN 'dress'
              WHEN productName LIKE 'Sneaker %'     THEN 'sneaker'
              WHEN productName LIKE 'Jacket %'      THEN 'jacket'
              WHEN productName LIKE 'Polo %'        THEN 'polo'
              WHEN productName LIKE 'Duvet %'       THEN 'duvet'
              WHEN productName LIKE 'Cookware %'    THEN 'cookware set'
              WHEN productName LIKE 'Lamp %'        THEN 'lamp'
              WHEN productName LIKE 'Rug %'         THEN 'rug'
              WHEN productName LIKE 'Towel %'       THEN 'towel set'
              WHEN productName LIKE 'Curtain %'     THEN 'curtain'
              WHEN productName LIKE 'Pillow %'      THEN 'pillow'
              WHEN productName LIKE 'Blender %'     THEN 'blender'
              WHEN productName LIKE 'Frame %'       THEN 'frame'
              WHEN productName LIKE 'Vase %'        THEN 'vase'
              WHEN productName LIKE 'Notebook %'    THEN 'notebook'
              WHEN productName LIKE 'Backpack %'    THEN 'backpack'
              WHEN productName LIKE 'Water Bottle %' THEN 'water bottle'
              WHEN productName LIKE 'Charger %'     THEN 'charger'
              WHEN productName LIKE 'Headphones %'  THEN 'headphones'
              WHEN productName LIKE 'Toy %'         THEN 'toy'
              WHEN productName LIKE 'Game %'        THEN 'game'
              WHEN productName LIKE 'Umbrella %'    THEN 'umbrella'
              WHEN productName LIKE 'Mug %'         THEN 'mug'
              WHEN productName LIKE 'Speaker %'     THEN 'speaker'
              ELSE LOWER(SPLIT(productName, ' ')[0])
            END
          ),
          ' in ', LOWER(category), '.'
        )
    END AS description
  FROM with_meta
)
SELECT
  productId,
  productName,
  category,
  subcategory,
  priceUsd,
  seasonality,
  description,
  launchDate,
  isActive
FROM with_description
"""

# ── Execute ──────────────────────────────────────────────────────────────────
print(f"Building {CATALOG}.{SCHEMA}.raw_products ...")
spark.sql(BUILD_SQL)

# ── Verify ───────────────────────────────────────────────────────────────────
count_df  = spark.sql(f"SELECT COUNT(*) AS row_count FROM {CATALOG}.{SCHEMA}.raw_products")
null_df   = spark.sql(f"SELECT COUNT(*) AS null_desc FROM {CATALOG}.{SCHEMA}.raw_products WHERE description IS NULL")
sample_df = spark.sql(f"""
  SELECT productId, productName, SUBSTRING(description, 1, 120) AS description_preview
  FROM {CATALOG}.{SCHEMA}.raw_products
  WHERE productId IN (
    'SKU-APP-04412','SKU-APP-04418','SKU-APP-04431',
    'SKU-APP-04455','SKU-APP-04460'
  )
  ORDER BY productId
""")

row_count  = count_df.collect()[0]["row_count"]
null_count = null_df.collect()[0]["null_desc"]
rows       = sample_df.collect()

print(f"\n✅ {CATALOG}.{SCHEMA}.raw_products created.")
print(f"   row_count  = {row_count}")
print(f"   null_desc  = {null_count}  (should be 0)")
print("\nAffected SKU sample descriptions:")
for r in rows:
    print(f"  {r['productId']:18s}  {r['productName']:30s}  {r['description_preview']}")

if null_count > 0:
    print(f"\n⚠️  WARNING: {null_count} rows have NULL description — investigate CASE logic.")

if IN_NOTEBOOK:
    import json
    dbutils.notebook.exit(json.dumps({                      # noqa: F821
        "table":      f"{CATALOG}.{SCHEMA}.raw_products",
        "row_count":  row_count,
        "null_desc":  null_count,
    }))
