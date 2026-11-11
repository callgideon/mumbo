# Stage 6: the edge on Fargate behind a public ALB.
#   app.mumbo.si        -> oauth2-proxy :4180 (Supabase sign-in) -> edge :8080 (loopback)
#   *.app.mumbo.si      -> the same; the edge serves approve.app.mumbo.si and project boxes p-<16 hex>.app.mumbo.si, 404 otherwise
#   llm.app.mumbo.si    -> edge model host :8081 (box token + source address = one of our NAT EIPs); llm.boxes.mumbo.si too
#   boxes.mumbo.si (the former public host), api.mumbo.si and *.boxes.mumbo.si -> redirect (old_hosts rules)
# One edge per region (design section 17c): it runs in a cell's VPC and ECS cluster and reaches E2B by the cell's
# private names on its internal NLB. The root holds the settings (variables, with their checks) and the public records.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" { type = string }
variable "edge_tag" { type = string }
variable "approver_emails" { type = string }
variable "run_wild_default_emails" { type = string }
variable "ntfy_enabled" { type = bool }
variable "github_agent_login" { type = string }
variable "github_agent_id" { type = string }
variable "openrouter_models" { type = string }
variable "openrouter_zdr" { type = bool }
variable "signin_cookie_name" { type = string }
variable "placement_cache_ms" { type = number }
variable "ecr" {
  description = "Image prefix: <registry>/<repository prefix>; the image is <this>/edge."
  type        = string
}
variable "cert_validation_fqdns" {
  description = "The certificate's DNS validation records (the root writes them into the public zone)."
  type        = list(string)
}
# The cell this edge runs in: its network, cluster, roles, stores and E2B names (modules/cell outputs).
variable "vpc_id" { type = string }
variable "public_subnets" { type = list(string) }
variable "private_subnets" { type = list(string) }
variable "box_egress_ips" {
  description = "BOX_EGRESS_IPS: the NAT addresses boxes call the model host from."
  type        = list(string)
}
variable "ecs_cluster_id" { type = string }
variable "exec_role" {
  description = "The cell's ECS task execution role; the edge adds its own grants to it."
  type        = object({ id = string, arn = string })
}
variable "edge_security_group_id" { type = string }
variable "data_security_group_id" { type = string }
variable "data_kms_key_arn" { type = string }
variable "store_secret_arn" {
  description = "Secrets Manager secret (a replica in this region) whose url is the edge store's rediss:// URL with its user and password (root store.tf)."
  type        = string
}
variable "cells" {
  description = "Every cell the edge serves, by region (modules/cell outputs and the cell's node count). This edge's own region's cell gives the single-cell settings; with cells_enabled, all of them are CELLS (edge/cells.mjs)."
  type = map(object({
    e2b_api_url         = string
    e2b_sandbox_url     = string
    backup_bucket       = string
    backups_kms_key_arn = string
    data_kms_key_arn    = string
    e2b_secret_arn      = string
    node_count          = number
  }))
  validation {
    condition     = contains(keys(var.cells), "us-east-1")
    error_message = "cells must include us-east-1: records without a region are there, and so are approval audit records."
  }
}
variable "cells_enabled" {
  description = "CELLS and EDGE_REGION (an edge of B21 or later) instead of the single-cell BACKUP_BUCKET, E2B_API_URL, E2B_SANDBOX_URL, E2B_API_KEY and MAX_RUNNING_*; an edge outside us-east-1 runs only with it."
  type        = bool
}
variable "edge_secret_arn" {
  description = "The SSM parameter /mumbo/boxes/edge-secret by full us-east-1 ARN: EDGE_SECRET, the key every box token is signed with."
  type        = string
}
variable "model_key_secret_arn" {
  description = "The Secrets Manager secret mumbo/prod/deepseek-api-key (a plain string) by full us-east-1 ARN: MODEL_KEY."
  type        = string
}

data "aws_caller_identity" "this" {}
data "aws_region" "this" {}

locals {
  name   = var.name
  region = data.aws_region.this.region
}

locals {
  public_host  = "app.mumbo.si"
  approve_host = "approve.${local.public_host}"
  supabase_url = "https://qkvcouccrhyjiarkauyo.supabase.co"
  # The project's publishable key (SUPABASE_ANON_KEY): public, the sign-in page serves it to every visitor in config.js.
  supabase_publishable_key = "sb_publishable_hrzV3iBFsW4OOQydX9nmhA_goP8Birh"
  # oauth2-proxy's callback: Mumbo's OAuth client's redirect URI, the only one the sign-in page sends a code to.
  oauth_redirect_url = "https://${local.public_host}/oauth2/callback"
  # The former public host. Its names redirect (old_hosts rules), except its model host, which boxes created
  # under it have in their start script.
  old_host     = "boxes.mumbo.si"
  llm_host     = "llm.${local.public_host}" # LLM_HOST: new boxes' model host
  llm_hosts    = [local.llm_host, "llm.${local.old_host}"]
  # This edge's own cell: the single-cell settings without CELLS.
  home = var.cells[local.region]
  # Approval audit records go to the us-east-1 bucket from every edge (edge.mjs auditor).
  audit_bucket = var.cells["us-east-1"].backup_bucket
  # api.mumbo.si was the retired shared server's (2026-11-09).
  old_hosts = [local.old_host, "api.mumbo.si"]
  # PROJECT_DOMAIN: project boxes are p-<16 hex>.<this>. It must stay in the mumbo.si zone.
  project_domain = local.public_host
  # Wildcard names: the approve page (approve.<public host>) and project boxes.
  wildcards    = distinct(["*.${local.public_host}", "*.${local.project_domain}"])
  audit_prefix = "audit/approvals/"
}

# ---- certificate and public ALB
resource "aws_acm_certificate" "edge" {
  domain_name               = local.public_host
  subject_alternative_names = concat(local.llm_hosts, local.old_hosts, local.wildcards, ["*.${local.old_host}"])
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_acm_certificate_validation" "edge" {
  certificate_arn         = aws_acm_certificate.edge.arn
  validation_record_fqdns = var.cert_validation_fqdns
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ALB for the edge"
  vpc_id      = var.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = each.key
  to_port           = each.key
}
resource "aws_vpc_security_group_egress_rule" "alb" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
resource "aws_vpc_security_group_ingress_rule" "edge" {
  for_each                     = toset(["4180", "8081"])
  security_group_id            = var.edge_security_group_id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = each.key
  to_port                      = each.key
}

resource "aws_lb" "edge" {
  name                       = "${local.name}-edge"
  load_balancer_type         = "application"
  subnets                    = var.public_subnets
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 3600 # dsh's stream WebSocket stays open while a tab is
  drop_invalid_header_fields = true
  # Append: the edge model host trusts only the last X-Forwarded-For entry, which is the one this ALB adds.
  xff_header_processing_mode = "append"
}
resource "aws_lb_target_group" "edge" {
  for_each             = { user = { port = 4180, path = "/ping" }, model = { port = 8081, path = "/edge/healthz" } }
  name                 = "${local.name}-edge-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = each.value.path
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.edge.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.edge.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }
}
resource "aws_lb_listener_rule" "edge" {
  # [priority, host names, target group]; the llm. rule outranks the wildcards.
  for_each     = { user = [10, [local.public_host], "user"], model = [20, local.llm_hosts, "model"], subdomains = [30, local.wildcards, "user"] }
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value[0]
  condition {
    host_header { values = each.value[1] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.edge[each.value[2]].arn
  }
}
# The MCP door (design §10, R-door): https://<public host>/mcp goes to the model listener, past oauth2-proxy. The door
# takes bearer keys only and ignores cookies, so skipping the sign-in proxy opens no cookie-authenticated path. Ranks
# above the user rule (10), below the X-Forwarded-Uri refusal (1) and the former-name redirects (5, 6). The ALB idle timeout (3600 s) covers long calls.
resource "aws_lb_listener_rule" "door" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 7
  condition {
    host_header { values = [local.public_host] }
  }
  condition {
    path_pattern { values = ["/mcp", "/mcp/*"] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.edge["model"].arn
  }
}
# Former names redirect to the new ones with the same path and query. A project box moved from p-<id>.boxes.mumbo.si
# to p-<id>.app.mumbo.si, which a redirect cannot derive (it keeps or replaces the whole host), so those land on the
# home page, which links every project of the signed-in person.
# The query starts with moved=1 (moved=1& when the request had none): browsers hold the app.mumbo.si -> boxes.mumbo.si
# 301 from before as a cache entry for the plain URL, which would loop; the marked URL is never that entry.
# HTTP_302 until the move is final (PRODUCTION.md, "Public host app.mumbo.si"), then HTTP_301.
resource "aws_lb_listener_rule" "old_hosts" {
  # [priority, host names, redirect host, path]; the wildcard ranks below llm.boxes.mumbo.si (model, 20).
  for_each = {
    main     = [5, local.old_hosts, local.public_host, "/#{path}"]
    approve  = [6, ["approve.${local.old_host}"], local.approve_host, "/#{path}"]
    projects = [40, ["*.${local.old_host}"], local.public_host, "/home"]
  }
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value[0]
  condition {
    host_header { values = each.value[1] }
  }
  action {
    type = "redirect"
    redirect {
      host        = each.value[2]
      port        = "443"
      protocol    = "HTTPS"
      path        = each.value[3]
      query       = "moved=1&#{query}"
      status_code = "HTTP_302"
    }
  }
}
# oauth2-proxy skips sign-in for any GET whose client-sent X-Forwarded-Uri matches a skip-auth route (task below), and
# neither this ALB nor oauth2-proxy sets that header: every request carrying it is refused, before any other rule.
resource "aws_lb_listener_rule" "x_forwarded_uri" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1
  condition {
    http_header {
      http_header_name = "X-Forwarded-Uri"
      values           = ["*"]
    }
  }
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "bad request"
      status_code  = "400"
    }
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.edge.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ---- task
resource "aws_cloudwatch_log_group" "edge" {
  name              = "/${local.name}/edge"
  retention_in_days = 30
}
resource "aws_iam_role" "edge" {
  name               = "${local.name}-edge"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ecs-tasks.amazonaws.com" } }] })
}
# Every cell's backups: a box backs up into, and restores from, its own cell's bucket (each cell's backups key policy
# admits this role, modules/cell edge_role_arn).
resource "aws_iam_role_policy" "edge" {
  role = aws_iam_role.edge.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], Resource = [for c in values(var.cells) : "arn:aws:s3:::${c.backup_bucket}/users/*"] }, # GetObjectVersion: versioned restores (RUNBOOK "Restore an older S3 version")
    { Effect = "Allow", Action = "s3:PutObject", Resource = "arn:aws:s3:::${local.audit_bucket}/${local.audit_prefix}*" },
    { Effect = "Allow", Action = "s3:ListBucket", Resource = [for c in values(var.cells) : "arn:aws:s3:::${c.backup_bucket}"] }, # a HEAD of a missing backup is then 404, not 403
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = [for c in values(var.cells) : c.backups_kms_key_arn] },
    # Edge images before B21 read these two themselves, and a circuit-breaker rollback may run one; B21 and later get both
    # as ECS secrets. Remove once a B21 revision is steady (RUNBOOK "Ship a new edge").
    { Effect = "Allow", Action = "ssm:GetParameter", Resource = "arn:aws:ssm:${local.region}:${data.aws_caller_identity.this.account_id}:parameter/mumbo/boxes/edge-secret" },
    { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = "arn:aws:secretsmanager:${local.region}:${data.aws_caller_identity.this.account_id}:secret:mumbo/prod/deepseek-api-key-*" },
  ] })
}
resource "aws_iam_role_policy" "exec_edge" {
  role = var.exec_role.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "ssm:GetParameters", Resource = distinct(concat(
      [for p in values(merge(local.proxy_ssm, local.edge_ssm)) : "${local.ssm}/${p}"],
      [var.edge_secret_arn],
      # Remove after the plain-env revision is steady (RUNBOOK.md): edge task definitions before it read SUPABASE_ANON_KEY
      # from this parameter, and a circuit-breaker rollback to one must still start.
      ["${local.ssm}/prod/supabase-anon-key"],
    )) },
    { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = concat([data.aws_secretsmanager_secret.github_app.arn, var.store_secret_arn, var.model_key_secret_arn], values(local.edge_secrets), [for c in values(var.cells) : c.e2b_secret_arn]) },
    # Each cell's e2b secret is under that cell's data key; the key policy leaves its use to IAM.
    { Effect = "Allow", Action = "kms:Decrypt", Resource = [for c in values(var.cells) : c.data_kms_key_arn] },
  ] })
}
# The mumbo-bot GitHub App (app_id, slug, private_key), created outside Terraform under the cell's data key (kms:Decrypt in modules/cell/control.tf).
data "aws_secretsmanager_secret" "github_app" { name = "${local.name}/github-app" }
# The OpenRouter API key (a plain string), created outside Terraform under the data key; read only while the route is on.
data "aws_secretsmanager_secret" "openrouter" {
  count = var.openrouter_models == "" ? 0 : 1
  name  = "${local.name}/openrouter"
}

locals {
  ssm = "arn:aws:ssm:${local.region}:${data.aws_caller_identity.this.account_id}:parameter/mumbo"
  # Container env name -> SSM parameter under /mumbo; these are all the exec role may read.
  proxy_ssm = { OAUTH2_PROXY_CLIENT_ID = "boxes/oauth-client-id", OAUTH2_PROXY_CLIENT_SECRET = "boxes/oauth-client-secret", OAUTH2_PROXY_COOKIE_SECRET = "boxes/cookie-secret" }
  edge_ssm = merge(
    { ALLOWED_EMAILS = "boxes/allowed-emails", MUMBO_OAUTH_CLIENT_IDS = "boxes/oauth-client-id" },
    var.ntfy_enabled ? { NTFY_TOPIC = "boxes/ntfy-topic" } : {},
  )
  # Container env name -> plain-string Secrets Manager secret; with github_app, the store, the model key and the cells' e2b
  # secrets, all the secrets the exec role may read.
  edge_secrets = { for s in data.aws_secretsmanager_secret.openrouter : "OPENROUTER_API_KEY" => s.arn }
  # Each cell's E2B key variable, named in CELLS.
  e2b_key_env = { for r in keys(var.cells) : r => "E2B_API_KEY_${upper(replace(r, "-", "_"))}" }
  # Container env name -> e2b secret: every cell's key with CELLS, else this edge's own cell's as E2B_API_KEY, which the
  # SDK reads.
  e2b_keys = var.cells_enabled ? tomap({ for r, c in var.cells : local.e2b_key_env[r] => c.e2b_secret_arn }) : tomap({ E2B_API_KEY = local.home.e2b_secret_arn })
  cells_env = {
    # Each cell's region is its key; maxUnits is MAX_RUNNING_UNITS's formula on the cell's own node count.
    CELLS = jsonencode({ for r, c in var.cells : r => {
      api = c.e2b_api_url, sandbox = c.e2b_sandbox_url, bucket = c.backup_bucket, maxUnits = 2 * (12 * c.node_count - 2), e2bKeyEnv = local.e2b_key_env[r]
    } })
    EDGE_REGION = local.region # newcomers' region
  }
  single_cell_env = {
    BACKUP_BUCKET   = local.home.backup_bucket
    E2B_API_URL     = local.home.e2b_api_url
    E2B_SANDBOX_URL = local.home.e2b_sandbox_url
    # Capacity units, not boxes (edge/capacity.mjs): a person box (4096 MB, edge/template.mjs) is 2, a project box (8192 MB, the
    # mumbo-project build) is 4, a child sandbox (2048 MB, the mumbo-child build argument) is 1. 24 units per node
    # (modules/cell/nodes.tf hugepages) minus 4 of headroom. An edge image from before
    # the units change reads MAX_RUNNING_BOXES (running boxes of all kinds, children too, counted as one each) instead; both stay until no such image can be rolled back to.
    MAX_RUNNING_UNITS = tostring(2 * (12 * local.home.node_count - 2))
    MAX_RUNNING_BOXES = tostring(12 * local.home.node_count - 2)
  }
}
resource "aws_ecs_task_definition" "edge" {
  family                   = "${local.name}-edge"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = var.exec_role.arn
  task_role_arn            = aws_iam_role.edge.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([
    {
      name         = "oauth2-proxy"
      image        = "quay.io/oauth2-proxy/oauth2-proxy:v7.9.0"
      essential    = true
      portMappings = [{ containerPort = 4180, protocol = "tcp" }]
      command = [
        "--provider=oidc", "--oidc-issuer-url=${local.supabase_url}/auth/v1",
        "--redirect-url=${local.oauth_redirect_url}", "--scope=openid email", "--code-challenge-method=S256",
        "--cookie-secure=true", "--cookie-samesite=lax", "--cookie-csrf-per-request=true", "--cookie-csrf-expire=10m",
        # One sign-in for the approve page and project boxes; the edge never forwards these cookies to a box.
        "--cookie-name=${var.signin_cookie_name}", "--cookie-domain=.${local.public_host}", "--whitelist-domain=.${local.public_host}",
        "--reverse-proxy=true", "--pass-user-headers=true", "--skip-provider-button=true", "--email-domain=*",
        "--upstream=http://127.0.0.1:8080", "--http-address=0.0.0.0:4180",
        "--upstream-timeout=120s", # a first visit creates the box and restores its backup before answering
        # The Supabase sign-in page and its scripts (edge authUi), for visitors not signed in yet. v7.9 matches the
        # request URI with its query; the edge serves exactly these GETs on the approve host and redirects the page there.
        # oauth2-proxy also skips sign-in for any GET whose client-sent X-Forwarded-Uri matches a route, in later versions
        # too: the ALB rule x_forwarded_uri refuses that header and the edge does as well. On every route oauth2-proxy
        # strips client identity headers (set explicitly here) and sets X-Forwarded-Email only from a session; the edge
        # treats a request without it as signed out. Who may enter is decided in the edge (admitted()), never by these flags.
        "--skip-auth-route=GET=^/oauth/consent([?].*)?$", "--skip-auth-route=GET=^/auth-ui/(supabase|config|consent)[.]js$",
        "--skip-auth-strip-headers=true",
      ]
      secrets          = [for k, p in local.proxy_ssm : { name = k, valueFrom = "${local.ssm}/${p}" }]
      logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.edge.name, awslogs-region = local.region, awslogs-stream-prefix = "oauth2-proxy" } }
    },
    {
      name         = "edge"
      image        = "${var.ecr}/edge:${var.edge_tag}"
      essential    = true
      portMappings = [{ containerPort = 8081, protocol = "tcp" }]
      environment = [for k, v in merge(var.cells_enabled ? tomap(local.cells_env) : tomap(local.single_cell_env), {
        PUBLIC_HOST       = local.public_host
        LLM_HOST          = local.llm_host
        BOX_EGRESS_IPS    = join(",", var.box_egress_ips)
        LISTEN_HOST       = "127.0.0.1"
        MODEL_LISTEN_HOST = "0.0.0.0"
        AWS_REGION        = local.region
        PAUSE_IDLE        = "false" # boxes stay running (founder, 2026-11-09); cost work later
        PROJECT_DOMAIN    = local.project_domain
        SUPABASE_URL      = local.supabase_url
        SUPABASE_ANON_KEY = local.supabase_publishable_key
        # The sign-in page consents only for this client (MUMBO_OAUTH_CLIENT_IDS, below) and redirect URI.
        MUMBO_OAUTH_REDIRECT_URIS = local.oauth_redirect_url
        SIGNIN_COOKIE             = var.signin_cookie_name
        PLACEMENT_CACHE_MS        = tostring(var.placement_cache_ms)
        # Project boxes: the mumbo-project template (8192 MB, 4 vCPU; superagent, gh, no desktop), built 2026-11-10 from
        # mumbo-web-prod:prod-546f42d7fb (RUNBOOK "Rebuild the box template").
        PROJECT_TEMPLATE = "mumbo-project"
        # Approvals.
        APPROVE_HOST         = local.approve_host
        APPROVER_EMAILS      = var.approver_emails
        GITHUB_AGENT_LOGIN   = var.github_agent_login
        GITHUB_AGENT_ID      = var.github_agent_id
        REQUIRED_CHECKS      = "static,unit"
        DAILY_TOKENS_USER    = "20000000"
        DAILY_TOKENS_PROJECT = "50000000"
        AUDIT_PREFIX         = local.audit_prefix
        OPENROUTER_MODELS    = var.openrouter_models
        OPENROUTER_ZDR       = tostring(var.openrouter_zdr)
        # Person boxes created afterwards start new Sessions in Run Wild (RUNBOOK "Run Wild").
        RUN_WILD_DEFAULT_EMAILS = var.run_wild_default_emails
      }) : { name = k, value = v }]
      secrets = concat([for k, p in local.edge_ssm : { name = k, valueFrom = "${local.ssm}/${p}" }], [for k, arn in local.edge_secrets : { name = k, valueFrom = arn }],
        [for k, arn in local.e2b_keys : { name = k, valueFrom = "${arn}:TEAM_API_KEY::" }], [
        # By full us-east-1 ARN, which ECS reads from any region.
        { name = "EDGE_SECRET", valueFrom = var.edge_secret_arn },
        { name = "MODEL_KEY", valueFrom = var.model_key_secret_arn },
        { name = "REDIS_URL", valueFrom = "${var.store_secret_arn}:url::" },
        { name = "GITHUB_APP_ID", valueFrom = "${data.aws_secretsmanager_secret.github_app.arn}:app_id::" },
        { name = "GITHUB_APP_KEY", valueFrom = "${data.aws_secretsmanager_secret.github_app.arn}:private_key::" },
      ])
      stopTimeout      = 60
      logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.edge.name, awslogs-region = local.region, awslogs-stream-prefix = "edge" } }
    },
  ])
}
resource "aws_ecs_service" "edge" {
  name                               = "edge"
  cluster                            = var.ecs_cluster_id
  task_definition                    = aws_ecs_task_definition.edge.arn
  desired_count                      = 2
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = var.private_subnets
    security_groups = [var.edge_security_group_id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.edge["user"].arn
    container_name   = "oauth2-proxy"
    container_port   = 4180
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.edge["model"].arn
    container_name   = "edge"
    container_port   = 8081
  }
  # The exec role's grant first: a task whose secrets it may not read does not start.
  depends_on = [aws_lb_listener_rule.edge, aws_iam_role_policy.exec_edge]
}

output "edge_alb" { value = { dns_name = aws_lb.edge.dns_name, zone_id = aws_lb.edge.zone_id, arn_suffix = aws_lb.edge.arn_suffix } }
# Every public name the certificate covers; the root points each at the ALB.
output "public_names" { value = concat([local.public_host], local.llm_hosts, local.old_hosts, local.wildcards, ["*.${local.old_host}"]) }
output "domain_validation_options" { value = aws_acm_certificate.edge.domain_validation_options }
output "role_arn" { value = aws_iam_role.edge.arn }
output "log_group" { value = aws_cloudwatch_log_group.edge.name }
output "target_groups" { value = { for k, v in aws_lb_target_group.edge : k => v.arn_suffix } }
output "service_id" { value = aws_ecs_service.edge.id }
