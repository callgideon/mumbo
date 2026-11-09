#!/usr/bin/env bash
# Runs mumbo-drain from node.sh.tftpl against a fake node: two boxes in a fake cgroup root, a stub curl that records
# each call and "pauses" a box by removing its cgroup directory. Fails unless every box is paused with the node's
# API key and address, after the node is marked draining.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'find "$work" -mindepth 1 -delete; rmdir "$work"' EXIT

# The script as the node writes it: the heredoc body, with Terraform's escapes undone.
sed -n "/^cat > \/usr\/local\/bin\/mumbo-drain <<'SH'$/,/^SH$/p" "$here/node.sh.tftpl" | sed '1d;$d' | sed 's/\$\${/${/g; s/%%{/%{/g' > "$work/drain"
mkdir -p "$work/bin" "$work/cg/sbx-aaa111-r1" "$work/cg/sbx-bbb222-r2" "$work/cg/other"
printf 'API_URL=http://api.test:3000\nTEAM_API_KEY=e2b_testkey\nADMIN_TOKEN=admintok\nNODE_IP=10.0.0.9\n' > "$work/node.env"
cat > "$work/bin/curl" <<EOF
#!/bin/sh
echo "\$*" >> "$work/calls"
case "\$*" in
  *"/pause"*) id=\$(echo "\$*" | sed -n 's|.*/sandboxes/\([^/]*\)/pause.*|\1|p'); for d in "$work/cg/sbx-\$id-"*; do rmdir "\$d"; done; printf 200 ;;
  *"/nodes/"*) printf 204 ;;
esac
EOF
printf '#!/bin/sh\n' > "$work/bin/sleep"
chmod +x "$work/bin/curl" "$work/bin/sleep" "$work/drain"

out=$(env -i PATH="$work/bin:/usr/bin:/bin" NODE_ENV="$work/node.env" CGROUP_ROOT="$work/cg" ORCH_HEALTH=http://health.test bash "$work/drain")
echo "$out"
fail() { echo "FAIL: $1"; exit 1; }
grep -q 'node empty' <<<"$out" || fail "node not empty"
grep -q -- '-H X-Admin-Token: admintok .*"status":"draining".* http://api.test:3000/nodes/10.0.0.9' "$work/calls" || fail "node not marked draining"
for id in aaa111 bbb222; do
  grep -q -- "-H X-API-Key: e2b_testkey http://api.test:3000/sandboxes/$id/pause" "$work/calls" || fail "box $id not paused with the node's key and api"
done
[ "$(grep -n draining "$work/calls" | cut -d: -f1)" -lt "$(grep -n pause "$work/calls" | head -1 | cut -d: -f1)" ] || fail "paused before marking draining"
echo PASS
