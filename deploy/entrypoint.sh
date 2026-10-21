#!/bin/sh
# Required: MUMBO_PUBLIC_HOST (e.g. app.mumbo.si or dev.app.mumbo.si), DEEPSEEK_API_KEY.
set -eu
: "${MUMBO_PUBLIC_HOST:?}"
cd /src
exec node --import tsx/esm apps/cli/src/bin.ts --profile web --patch /src/deploy/mumbo.overlay.yml --no-open \
  --host "$(hostname -i | awk '{print $1}')" --port 3080 \
  --public-url "https://${MUMBO_PUBLIC_HOST}/" --trusted-host "${MUMBO_PUBLIC_HOST}" \
  ${MUMBO_EXTRA_TRUSTED_HOST:+--trusted-host "$MUMBO_EXTRA_TRUSTED_HOST"}
