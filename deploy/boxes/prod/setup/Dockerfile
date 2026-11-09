# One-shot E2B setup task: schema migrations, our team and API key, team limits. Build context: the E2B fork's
# packages/ directory (setup/build.sh). Idempotent; run after every api upgrade, before the new api starts.
FROM golang:1.26.10-alpine3.24 AS builder
WORKDIR /src
COPY shared ./shared
COPY db ./db
COPY local-dev ./local-dev
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod \
    cd db && CGO_ENABLED=0 go build -o /out/migrator ./scripts/migrator.go && \
    cd ../local-dev && CGO_ENABLED=0 go build -o /out/seed ./seed-local-database.go
FROM alpine:3.24
RUN apk add --no-cache postgresql18-client
COPY --from=builder /out/ /usr/local/bin/
COPY db/migrations /migrations
COPY setup.sh /usr/local/bin/setup.sh
ENTRYPOINT ["/usr/local/bin/setup.sh"]
