#!/bin/sh
# Env: POSTGRES_CONNECTION_STRING, TEAM_API_KEY, BOX_RAM_MB, BOX_FREE_DISK_MB.
set -eu
# E2B's migrations grant to the stock superuser name; RDS's master user is e2b.
psql "$POSTGRES_CONNECTION_STRING" -v ON_ERROR_STOP=1 -qc "DO \$\$BEGIN CREATE ROLE postgres NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END\$\$"
cd / && migrator
SEED_TEAM_API_KEY="$TEAM_API_KEY" OIDC_ISSUER=https://mumbo.si/ OIDC_SUBJECT=mumbo-edge seed
# Limits sized for the edge, which is the only E2B client: long-lived boxes, many of them, 4 GiB each.
psql "$POSTGRES_CONNECTION_STRING" -v ON_ERROR_STOP=1 -q <<SQL
UPDATE public.default_limits SET max_length_hours = 8760, concurrent_sandboxes = 2000, concurrent_template_builds = 4,
  max_vcpu = 8, max_ram_mb = GREATEST(max_ram_mb, ${BOX_RAM_MB}),
  disk_mb = GREATEST(disk_mb, ${BOX_FREE_DISK_MB}), max_disk_size_mb = GREATEST(max_disk_size_mb, ${BOX_FREE_DISK_MB} + 25000),
  default_free_disk_size_mb = GREATEST(default_free_disk_size_mb, ${BOX_FREE_DISK_MB});
UPDATE public.project_limits SET max_length_hours = 8760, concurrent_sandboxes = 2000, concurrent_template_builds = 4,
  max_vcpu = 8, max_ram_mb = GREATEST(max_ram_mb, ${BOX_RAM_MB}),
  disk_mb = GREATEST(disk_mb, ${BOX_FREE_DISK_MB}), max_disk_size_mb = GREATEST(max_disk_size_mb, ${BOX_FREE_DISK_MB} + 25000),
  default_free_disk_size_mb = GREATEST(default_free_disk_size_mb, ${BOX_FREE_DISK_MB});
SQL
echo "setup: done"
