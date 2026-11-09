#!/bin/sh
# Env: POSTGRES_CONNECTION_STRING, TEAM_API_KEY, BOX_RAM_MB, BOX_FREE_DISK_MB, BOX_DISK_MB.
set -eu
# E2B's migrations grant to the stock superuser name; RDS's master user is e2b.
psql "$POSTGRES_CONNECTION_STRING" -v ON_ERROR_STOP=1 -qc "DO \$\$BEGIN CREATE ROLE postgres NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END\$\$"
cd / && migrator
SEED_TEAM_API_KEY="$TEAM_API_KEY" OIDC_ISSUER=https://mumbo.si/ OIDC_SUBJECT=mumbo-edge seed
# Limits sized for the edge, which is the only E2B client: long-lived boxes, many of them, 4 GiB each. Assigned, not
# raised: the values in prod/control.tf are the ones in force, lower ones too. disk_mb reaches a box only through a
# template built afterwards. The last query prints the limits each team resolves to (run.sh shows the log).
limits="max_length_hours = 8760, concurrent_sandboxes = 2000, concurrent_template_builds = 4, max_vcpu = 8, max_ram_mb = ${BOX_RAM_MB},
  disk_mb = ${BOX_DISK_MB}, default_free_disk_size_mb = ${BOX_FREE_DISK_MB}, max_disk_size_mb = ${BOX_FREE_DISK_MB} + 25000"
psql "$POSTGRES_CONNECTION_STRING" -v ON_ERROR_STOP=1 -q <<SQL
UPDATE public.default_limits SET ${limits};
UPDATE public.project_limits SET ${limits};
SQL
psql "$POSTGRES_CONNECTION_STRING" -v ON_ERROR_STOP=1 -Atc "SELECT 'setup: team', id, 'disk_mb', disk_mb, 'default_free_disk_size_mb', default_free_disk_size_mb, 'max_ram_mb', max_ram_mb FROM public.team_limits"
echo "setup: done"
