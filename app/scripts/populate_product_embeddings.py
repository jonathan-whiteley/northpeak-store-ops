#!/usr/bin/env python3
"""
Populate northpeak.product_search.embedding via databricks-gte-large-en FMAPI.

Usage:
  python3 app/scripts/populate_product_embeddings.py --profile wishcraft

Requires:
  - psycopg2-binary  (pip install psycopg2-binary)
  - requests         (pip install requests)
  - databricks-sdk   (pip install databricks-sdk)

The script is idempotent: rows with a non-null embedding are skipped.
"""
import argparse
import json
import os
import subprocess
import sys
import time

try:
    import psycopg2
except ImportError:
    sys.exit("Missing psycopg2. Run: pip install psycopg2-binary")

try:
    import requests
except ImportError:
    sys.exit("Missing requests. Run: pip install requests")


ENDPOINT_NAME = "databricks-gte-large-en"
EMBEDDING_DIMS = 1024
BATCH_SIZE = 32
PROJECT = "northpeak-store-ops"
BRANCH = "production"
ENDPOINT_PATH = f"projects/{PROJECT}/branches/{BRANCH}/endpoints/primary"


def get_databricks_config(profile: str) -> tuple[str, str]:
    """Return (host, bearer_token) for the given profile.

    `databricks auth env` emits JSON (not shell KEY=VALUE) and, for OAuth
    ("databricks-cli") profiles, carries no DATABRICKS_TOKEN — so read the host
    from that JSON and mint a fresh bearer token via `databricks auth token`.
    """
    env_json = subprocess.run(
        ["databricks", "auth", "env", "--profile", profile],
        capture_output=True, text=True, check=True
    ).stdout
    host = json.loads(env_json)["env"]["DATABRICKS_HOST"].rstrip("/")

    tok_json = subprocess.run(
        ["databricks", "auth", "token", "--profile", profile],
        capture_output=True, text=True, check=True
    ).stdout
    token = json.loads(tok_json)["access_token"]

    if not host or not token:
        raise ValueError(f"Could not read host/token from profile '{profile}'")
    return host, token


def get_lakebase_creds(profile: str) -> tuple[str, str, str]:
    """Return (pg_host, pg_token, pg_user) for Lakebase prod endpoint."""
    ep_json = subprocess.run(
        ["databricks", "postgres", "get-endpoint", ENDPOINT_PATH,
         "--profile", profile, "-o", "json"],
        capture_output=True, text=True, check=True
    ).stdout
    pg_host = json.loads(ep_json)["status"]["hosts"]["host"]

    cred_json = subprocess.run(
        ["databricks", "postgres", "generate-database-credential",
         ENDPOINT_PATH, "--profile", profile, "-o", "json"],
        capture_output=True, text=True, check=True
    ).stdout
    pg_token = json.loads(cred_json)["token"]

    me_json = subprocess.run(
        ["databricks", "current-user", "me", "--profile", profile, "-o", "json"],
        capture_output=True, text=True, check=True
    ).stdout
    pg_user = json.loads(me_json)["userName"]

    return pg_host, pg_token, pg_user


def embed_texts(texts: list[str], host: str, token: str) -> list[list[float]]:
    """Call the embedding endpoint and return a list of 1024-dim vectors."""
    url = f"{host}/serving-endpoints/{ENDPOINT_NAME}/invocations"
    resp = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
        json={"input": texts},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    # OpenAI-compatible response format: {"data": [{"embedding": [...], "index": N}]}
    items = sorted(data["data"], key=lambda x: x["index"])
    return [item["embedding"] for item in items]


def main():
    parser = argparse.ArgumentParser(description="Populate product_search embeddings")
    parser.add_argument("--profile", default="wishcraft")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    args = parser.parse_args()

    print(f"[embed] loading Databricks config from profile '{args.profile}'...")
    db_host, db_token = get_databricks_config(args.profile)
    pg_host, pg_token, pg_user = get_lakebase_creds(args.profile)

    conn = psycopg2.connect(
        host=pg_host, user=pg_user, password=pg_token,
        dbname="northpeak", sslmode="require"
    )
    conn.autocommit = False

    with conn.cursor() as cur:
        cur.execute("""
            SELECT productid, productname, description
            FROM northpeak.product_search
            WHERE embedding IS NULL
            ORDER BY productid
        """)
        rows = cur.fetchall()

    print(f"[embed] {len(rows)} rows need embeddings")

    for i in range(0, len(rows), args.batch_size):
        batch = rows[i:i + args.batch_size]
        texts = [
            f"{r[1] or ''} {r[2] or ''}".strip()
            for r in batch
        ]
        print(f"[embed] batch {i // args.batch_size + 1}: rows {i+1}–{i+len(batch)}")

        vectors = embed_texts(texts, db_host, db_token)

        with conn.cursor() as cur:
            for (pid, _, _), vec in zip(batch, vectors):
                vec_str = "[" + ",".join(str(v) for v in vec) + "]"
                cur.execute(
                    "UPDATE northpeak.product_search SET embedding = %s::vector WHERE productid = %s",
                    (vec_str, pid)
                )
        conn.commit()
        time.sleep(0.1)  # light rate-limiting

    conn.close()
    print("[embed] done.")


if __name__ == "__main__":
    main()
