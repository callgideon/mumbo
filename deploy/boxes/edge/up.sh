#!/bin/sh
# Install or update the edge on the E2B host (run as root, from this directory). Reads every secret from SSM
# through the instance role, writes .env (0600), then (re)starts the stack. Who may use a box is ALLOWED_EMAILS.
set -eu
cd "$(dirname "$0")"
p() { docker run --rm --network host amazon/aws-cli:2.27.50 ssm get-parameter --region us-east-1 --with-decryption --name "$1" --query Parameter.Value --output text; }
umask 077
cat > .env <<ENV
PUBLIC_HOST=$(p /mumbo/boxes/public-host)
LLM_HOST=$(p /mumbo/boxes/llm-host)
ACME_EMAIL=$(p /mumbo/boxes/acme-email)
ALLOWED_EMAILS=$(p /mumbo/boxes/allowed-emails)
BOX_EGRESS_IPS=$(p /mumbo/boxes/egress-ips)
BACKUP_BUCKET=$(p /mumbo/boxes/backup-bucket)
E2B_API_URL=http://127.0.0.1:3000
E2B_SANDBOX_URL=http://127.0.0.1:3002
E2B_API_KEY=$(p /mumbo/boxes/e2b-api-key)
OAUTH_ISSUER_URL=https://qkvcouccrhyjiarkauyo.supabase.co/auth/v1
OAUTH2_PROXY_CLIENT_ID=$(p /mumbo/boxes/oauth-client-id)
OAUTH2_PROXY_CLIENT_SECRET=$(p /mumbo/boxes/oauth-client-secret)
OAUTH2_PROXY_COOKIE_SECRET=$(p /mumbo/boxes/cookie-secret)
ENV
docker compose up -d --build --remove-orphans
docker compose ps
