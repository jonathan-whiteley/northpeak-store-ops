#!/usr/bin/env bash
# Create (or verify) the UC→Lakebase synced table for the products catalog.
#
# Synced table: team_wishcraft_catalog.northpeak.app_products
# Source:       team_wishcraft_catalog.northpeak.raw_products (405 rows)
# PK:           productId
# Mode:         SNAPSHOT (products catalog is immutable post-deploy)
# Lakebase:     project=northpeak-store-ops, branch=production, db=northpeak
#
# Note: DAB synced_database_tables resource maps to a deprecated Terraform
# resource and fails on current Lakebase. postgres_synced_tables DAB support
# is pending Terraform provider work. This CLI script IS the code artifact.
# Run once; re-running is idempotent (get-synced-table check prevents duplicate).
#
# Usage:
#   ./app/scripts/create_synced_products_table.sh [--profile <profile>]
#   ./app/scripts/create_synced_products_table.sh --profile wishcraft
set -euo pipefail

PROFILE="wishcraft"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

SYNCED_TABLE_ID="team_wishcraft_catalog.northpeak.app_products"

# Idempotency check: skip creation if already ONLINE.
CURRENT_STATE=$(databricks postgres get-synced-table \
  "synced_tables/${SYNCED_TABLE_ID}" --profile "$PROFILE" -o json 2>/dev/null \
  | python3 -c "import json,sys; s=json.load(sys.stdin); print(s.get('status',{}).get('detailed_state','NOT_FOUND'))" \
  2>/dev/null || echo "NOT_FOUND")

if [[ "$CURRENT_STATE" == *"ONLINE"* ]]; then
  echo "[create-synced-products] already ONLINE ($CURRENT_STATE) — nothing to do."
  exit 0
fi

if [[ "$CURRENT_STATE" != "NOT_FOUND" ]]; then
  echo "[create-synced-products] exists in state $CURRENT_STATE — waiting for ONLINE."
  databricks postgres get-synced-table "synced_tables/${SYNCED_TABLE_ID}" \
    --profile "$PROFILE" -o json 2>&1 | python3 -c "
import json,sys
s=json.load(sys.stdin)
print('state:', s.get('status',{}).get('detailed_state'))
print('message:', s.get('status',{}).get('message',''))
"
  exit 0
fi

echo "[create-synced-products] creating synced table ${SYNCED_TABLE_ID}..."
databricks postgres create-synced-table "${SYNCED_TABLE_ID}" \
  --json '{
    "spec": {
      "source_table_full_name": "team_wishcraft_catalog.northpeak.raw_products",
      "primary_key_columns": ["productId"],
      "scheduling_policy": "SNAPSHOT",
      "branch": "projects/northpeak-store-ops/branches/production",
      "postgres_database": "northpeak",
      "create_database_objects_if_missing": true,
      "new_pipeline_spec": {
        "storage_catalog": "team_wishcraft_catalog",
        "storage_schema": "northpeak"
      }
    }
  }' --profile "$PROFILE"

echo "[create-synced-products] done. Verify with:"
echo "  databricks postgres get-synced-table synced_tables/${SYNCED_TABLE_ID} --profile ${PROFILE}"
