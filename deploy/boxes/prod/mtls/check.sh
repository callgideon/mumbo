#!/usr/bin/env bash
# Issues this module's certificates into a throwaway state and runs them through E2B's mtls package.
# Usage: check.sh <E2B fork checkout>. Needs terraform and docker.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fork=$(cd "$1" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"; rm -f "$fork/packages/shared/pkg/mtls/mumbo_check_test.go"' EXIT
cat > "$work/main.tf" <<TF
module "m" {
  source       = "$here"
  trust_domain = "boxes.internal"
  services     = ["api", "client-proxy", "orchestrator"]
}
output "ca" { value = module.m.ca_pem }
output "leaves" {
  value     = module.m.leaves
  sensitive = true
}
TF
(cd "$work" && terraform init -input=false >/dev/null && terraform apply -auto-approve -input=false >/dev/null && terraform output -json > out.json)
mkdir "$work/certs"
python3 - "$work" <<'PY'
import json, sys; w = sys.argv[1]; o = json.load(open(f"{w}/out.json"))
open(f"{w}/certs/ca.crt", "w").write(o["ca"]["value"])
for s, v in o["leaves"]["value"].items():
    open(f"{w}/certs/{s}.crt", "w").write(v["crt"]); open(f"{w}/certs/{s}.key", "w").write(v["key"])
PY
cp "$here/check/mumbo_check_test.go" "$fork/packages/shared/pkg/mtls/"
docker run --rm -v "$fork:/src" -v "$work/certs:/certs:ro" -v e2b-gomod:/go/pkg/mod -e CERTS=/certs -w /src/packages/shared \
  golang:1.26 go test ./pkg/mtls -run TestMumboCertificates -count=1 -v
