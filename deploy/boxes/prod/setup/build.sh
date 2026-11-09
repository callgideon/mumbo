#!/usr/bin/env bash
# Builds and pushes the E2B images and the node artifacts from one fork commit.
# Usage: build.sh <fork checkout at the commit to ship>. Prints the tag (short SHA).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fork=$(cd "$1" && pwd); sha=$(git -C "$fork" rev-parse --short=9 HEAD)
acct=$(aws sts get-caller-identity --query Account --output text); reg=$acct.dkr.ecr.us-east-1.amazonaws.com
aws ecr get-login-password --region us-east-1 | docker login -u AWS --password-stdin "$reg" >/dev/null
cd "$fork/packages"
mig=$(ls db/migrations | sed 's/_.*//' | sort | tail -n 1)
push() { docker tag "$1" "$reg/mumbo-boxes/$2:$sha"; docker push -q "$reg/mumbo-boxes/$2:$sha" >/dev/null 2>&1 || echo "  $2:$sha already pushed"; }
docker build -q -f api/Dockerfile --build-arg COMMIT_SHA="$sha" --build-arg VERSION="mumbo-$sha" --build-arg EXPECTED_MIGRATION_TIMESTAMP="$mig" -t "e2b-api:$sha" . >/dev/null && push "e2b-api:$sha" e2b-api
docker build -q -f client-proxy/Dockerfile --build-arg COMMIT_SHA="$sha" -t "e2b-client-proxy:$sha" . >/dev/null && push "e2b-client-proxy:$sha" e2b-client-proxy
cp "$here/setup.sh" ./setup.sh; trap 'rm -f "$fork/packages/setup.sh"' EXIT
# Tagged by fork commit and the setup files' hash (control.tf computes the same), so a setup change ships alone.
stag=$sha-$(cat "$here/Dockerfile" "$here/setup.sh" | sha256sum | cut -c1-7)
docker build -q -f "$here/Dockerfile" -t "e2b-setup:$stag" . >/dev/null && push "e2b-setup:$stag" e2b-setup
# Node binaries, built from the same commit: orchestrator (static) and envd.
docker run --rm -v "$fork:/src" -v e2b-gomod:/go/pkg/mod -v e2b-gocache:/root/.cache/go-build golang:1.26 bash -ec "
  git config --global --add safe.directory /src
  cd /src/packages/orchestrator && make fetch-busybox >/dev/null && make build-local STATIC=1 COMMIT_SHA=$sha VERSION=mumbo-$sha >/dev/null
  cd /src/packages/envd && make build BUILD=$sha BUILD_OS=linux BUILD_ARCH=amd64 >/dev/null"
bucket=mumbo-boxes-templates-$acct
aws s3 cp --quiet orchestrator/bin/orchestrator "s3://$bucket/artifacts/e2b/$sha/orchestrator"
aws s3 cp --quiet envd/bin/envd "s3://$bucket/artifacts/e2b/$sha/envd"
echo "$sha"
