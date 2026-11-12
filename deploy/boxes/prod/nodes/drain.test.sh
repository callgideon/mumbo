#!/usr/bin/env bash
# Runs mumbo-drain from node.sh.tftpl against a fake node: two boxes in a fake cgroup root, a stub curl that records
# each call and "pauses" a box by removing its cgroup directory, and a fake orchestrator (MAINPID) that records its SIGTERM.
# Fails unless every box is paused with the node's API key and address, after the node is marked draining, and the
# orchestrator is then stopped and its exit logged as the upload time.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap '[ -z "${orch:-}" ] || kill -KILL "$orch" 2>/dev/null || true; find "$work" -mindepth 1 -delete; rmdir "$work"' EXIT

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
# Orphaned at once, so init reaps it when it exits: the drain waits until its pid is gone.
orch=$( (trap 'echo TERM >> "$work/calls"; exit 0' TERM; while :; do /bin/sleep 0.1; done) >/dev/null 2>&1 & echo $!)

out=$(env -i PATH="$work/bin:/usr/bin:/bin" NODE_ENV="$work/node.env" CGROUP_ROOT="$work/cg" ORCH_HEALTH=http://health.test MAINPID="$orch" timeout 30 bash "$work/drain")
echo "$out"
fail() { echo "FAIL: $1"; exit 1; }
grep -q 'node empty' <<<"$out" || fail "node not empty"
grep -q -- '-H X-Admin-Token: admintok .*"status":"draining".* http://api.test:3000/nodes/10.0.0.9' "$work/calls" || fail "node not marked draining"
for id in aaa111 bbb222; do
  grep -q -- "-H X-API-Key: e2b_testkey http://api.test:3000/sandboxes/$id/pause" "$work/calls" || fail "box $id not paused with the node's key and api"
done
[ "$(grep -n draining "$work/calls" | cut -d: -f1)" -lt "$(grep -n pause "$work/calls" | head -1 | cut -d: -f1)" ] || fail "paused before marking draining"
[ "$(tail -1 "$work/calls")" = TERM ] || fail "orchestrator not stopped after the pauses"
kill -0 "$orch" 2>/dev/null && fail "orchestrator still running"
grep -Eq '^mumbo-drain: uploads done, orchestrator exited [0-9]+ s after the first pause$' <<<"$out" || fail "upload time not logged"
echo PASS
