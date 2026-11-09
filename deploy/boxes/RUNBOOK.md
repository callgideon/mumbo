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
4. Nodes: blue/green through `node_count` ("Adding nodes", step 5). Each termination pauses its boxes first. Never restart orchestrators in place on a node with boxes you cannot afford to pause.

### Adding nodes
`node_count` in `prod/terraform.tfvars` is the one setting. It is the ASG desired capacity (1..10; `max_size` is 10), the `nodes-below-min` alarm threshold, and sets the edge cap `MAX_RUNNING_UNITS = 2 * (12 * node_count - 2)`. The ASG `min_size` is `min(2, node_count)`, below `node_count`, so scale-in never meets the minimum.

The cap counts capacity units of running sandboxes, by memory: a person or project box is 4096 MB (`edge/template.mjs`, default `memoryMB`) and costs 2 units; a child sandbox is 2048 MB (the `mumbo-child` template build argument) and costs 1 (`edge/capacity.mjs`). Twelve boxes per node is 48 GiB of guest hugepages (`hugepages` in `prod/nodes.tf`) divided by 4 GiB; 2 boxes of headroom are subtracted in total. Boxes and children share the cap, and a child create is refused at the limit like a box create. The cap is approximate: the edge counts, then creates, so concurrent creates can pass the limit together, and the headroom absorbs that. Project boxes use the person template until `PROJECT_TEMPLATE` is set. `box_ram = 8192` in `prod/control.tf` is only the E2B tier's per-sandbox RAM ceiling, not a box size. Limits: 2 nodes 44 units (22 boxes), 3 nodes 68, 4 nodes 92.

The edge also gets `MAX_RUNNING_BOXES = 12 * node_count - 2`, read only by edge images from before the units change, so a rollback to one stays capped. Remove it from `prod/edge.tf` (and its guard in `edge/config.test.mjs`) when no such image can be rolled back to.
1. Edit `node_count`. Run `terraform -chdir=deploy/boxes/prod plan`. Expect `aws_autoscaling_group.nodes`, `aws_cloudwatch_metric_alarm.ops["nodes-below-min"]` (threshold), `aws_ecs_task_definition.edge` (replaced) and `aws_ecs_service.edge`. Read every other line: `APPROVER_EMAILS` and the `NTFY_TOPIC` secret must not change.
2. Apply. New nodes boot from the current launch template, join `orchestrators.boxes.internal` and take new boxes; existing boxes stay where they are.
3. Verify. The ASG must show `node_count` twice:
   ```sh
   aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names mumbo-boxes-nodes \
     --query 'AutoScalingGroups[0].[DesiredCapacity,length(Instances[?LifecycleState==`InService`])]'
   ```
   The edge rollout must show one `PRIMARY` deployment, `COMPLETED`, on the new task definition revision:
   ```sh
   aws ecs describe-services --cluster mumbo-boxes-e2b --services edge \
     --query 'services[0].deployments[].[status,taskDefinition,rolloutState,runningCount]'
   aws ecs describe-task-definition --task-definition mumbo-boxes-edge \
     --query "taskDefinition.containerDefinitions[?name=='edge'].environment[] | [?starts_with(name, 'MAX_RUNNING')]"
   ```
   The `nodes-below-min` alarm reads `GroupInServiceInstances` (group metrics are enabled on the ASG) and returns to OK once the new nodes are in service.
4. Lowering `node_count`: only when the running units fit under the new limit. Count them from `deploy/boxes/edge` with the tunnel and key from "Rebuild the box template":
   ```sh
   cd deploy/boxes/edge && E2B_API_URL=... E2B_API_KEY=... node -e "import('./capacity.mjs').then(async c=>{const {Sandbox}=await import('e2b');console.log(await c.runningUnits({Sandbox}))})"
   ```
   The result must be at most `2 * (12 * new_count - 2)`. Surplus nodes terminate through the drain hook: their boxes pause and resume on the remaining nodes. The same check applies when blue/green goes back from 2N to N.
5. Blue/green node upgrades go through `node_count` only. Set `e2b_sha` and `node_count = 2N` (N at most 5) and apply; the unit cap doubles while both sets run. Wait until the new nodes are in `orchestrators.boxes.internal` and the ASG shows 2N in service. Set `node_count = N` and apply: scale-in uses `OldestLaunchTemplate`, so the old nodes terminate, each pausing its boxes through the drain hook. Never apply while the ASG desired capacity differs from `node_count`, and never change it with `set-desired-capacity` or a decrementing terminate.

### Offboarding a person
Deleting a box and its backup does not remove the person's access. A domain-admitted person (`@mumbo.si`, `@cambrialabs.ai`) would sign in again and get a new empty box, and an existing oauth2-proxy session stays valid for up to 168 hours. Do steps 1 to 3 in order, then 4.
1. Disable the account in Google Workspace (Admin console, Directory, Users, the person, Suspend user).
2. Ban the user in Supabase (dashboard of project `qkvcouccrhyjiarkauyo`, Authentication, Users, the person, "..." menu, Ban user). Ban also blocks signing up again with the address; Delete user only removes the record and lets the address sign up anew.
3. Deny the address at the edge. The allowlist accepts `!<address>` entries, an exact address (case-insensitive) that is refused before any allow match; the edge checks the allowlist on every request, so it also cuts off a live session. A malformed `!` entry stops the edge at startup. Append it (the literal part is single-quoted because `!` triggers history expansion inside double quotes in interactive bash and zsh):
   ```sh
   P=/mumbo/boxes/allowed-emails
   V=$(aws ssm get-parameter --name $P --query Parameter.Value --output text)
   aws ssm put-parameter --name $P --type String --overwrite --value "$V"',!<email>'
   aws ssm get-parameter --name $P --query Parameter.Value --output text
   ```
   The read-back must end with `,!<email>`; stop and fix it if not. Then roll the edge and wait:
   ```sh
   aws ecs update-service --cluster mumbo-boxes-e2b --service edge --force-new-deployment
   aws ecs describe-services --cluster mumbo-boxes-e2b --services edge --query 'services[0].deployments[].rolloutState'
   ```
   Wait until only `COMPLETED` is shown. Without this step an existing session stays valid for up to 168 hours. Rotating the oauth2-proxy cookie secret (`/mumbo/boxes/cookie-secret`) with the same forced deployment signs everyone out at once; use it only if all sessions must end.
   Deny entries are exact addresses. Add a `!` entry for each Workspace alias of the person; a plus-address (`name+x@mumbo.si`) is a different address and is stopped only by step 1 (the disabled account). Owned projects stay tied to the address, so removing a deny entry later hands them to whoever holds that address.
4. Delete the data, from `deploy/boxes/edge` (`npm ci` once). The script needs the E2B tunnel from "Rebuild the box template" (`E2B_API_URL`, `E2B_SANDBOX_URL`, and `E2B_API_KEY`, the team key in the `mumbo-boxes/e2b` secret, `TEAM_API_KEY` field), `BACKUP_BUCKET=mumbo-boxes-backup-<account id>`, `AWS_REGION=us-east-1`, AWS credentials that may list and delete object versions in that bucket, and the edge's Redis (ElastiCache `mumbo-boxes-edge`, not MemoryDB) to list owned projects. Forward it through a node:
   ```sh
   EP=$(terraform -chdir=deploy/boxes/prod output -raw edge_redis_endpoint)
   NODE=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names mumbo-boxes-nodes \
     --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`]|[0].InstanceId' --output text)
   aws ssm start-session --target $NODE --document-name AWS-StartPortForwardingSessionToRemoteHost \
     --parameters "host=$EP,portNumber=6379,localPortNumber=16379"   # leave running in its own terminal
   export REDIS_URL=rediss://127.0.0.1:16379 REDIS_SERVERNAME=$EP    # the server certificate is checked against REDIS_SERVERNAME
   ```
   The script refuses a Redis that holds no `boxes` set. Then:
   ```sh
   cd deploy/boxes/edge && node offboard.mjs <email>                    # dry run: sandbox ids with owners, backup versions, owned projects
   cd deploy/boxes/edge && node offboard.mjs <email> --delete <email>   # kill, delete, list again, fail if anything remains
   ```
   `--delete` kills the person's boxes and children (metadata `user` or `owner` equal to the email, nobody else's) and deletes every backup version under `users/<sha256 of the lowercased email>/`.
5. Projects the person owns are listed, never deleted. Killing one or transferring it is the founder's decision. To kill a project box: `node -e "import('e2b').then(({Sandbox})=>Sandbox.kill('<sandbox id from the dry run>'))"` from `deploy/boxes/edge` with the same E2B variables; there is no transfer command today.
6. The edge drops its Redis record of a killed box on its next sweep. The person's chats and files live in the box and its backup, which step 4 removes. Not removed: the audit records of approvals (`audit/approvals/` in the backup bucket, kept on purpose), and pause snapshots of a box that was paused. Those are objects named by an E2B build UUID (`<uuid>/memfile`, `rootfs.ext4`) in the templates bucket (`mumbo-boxes-templates-<account id>`), not by the person; the bucket's lifecycle rule expires only noncurrent versions (14 days), so a current snapshot object does not expire. Whether E2B deletes those objects when a sandbox is killed is not verified; treat them as retained until the boxes session confirms or adds a cleanup.

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
