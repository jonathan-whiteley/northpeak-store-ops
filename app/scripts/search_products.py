#!/usr/bin/env python3
"""
Lakebase Search — hybrid (vector + full-text) product retrieval.

Embeds a natural-language query with databricks-gte-large-en, then runs a
Reciprocal-Rank-Fusion query over northpeak.product_search combining:
  - lakebase_bm25 full-text ranking (BM25 over productname + description), and
  - lakebase_ann vector similarity (cosine over the gte-large-en embedding).

This is the reference implementation for the agent's `search_products` tool
(substitute-matching) and the Build-1 Lakebase Search evidence generator.

Usage:
  python3 app/scripts/search_products.py --profile wishcraft \
      --query "insulated warm jacket for a cold snap" \
      [--limit 10] [--evidence-dir build1_evidence]
"""
import argparse
import json
import subprocess
import sys

import psycopg2

ENDPOINT_NAME = "databricks-gte-large-en"
PROJECT = "northpeak-store-ops"
BRANCH = "production"
ENDPOINT_PATH = f"projects/{PROJECT}/branches/{BRANCH}/endpoints/primary"


def _cli_json(args: list[str]) -> dict:
    out = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def get_host_token(profile: str) -> tuple[str, str]:
    host = _cli_json(["databricks", "auth", "env", "--profile", profile])["env"][
        "DATABRICKS_HOST"
    ].rstrip("/")
    token = _cli_json(["databricks", "auth", "token", "--profile", profile])[
        "access_token"
    ]
    return host, token


def get_lakebase_creds(profile: str) -> tuple[str, str, str]:
    pg_host = _cli_json(
        ["databricks", "postgres", "get-endpoint", ENDPOINT_PATH,
         "--profile", profile, "-o", "json"]
    )["status"]["hosts"]["host"]
    pg_token = _cli_json(
        ["databricks", "postgres", "generate-database-credential", ENDPOINT_PATH,
         "--profile", profile, "-o", "json"]
    )["token"]
    pg_user = _cli_json(
        ["databricks", "current-user", "me", "--profile", profile, "-o", "json"]
    )["userName"]
    return pg_host, pg_token, pg_user


def embed_query(text: str, host: str, token: str) -> list[float]:
    import requests
    resp = requests.post(
        f"{host}/serving-endpoints/{ENDPOINT_NAME}/invocations",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"input": [text]},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


# Hybrid RRF: BM25 candidates (lakebase_bm25 via <@>/to_bm25query) fused with
# ANN candidates (pgvector cosine, accelerated by the lakebase_ann index).
HYBRID_SQL = """
WITH bm25 AS (
  SELECT productid, productname, category, subcategory, description,
         priceusd, seasonality,
         RANK() OVER (
           ORDER BY search_tsv <@> to_bm25query(
             to_tsvector('english', %(q)s), 'northpeak.idx_product_search_bm25') DESC
         ) AS bm25_rank
  FROM northpeak.product_search
  WHERE search_tsv @@ plainto_tsquery('english', %(q)s)
  ORDER BY bm25_rank
  LIMIT 40
),
ann AS (
  SELECT productid, productname, category, subcategory, description,
         priceusd, seasonality,
         1 - (embedding <=> %(vec)s::vector) AS cosine_sim,
         RANK() OVER (ORDER BY embedding <=> %(vec)s::vector) AS ann_rank
  FROM northpeak.product_search
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> %(vec)s::vector
  LIMIT 40
)
SELECT
  COALESCE(b.productid, a.productid)     AS productid,
  COALESCE(b.productname, a.productname) AS productname,
  COALESCE(b.category, a.category)       AS category,
  COALESCE(b.subcategory, a.subcategory) AS subcategory,
  COALESCE(b.priceusd, a.priceusd)       AS priceusd,
  COALESCE(b.seasonality, a.seasonality) AS seasonality,
  LEFT(COALESCE(b.description, a.description), 160) AS description,
  b.bm25_rank,
  a.ann_rank,
  ROUND(a.cosine_sim::numeric, 4)        AS cosine_sim,
  ROUND((COALESCE(1.0/(60 + b.bm25_rank), 0)
       + COALESCE(1.0/(60 + a.ann_rank), 0))::numeric, 6) AS rrf_score
FROM bm25 b
FULL OUTER JOIN ann a ON a.productid = b.productid
ORDER BY rrf_score DESC
LIMIT %(lim)s
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="wishcraft")
    ap.add_argument("--query", required=True)
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--evidence-dir", default=None,
                    help="If set, write search_query.txt + search_result.json here.")
    args = ap.parse_args()

    db_host, db_token = get_host_token(args.profile)
    pg_host, pg_token, pg_user = get_lakebase_creds(args.profile)

    qvec = embed_query(args.query, db_host, db_token)
    vec_str = "[" + ",".join(str(v) for v in qvec) + "]"

    conn = psycopg2.connect(
        host=pg_host, user=pg_user, password=pg_token,
        dbname="northpeak", sslmode="require",
    )
    with conn.cursor() as cur:
        cur.execute(HYBRID_SQL, {"q": args.query, "vec": vec_str, "lim": args.limit})
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    conn.close()

    # Decimals -> float for JSON.
    for r in rows:
        for k, v in r.items():
            if hasattr(v, "as_integer_ratio") or type(v).__name__ == "Decimal":
                r[k] = float(v)

    print(f"query: {args.query}")
    for i, r in enumerate(rows, 1):
        print(f"{i:2}. {r['productid']:16} {r['productname']:32} "
              f"bm25_rank={r['bm25_rank']} ann_rank={r['ann_rank']} "
              f"cos={r['cosine_sim']} rrf={r['rrf_score']}")

    if args.evidence_dir:
        import os
        os.makedirs(args.evidence_dir, exist_ok=True)
        with open(os.path.join(args.evidence_dir, "search_query.txt"), "w") as f:
            f.write(
                "Lakebase Search — hybrid (lakebase_bm25 full-text + lakebase_ann "
                "vector) over northpeak.product_search, fused with Reciprocal Rank "
                "Fusion (k=60).\n\n"
                f"Natural-language query:\n  {args.query}\n\n"
                "Query embedding: databricks-gte-large-en (1024-dim).\n\n"
                "SQL (psycopg2 params %(q)s = query text, %(vec)s = query embedding):\n"
                + HYBRID_SQL.strip() + "\n"
            )
        with open(os.path.join(args.evidence_dir, "search_result.json"), "w") as f:
            json.dump({"query": args.query, "endpoint": ENDPOINT_NAME,
                       "count": len(rows), "results": rows}, f, indent=2)
        print(f"\n[evidence] wrote search_query.txt + search_result.json to {args.evidence_dir}/")


if __name__ == "__main__":
    main()
