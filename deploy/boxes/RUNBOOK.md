# mumbo boxes: runbook

One section per alarm in `prod/ops.tf` (alarm name `mumbo-boxes-<section>`), then routine operations. Commands run from `deploy/boxes/prod` with AWS credentials for account 641134885443. Logs: CloudWatch groups `/mumbo-boxes/{edge,api,client-proxy,setup}`, and `/mumbo-boxes/nodes` with streams `<instance>/orchestrator`, `<instance>/lifecycle` (drain) and `<instance>/boot`; node memory and disk metrics in namespace `mumbo/boxes/nodes`. A new node's orchestrator restarts 3–5 times at first boot (root cgroup race) before it serves; that is expected.

## Alarms

### edge-backup-failed
A box backup to S3 failed; the sweep retries in 5 minutes. Find the box with `aws logs filter-log-events --log-group-name /mumbo-boxes/edge --filter-pattern '{ $.msg = "backup failed" }'`. Repeated failures for one box usually mean a full disk in the box or a stopped box; repeated failures for every box mean the edge role lost S3 access.

### edge-pause-failed
An idle box could not be paused. E2B's own timeout pauses it 15 minutes later regardless. A box E2B no longer has is dropped from the store automatically; anything else is retried on the next sweep.

### edge-errors
Unhandled edge errors (one log line each, with path and user). Read the lines; a burst after a deploy means roll back `edge_tag` in `terraform.tfvars` and apply.

### edge-dropped-create
A replica died while restoring a new box; the box was killed and the next visit restores from the backup again. One is harmless. Several mean edge tasks are being killed mid-request: check `tasks-edge`.

### api-node-unhealthy
E2B marked a node unhealthy. Check the node: `aws ssm send-command` with `systemctl status e2b-orchestrator` and `journalctl -u e2b-orchestrator -n 100`. If it does not recover, replace it: `aws autoscaling terminate-instance-in-auto-scaling-group --instance-id <id> --no-should-decrement-desired-capacity`. Termination pauses its boxes first (`mumbo-drain`) and the boxes resume on other nodes.

### edge-5xx
More than 20 edge 5xx in 5 minutes. 503s are capacity or a box starting; 502s are the edge or a box not answering. Check `unhealthy-*`, `tasks-*` and `nodes-below-min` first.

### nodes-below-min
Fewer sandbox nodes in service than the minimum. Read the ASG activities: `aws autoscaling describe-scaling-activities --auto-scaling-group-name mumbo-boxes-nodes --max-items 5`. A launch failure names its cause (capacity in the AZ, a bad launch template). The boot log is `/var/log/mumbo-node.log` and the console output.

### unhealthy-edge-user, unhealthy-edge-model, unhealthy-api-http, unhealthy-api-grpc, unhealthy-proxy
A load balancer target fails its health check. ECS replaces failing tasks; the alarm clears when the replacement passes. If it does not, read the service's log group.

### tasks-api, tasks-client-proxy, tasks-edge
A service runs fewer than two tasks. `aws ecs describe-services --cluster mumbo-boxes-e2b --services <name> --query 'services[0].events[:5]'` names the reason (image pull, secret access, failing health check, circuit-breaker rollback).

### memorydb-memory
E2B's Redis is over 75% memory. Losing keys kills running sandboxes (review B1), so scale before it fills: raise `node_type` of `aws_memorydb_cluster.e2b` in `data.tf` and apply (online).

### rds-cpu, rds-storage
Postgres is busy or short of space. Storage grows automatically up to 500 GB; CPU means resizing `instance_class` in `data.tf` (Multi-AZ failover, about a minute).

## Operations

### Ship a new E2B fork commit
1. In the fork checkout at the commit: `setup/build.sh <fork>`; it prints the tag.
2. Set `e2b_sha` in `terraform.tfvars`, apply `-target=aws_ecs_task_definition.setup`, run `setup/run.sh` (migrations, idempotent).
3. Apply. api and client-proxy roll with a circuit breaker.
4. Nodes: raise the ASG desired capacity by the node count, wait until the new nodes are in DNS (`orchestrators.boxes.internal`), then terminate the old ones one at a time. Each termination pauses its boxes first. Never restart orchestrators in place on a node with boxes you cannot afford to pause.

### Adding nodes
`node_count` in `prod/terraform.tfvars` is the one setting: it is the ASG desired capacity (1..10; `max_size` is 10) and the edge's `MAX_RUNNING_BOXES = 12 * node_count - 2`. Twelve is the person-box figure: each node gives guests 48 GiB of hugepages (`hugepages` in `prod/nodes.tf`) and a person box is 4096 MB (`edge/template.mjs`, default `memoryMB`). Project boxes use the same template until `PROJECT_TEMPLATE` is set, and count against the same cap. `box_ram = 8192` in `prod/control.tf` is only the E2B tier's per-sandbox RAM ceiling, not a box size. 2 nodes allow 22 running boxes, 3 allow 34, 4 allow 46.
1. Edit `node_count`. Run `terraform -chdir=deploy/boxes/prod plan`. Expect `aws_autoscaling_group.nodes` `desired_capacity` to change, plus `aws_ecs_task_definition.edge` (replaced) and `aws_ecs_service.edge` (the new `MAX_RUNNING_BOXES`). Read every other line: the plan must not change `APPROVER_EMAILS` or the `NTFY_TOPIC` secret. If it does, the variables `approver_emails` and `ntfy_enabled` were applied from the command line and must be passed again (`-var approver_emails=... -var ntfy_enabled=true`).
2. Apply. New nodes boot from the current launch template, join `orchestrators.boxes.internal` and take new boxes; existing boxes stay where they are.
3. Verify: `aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names mumbo-boxes-nodes` shows `InService` equal to `node_count`; the `nodes-below-min` alarm is OK; the edge log's capacity pages stop; a running task has `MAX_RUNNING_BOXES` set (`aws ecs describe-task-definition --task-definition mumbo-boxes-edge`).
4. Lowering `node_count` terminates the surplus nodes through the drain hook (their boxes pause and resume elsewhere). Lower the cap first only if the running boxes fit in the smaller pool.
Blue/green node upgrades still raise desired capacity by hand (`aws autoscaling set-desired-capacity`); the next apply sets it back to `node_count`.

### Offboarding a person
`node deploy/boxes/edge/offboard.mjs <email>` lists the person's E2B boxes and every version of their backup (`users/<sha256 of the lowercased email>/` in the backup bucket). It deletes nothing unless run as `... <email> --delete <email>`. Run it from `deploy/boxes/edge` (`npm ci` once) with the E2B tunnel from "Rebuild the box template" (`E2B_API_URL`, `E2B_SANDBOX_URL`, `E2B_API_KEY`) and `BACKUP_BUCKET=mumbo-boxes-backup-<account id>`, `AWS_REGION=us-east-1` and credentials that may list and delete object versions.
1. Remove the person from the allowlist (SSM `/mumbo/boxes/allowed-emails`, then restart the edge tasks), or their next visit creates a new box.
2. Dry run, read the box ids and version count, then run with `--delete`.
3. The edge drops its record of a box E2B no longer has on its next sweep; nothing else holds the person's data. Their grants (`APPROVER_EMAILS`) and project boxes are separate: project boxes are owned by the person's email and are not touched by this script.

### Ship a new edge
Commit, `docker build` `deploy/boxes/edge` and push to `mumbo-boxes/edge:<commit>`, set `edge_tag`, apply.

### Rebuild the box template
`node deploy/boxes/edge/template.mjs <mumbo web image>` with `E2B_API_URL`, `E2B_SANDBOX_URL`, `E2B_API_KEY` (team key from the `mumbo-boxes/e2b` secret) and `ECR_PASSWORD`. From outside the VPC, tunnel through a node with SSM port forwarding to `api.boxes.internal:3000` and `sandbox.boxes.internal:3002`; the internal NLB admits :3002 only from the edge, so add a temporary rule for the node security group and remove it afterwards. A new template reaches a user when their box is next created.

### Restore Postgres to a point in time
`aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier mumbo-boxes-e2b --target-db-instance-identifier mumbo-boxes-e2b-restore --restore-time <UTC>` into the same subnet group and security group, then point `POSTGRES_CONNECTION_STRING` in the `mumbo-boxes/e2b` secret at the new instance and force a new deployment of api. Snapshots that newer rows point at stay in the versioned templates bucket for 14 days (review M4).

## Drills (stage 7)

| Drill | How | Pass |
|---|---|---|
| Node replaced with boxes on it | Create a box, terminate its node with the ASG call above | **Passed 2026-11-09** (second run): node released in 82 s, box paused by `mumbo-drain`, resumed on the other node in 4.8 s with its file and a process from before. The first run lost the box: the drain's pauses had no API address or key (fixed in 1117d7f21f, covered by `prod/nodes/drain.test.sh`) |
| Edge task killed mid-restore | Stop an edge task during a first visit | `edge-dropped-create` fires; the next visit restores from the backup |
| Postgres point-in-time restore | The procedure above into a scratch instance | **Passed 2026-11-09:** restored to 10 minutes back in about 20 minutes (single-AZ scratch); it held the templates (`mumbo-box`, `mumbo-child`, `mumbo-box-desktop`), 9 builds, 2 teams and E2B's migration tables; scratch deleted |
| Alarm delivery | `aws cloudwatch set-alarm-state --alarm-name mumbo-boxes-edge-errors --state-value ALARM --state-reason drill` | **Passed 2026-11-09:** the alarm action published to `mumbo-boxes-alarms` (after making the topic unencrypted) |
