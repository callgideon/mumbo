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
`node_count` in `prod/terraform.tfvars` is the one setting. It is the ASG min and desired capacity (1..10; `max_size` is 10, so the `nodes-below-min` alarm threshold follows it) and sets the edge cap `MAX_RUNNING_UNITS = 2 * (12 * node_count - 2)`.

The cap counts capacity units of running sandboxes, by memory: a person or project box is 4096 MB (`edge/template.mjs`, default `memoryMB`) and costs 2 units; a child sandbox is 2048 MB (the `mumbo-child` template build argument) and costs 1 (`edge/capacity.mjs`). Twelve boxes per node is 48 GiB of guest hugepages (`hugepages` in `prod/nodes.tf`) divided by 4 GiB; 2 boxes of headroom are subtracted in total. Boxes and children share the cap, and a child create is refused at the limit like a box create. Project boxes use the person template until `PROJECT_TEMPLATE` is set. `box_ram = 8192` in `prod/control.tf` is only the E2B tier's per-sandbox RAM ceiling, not a box size. Limits: 2 nodes 44 units (22 boxes), 3 nodes 68, 4 nodes 92.
1. Edit `node_count`. Run `terraform -chdir=deploy/boxes/prod plan`. Expect `aws_autoscaling_group.nodes` (`min_size`, `desired_capacity`), `aws_ecs_task_definition.edge` (replaced) and `aws_ecs_service.edge`. Read every other line: `APPROVER_EMAILS` and the `NTFY_TOPIC` secret must not change.
2. Apply. New nodes boot from the current launch template, join `orchestrators.boxes.internal` and take new boxes; existing boxes stay where they are.
3. Verify. The ASG: `aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names mumbo-boxes-nodes --query 'AutoScalingGroups[0].[DesiredCapacity,length(Instances[?LifecycleState==`InService`])]'` shows `node_count` twice. The edge rollout: `aws ecs describe-services --cluster mumbo-boxes-e2b --services edge --query 'services[0].deployments[].[status,taskDefinition,rolloutState,runningCount]'` shows one `PRIMARY` deployment, `COMPLETED`, on the new task definition revision. `aws ecs describe-task-definition --task-definition mumbo-boxes-edge --query "taskDefinition.containerDefinitions[?name=='edge'].environment[] | [?name=='MAX_RUNNING_UNITS']"` shows the new limit. The `nodes-below-min` alarm is OK.
4. Lowering `node_count`: only when the running units fit under the new limit. Count them with `E2B_API_URL=... E2B_SANDBOX_URL=... E2B_API_KEY=... node -e "import('./capacity.mjs').then(async c=>{const {Sandbox}=await import('e2b');console.log(await c.runningUnits({Sandbox}))})"` from `deploy/boxes/edge` (tunnel and key as in "Rebuild the box template"); the result must be at most `2 * (12 * new_count - 2)`. Surplus nodes terminate through the drain hook: their boxes pause and resume on the remaining nodes.
5. Blue/green node upgrades go through `node_count` from now on: set it to 2N and apply; when the new nodes are in `orchestrators.boxes.internal`, terminate each old node one at a time with `aws autoscaling terminate-instance-in-auto-scaling-group --instance-id <id> --should-decrement-desired-capacity`; set `node_count` back to N and apply. Never apply while the ASG desired capacity differs from `node_count`, and do not set desired capacity by hand.

### Offboarding a person
Deleting a box and its backup does not remove the person's access. A domain-admitted person (`@mumbo.si`, `@cambrialabs.ai`) would sign in again and get a new empty box, and an existing oauth2-proxy session stays valid for up to 168 hours. Do these in order.
1. Disable the account in Google Workspace (Admin console, Directory, Users, the person, Suspend user).
2. Delete or ban the user in Supabase (dashboard of project `qkvcouccrhyjiarkauyo`, Authentication, Users, the person, "..." menu, Delete user or Ban user), so no email link or Google sign-in produces a new token.
3. Deny the address at the edge. The allowlist accepts `!<address>` entries, an exact address (case-insensitive) that is refused before any allow match, and the edge checks it on every request, so it also cuts off a live session. Append it and roll the edge:
   `P=/mumbo/boxes/allowed-emails; V=$(aws ssm get-parameter --name $P --query Parameter.Value --output text); aws ssm put-parameter --name $P --type String --overwrite --value "$V,!<email>"`
   `aws ecs update-service --cluster mumbo-boxes-e2b --service edge --force-new-deployment`
   Wait for `aws ecs describe-services --cluster mumbo-boxes-e2b --services edge --query 'services[0].deployments[].rolloutState'` to show only `COMPLETED`. Without this step an existing session stays valid for up to 168 hours. Rotating the oauth2-proxy cookie secret (`/mumbo/boxes/cookie-secret`) followed by the same forced deployment signs everyone out at once; use it only if the person's session itself is a concern for all users.
4. Delete the data. From `deploy/boxes/edge` (`npm ci` once), with the tunnel from "Rebuild the box template" (`E2B_API_URL`, `E2B_SANDBOX_URL`; `E2B_API_KEY` is the team key in the `mumbo-boxes/e2b` secret, `TEAM_API_KEY` field), `BACKUP_BUCKET=mumbo-boxes-backup-<account id>`, `AWS_REGION=us-east-1`, AWS credentials that may list and delete object versions in that bucket, and `REDIS_URL` (the MemoryDB address, reached through the same tunnel, only to list owned projects):
   `cd deploy/boxes/edge && node offboard.mjs <email>` (dry run: every sandbox id with its owner, every backup version, owned projects).
   `cd deploy/boxes/edge && node offboard.mjs <email> --delete <email>` kills the person's boxes and children (metadata `user` or `owner` equal to the email, nobody else's), deletes every backup version under `users/<sha256 of the lowercased email>/`, then lists again and exits with an error if anything remains.
5. Projects the person owns are listed, never deleted. Killing one or transferring it is the founder's decision. To kill a project box: `node -e "import('e2b').then(({Sandbox})=>Sandbox.kill('<sandbox id from the dry run>'))"` with the same E2B variables; there is no transfer command today.
6. The edge drops its Redis record of a killed box on its next sweep. The person's chat and project data live only in the box and its backup, which step 4 removes; audit records of approvals (`audit/approvals/` in the backup bucket) are kept on purpose.

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
