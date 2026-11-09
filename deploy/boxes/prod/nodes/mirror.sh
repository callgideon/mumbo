#!/usr/bin/env bash
# Copies E2B's pinned Firecracker, kernel and busybox releases into our bucket after checking each SHA-256,
# so nodes boot from our account only. Re-run when a version below changes.
set -euo pipefail
src=https://storage.googleapis.com/e2b-artifact-binaries
bucket=mumbo-boxes-templates-$(aws sts get-caller-identity --query Account --output text)
declare -A pins=(
  [firecrackers/v1.14-0.2.0/amd64/firecracker]=ef22aec7cbffcf6cc44a8436a4db79f9e6fe5c52218c81af321dd20f10ad6e5d
  [kernels/vmlinux-6.1.177_5008931/amd64/vmlinux.bin]=9191ced12d24e6e381753a7ab12ec850877524d453eae75c20aeb176f3b5ad05
  [busybox/1.36.1/amd64/busybox]=d7cce939adb09a41a22a5f846d22ba8d576b38dbb2b46a5c77a3a3e27ec52520
)
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
for key in "${!pins[@]}"; do
  curl -fsSL --retry 3 -o "$tmp" "$src/$key"
  [ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "${pins[$key]}" ] || { echo "sha256 mismatch: $key" >&2; exit 1; }
  aws s3 cp --quiet "$tmp" "s3://$bucket/artifacts/$key"; echo "mirrored $key"
done
