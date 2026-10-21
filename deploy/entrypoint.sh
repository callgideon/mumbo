#!/bin/sh
# Required: MUMBO_PUBLIC_HOST (e.g. app.mumbo.si), DEEPSEEK_API_KEY.
# MUMBO_AUTH=off serves dsh directly (launch-token URL in the log); otherwise an OIDC gate sits in front:
#   SUPABASE_URL, SUPABASE_ANON_KEY (login page), OAUTH_ISSUER_URL (<SUPABASE_URL>/auth/v1), OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_COOKIE_SECRET (16/24/32 chars).
set -eu
: "${MUMBO_PUBLIC_HOST:?}"
cd /src
DSH="node --import tsx/esm apps/cli/src/bin.ts --profile web --patch /src/deploy/mumbo.overlay.yml --no-open
  --public-url https://${MUMBO_PUBLIC_HOST}/ --trusted-host ${MUMBO_PUBLIC_HOST} ${MUMBO_EXTRA_TRUSTED_HOST:+--trusted-host $MUMBO_EXTRA_TRUSTED_HOST}"

if [ "${MUMBO_AUTH:-oidc}" = off ]; then
  exec $DSH --host "$(hostname -i | awk '{print $1}')" --port 3080
fi

: "${SUPABASE_URL:?}" "${SUPABASE_ANON_KEY:?}" "${OAUTH_ISSUER_URL:?}" "${OAUTH_CLIENT_ID:?}" "${OAUTH_CLIENT_SECRET:?}" "${OAUTH_COOKIE_SECRET:?}"
# Supabase sign-up may be open, so the gate admits only listed identities: default deny.
[ -n "${OAUTH_ALLOWED_EMAILS:-}${OAUTH_ALLOWED_DOMAINS:-}" ] || { echo "set OAUTH_ALLOWED_EMAILS and/or OAUTH_ALLOWED_DOMAINS (comma-separated)" >&2; exit 1; }
ALLOW=
if [ -n "${OAUTH_ALLOWED_EMAILS:-}" ]; then
  echo "$OAUTH_ALLOWED_EMAILS" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep . > /tmp/allowed-emails.txt
  ALLOW="--authenticated-emails-file=/tmp/allowed-emails.txt"
fi
for d in $(echo "${OAUTH_ALLOWED_DOMAINS:-}" | tr ',' ' '); do ALLOW="$ALLOW --email-domain=$d"; done
LOG=/tmp/dsh.log
: > "$LOG"
$DSH --host 127.0.0.1 --port 3081 > "$LOG" 2>&1 &
DSH_PID=$!
# The launch token never reaches the container log: it is redacted on the way out.
tail -n +1 -F "$LOG" | sed -u -E 's/token=[A-Za-z0-9_-]+/token=REDACTED/' &

TOKEN=
for _ in $(seq 1 120); do
  TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" | head -1 | cut -d= -f2 || true)
  [ -n "$TOKEN" ] && break
  kill -0 "$DSH_PID" 2>/dev/null || { echo "dsh exited during startup" >&2; exit 1; }
  sleep 1
done
[ -n "$TOKEN" ] || { echo "dsh printed no launch token" >&2; exit 1; }
mkdir -p /tmp/auth-ui && cp /usr/share/mumbo-auth/index.html /usr/share/mumbo-auth/supabase.js /tmp/auth-ui/
printf 'const MUMBO = { url: "%s", anonKey: "%s" }\n' "$SUPABASE_URL" "$SUPABASE_ANON_KEY" > /tmp/auth-ui/config.js
sed -e "s|@TOKEN@|$TOKEN|" -e "s|@HOST@|$MUMBO_PUBLIC_HOST|" /etc/nginx/mumbo.conf.tmpl > /tmp/nginx.conf

OAUTH2_PROXY_CLIENT_SECRET=$OAUTH_CLIENT_SECRET OAUTH2_PROXY_COOKIE_SECRET=$OAUTH_COOKIE_SECRET oauth2-proxy \
  --provider=oidc --oidc-issuer-url="$OAUTH_ISSUER_URL" --client-id="$OAUTH_CLIENT_ID" \
  --redirect-url="https://${MUMBO_PUBLIC_HOST}/oauth2/callback" $ALLOW --scope='openid email' \
  --code-challenge-method=S256 --cookie-secure=true --cookie-samesite=lax --reverse-proxy=true \
  --upstream=static://202 --http-address=127.0.0.1:4180 --skip-provider-button=true ${OAUTH_ALLOW_UNVERIFIED_EMAIL:+--insecure-oidc-allow-unverified-email=true} &
O2P_PID=$!

nginx -c /tmp/nginx.conf &
NGINX_PID=$!
# Any of the three exiting takes the task down so ECS replaces it.
while kill -0 "$DSH_PID" 2>/dev/null && kill -0 "$O2P_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do sleep 5; done
echo "a process exited; stopping" >&2
exit 1
