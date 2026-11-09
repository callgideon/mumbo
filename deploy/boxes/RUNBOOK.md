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

### Ship a new edge
Commit, `docker build` `deploy/boxes/edge` and push to `mumbo-boxes/edge:<commit>`, set `edge_tag`, apply.

### Rebuild the box template
`node deploy/boxes/edge/template.mjs <mumbo web image>` with `E2B_API_URL`, `E2B_SANDBOX_URL`, `E2B_API_KEY` (team key from the `mumbo-boxes/e2b` secret) and `ECR_PASSWORD`. From outside the VPC, tunnel through a node with SSM port forwarding to `api.boxes.internal:3000` and `sandbox.boxes.internal:3002`; the internal NLB admits :3002 only from the edge, so add a temporary rule for the node security group and remove it afterwards. A new template reaches a user when their box is next created.

### Model routes
Boxes reach models only through the edge model host (`llm.` host, port 8081), with their box token as the API key; every route checks the token, the source address (`BOX_EGRESS_IPS`), the founder's stop switch, the daily request budget (`DAILY_MODEL_REQUESTS`) and the daily token budget (`DAILY_TOKENS_USER`, `DAILY_TOKENS_PROJECT`; usage read from each response), and swaps the token for the edge's own key.

| Route | Box side | Upstream | Body cap |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_BASE_URL=https://<llm host>/anthropic`, search `/v1/tools/…`, `/models` | `MODEL_UPSTREAM` (api.deepseek.com), key `mumbo/prod/deepseek-api-key` | none at the edge |
| OpenRouter | dsh-llm-pi-ai route `openrouter`, `baseURL https://<llm host>/openrouter/v1`, written by `startScript` (`/root/.mumbo/models.overlay.yml`) | `https://openrouter.ai/api/v1/chat/completions` and `/models` only, key `mumbo-boxes/openrouter` (`OPENROUTER_API_KEY`) | 20 MiB (413 and the connection closed; a larger `content-length` is refused before reading); dsh keeps images to 12 MiB |

OpenRouter rules, all in `openrouterBody` (`edge.mjs`); a refused request gets 400 and nothing is forwarded:

- **Models:** only the exact ids in `OPENROUTER_MODELS` (tfvar `openrouter_models`, default `qwen/qwen3.8-27b,qwen/qwen3.5-9b`); `/openrouter/v1/models` lists only those ids.
- **Content:** message content parts may only be `text`, or `image_url` with a `data:image/` URL. `file` (OpenRouter's paid PDF parser), `input_audio`, `video_url` and remote image URLs are refused, so the body cap bounds every image and OpenRouter fetches nothing.
- **Fields:** only `OPENROUTER_FIELDS` pass: `model`, `messages`, `stream`, `stream_options`, `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `stop`, `seed`, `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `reasoning` (what dsh's pi-ai sends, plus standard sampling fields). Everything else, such as `provider`, `models`, `plugins`, `route`, `transforms`, `preset`, `web_search_options`, `usage` or `include_reasoning`, is dropped.
- **Set by the edge:** `stream: true` and `stream_options: {"include_usage": true}` (dsh always streams; the final chunk carries usage), `reasoning.exclude: false` when `reasoning` is present (reasoning is reported, not hidden), and `provider: {"data_collection":"deny","zdr":true}` (no endpoint that trains on prompts; zero-data-retention endpoints only).
- **Headers:** upstream gets only `content-type`, the OpenRouter key and pi-ai's `x-session-id` (at most 128 of `A-Za-z0-9._:-`; it keeps a Session on one provider for prompt caching).
- **Usage:** `prompt_tokens + completion_tokens` (reasoning tokens are inside `completion_tokens`). A box that drops a stream before its usage chunk is charged ceil(request bytes without image data / 3) plus `OPENROUTER_IMAGE_TOKENS` per image (default 1500; set it in the edge task's `environment` in `prod/edge.tf`) plus ceil(streamed characters / 3). An upstream error is not charged. Each call, `/models` included, logs one `"edge":"model"` line.

- **Add or remove a model:** change `openrouter_models` and apply. The edge enforces it at once; a box lists the new set when it is next created (`startScript`), with metadata from dsh's pi-ai catalog unless `OPENROUTER_BOX_MODELS` in `edge.mjs` overrides it; override a context window only to the `context_length` that `/openrouter/v1/models` reports. A box created earlier keeps listing a removed model, whose requests get 400.
- **Disable:** set `openrouter_models = ""` and apply: the paths answer 404, neither the task nor Terraform reads the key, and new boxes get no OpenRouter route.
- **No ZDR endpoint:** if requests fail with OpenRouter's 404 about data policy, set `openrouter_zdr = false` and apply; `data_collection: deny` stays.
- **Sessions:** a Session keeps the model it started with; to use images, the user starts a Session on a Qwen model.

### Restore Postgres to a point in time
`aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier mumbo-boxes-e2b --target-db-instance-identifier mumbo-boxes-e2b-restore --restore-time <UTC>` into the same subnet group and security group, then point `POSTGRES_CONNECTION_STRING` in the `mumbo-boxes/e2b` secret at the new instance and force a new deployment of api. Snapshots that newer rows point at stay in the versioned templates bucket for 14 days (review M4).

## Drills (stage 7)

| Drill | How | Pass |
|---|---|---|
| Node replaced with boxes on it | Create a box, terminate its node with the ASG call above | **Passed 2026-11-09** (second run): node released in 82 s, box paused by `mumbo-drain`, resumed on the other node in 4.8 s with its file and a process from before. The first run lost the box: the drain's pauses had no API address or key (fixed in 1117d7f21f, covered by `prod/nodes/drain.test.sh`) |
| Edge task killed mid-restore | Stop an edge task during a first visit | `edge-dropped-create` fires; the next visit restores from the backup |
| Postgres point-in-time restore | The procedure above into a scratch instance | **Passed 2026-11-09:** restored to 10 minutes back in about 20 minutes (single-AZ scratch); it held the templates (`mumbo-box`, `mumbo-child`, `mumbo-box-desktop`), 9 builds, 2 teams and E2B's migration tables; scratch deleted |
| Alarm delivery | `aws cloudwatch set-alarm-state --alarm-name mumbo-boxes-edge-errors --state-value ALARM --state-reason drill` | **Passed 2026-11-09:** the alarm action published to `mumbo-boxes-alarms` (after making the topic unencrypted) |
