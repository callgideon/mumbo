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
ENV DSH_HOME=/data DSH_TELEMETRY_DISABLED=1
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
