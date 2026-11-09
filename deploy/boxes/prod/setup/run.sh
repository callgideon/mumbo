#!/usr/bin/env bash
# Runs the setup task (migrations, team, limits) and waits for it; exits non-zero unless it exited 0.
set -euo pipefail
cd "$(dirname "$0")/.."
cmd=$(terraform output -raw setup_run)
arn=$(eval "$cmd --query 'tasks[0].taskArn' --output text")
echo "setup task $arn"
aws ecs wait tasks-stopped --cluster mumbo-boxes-e2b --tasks "$arn"
code=$(aws ecs describe-tasks --cluster mumbo-boxes-e2b --tasks "$arn" --query 'tasks[0].containers[0].exitCode' --output text)
aws logs tail /mumbo-boxes/setup --since 15m | tail -20
[ "$code" = 0 ] || { echo "setup exited $code" >&2; exit 1; }
