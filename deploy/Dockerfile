# Mumbo web image: one Node process serves the GUI and the API (docs/user/guide/public-deployments.md).
FROM node:24-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}" CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsx scripts/mumbo-rebrand.ts && pnpm exec tsx scripts/mumbo-egress-check.ts
ARG GIT_COMMIT
RUN DSH_CLIENT_COMMIT_HASH="$GIT_COMMIT" pnpm run build:official

FROM build AS runtime
# Login gate: nginx + oauth2-proxy (OIDC). Not needed when MUMBO_AUTH=off.
RUN apt-get update && apt-get install -y --no-install-recommends nginx && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/o2p.tgz https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v7.9.0/oauth2-proxy-v7.9.0.linux-amd64.tar.gz \
 && echo "d8eb7c032381256e30e89c0eb724b1166a82d84e055bd31ff03a945fba989ecb  /tmp/o2p.tgz" | sha256sum -c - \
 && tar -xzf /tmp/o2p.tgz --strip-components=1 -C /usr/local/bin oauth2-proxy-v7.9.0.linux-amd64/oauth2-proxy && rm /tmp/o2p.tgz
RUN cd /tmp && npm pack @supabase/supabase-js@2.118.0 --silent && tar xzf supabase-supabase-js-2.118.0.tgz package/dist/umd/supabase.js \
 && echo "ee3be8de192b97cb1d73d1e95d6b82bb1f6b658c0f97c4ef757fc331996ed3d3  package/dist/umd/supabase.js" | sha256sum -c - \
 && install -D package/dist/umd/supabase.js /usr/share/mumbo-auth/supabase.js && rm -rf /tmp/package /tmp/*.tgz
COPY deploy/auth-ui/index.html /usr/share/mumbo-auth/index.html
COPY deploy/nginx.conf.tmpl /etc/nginx/mumbo.conf.tmpl
ENV DSH_HOME=/data DSH_TELEMETRY_DISABLED=1
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
