# Stage 5: E2B control plane. api and client-proxy, two Fargate tasks each across AZs, behind one internal NLB:
#   :3000 api HTTP (edge, node drain)   :5009 api internal gRPC, mTLS (client-proxy)   :3002 client-proxy (edge)
# setup (migrations, team, limits) is a one-shot task: run it after a new e2b_sha, before the api deploys.
locals {
  sg = {
    nodes        = aws_security_group.nodes.id
    api          = aws_security_group.api.id
    client_proxy = aws_security_group.client_proxy.id
    edge         = aws_security_group.edge.id
  }
  ecr     = "${data.aws_caller_identity.this.account_id}.dkr.ecr.us-east-1.amazonaws.com/${local.name}"
  e2b_arn = aws_secretsmanager_secret.e2b.arn
  box_ram = 4096
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "E2B api tasks"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_security_group" "client_proxy" {
  name        = "${local.name}-client-proxy"
  description = "E2B client-proxy tasks"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_security_group" "edge" {
  name        = "${local.name}-edge"
  description = "mumbo edge tasks (stage 6)"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_security_group" "nlb" {
  name        = "${local.name}-internal-nlb"
  description = "Internal NLB in front of api and client-proxy"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_vpc_security_group_egress_rule" "all" {
  for_each          = { api = aws_security_group.api.id, client_proxy = aws_security_group.client_proxy.id, edge = aws_security_group.edge.id, nlb = aws_security_group.nlb.id }
  security_group_id = each.value
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
resource "aws_vpc_security_group_ingress_rule" "control" {
  for_each = {
    nlb-3000-edge  = [aws_security_group.nlb.id, aws_security_group.edge.id, 3000]
    nlb-3000-nodes = [aws_security_group.nlb.id, aws_security_group.nodes.id, 3000]
    nlb-5009-cp    = [aws_security_group.nlb.id, aws_security_group.client_proxy.id, 5009]
    nlb-3002-edge  = [aws_security_group.nlb.id, aws_security_group.edge.id, 3002]
    api-3000       = [aws_security_group.api.id, aws_security_group.nlb.id, 3000]
    api-5009       = [aws_security_group.api.id, aws_security_group.nlb.id, 5009]
    cp-3002        = [aws_security_group.client_proxy.id, aws_security_group.nlb.id, 3002]
    cp-3003        = [aws_security_group.client_proxy.id, aws_security_group.nlb.id, 3003]
  }
  security_group_id            = each.value[0]
  referenced_security_group_id = each.value[1]
  ip_protocol                  = "tcp"
  from_port                    = each.value[2]
  to_port                      = each.value[2]
}

# ---- internal NLB
resource "aws_lb" "internal" {
  name                             = "${local.name}-internal"
  internal                         = true
  load_balancer_type               = "network"
  subnets                          = module.vpc.private_subnets
  security_groups                  = [aws_security_group.nlb.id]
  enable_cross_zone_load_balancing = true
}
locals {
  listeners = {
    api-http = { port = 3000, health = { protocol = "HTTP", port = "3000", path = "/health" } }
    api-grpc = { port = 5009, health = { protocol = "HTTP", port = "3000", path = "/health" } }
    proxy    = { port = 3002, health = { protocol = "HTTP", port = "3003", path = "/" } }
  }
}
resource "aws_lb_target_group" "control" {
  for_each             = local.listeners
  name                 = "${local.name}-${each.key}"
  port                 = each.value.port
  protocol             = "TCP"
  target_type          = "ip"
  vpc_id               = module.vpc.vpc_id
  deregistration_delay = 60
  health_check {
    protocol            = each.value.health.protocol
    port                = each.value.health.port
    path                = each.value.health.path
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}
resource "aws_lb_listener" "control" {
  for_each          = local.listeners
  load_balancer_arn = aws_lb.internal.arn
  port              = each.value.port
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control[each.key].arn
  }
}

# ---- ECS
resource "aws_ecs_cluster" "e2b" {
  name = "${local.name}-e2b"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
resource "aws_cloudwatch_log_group" "e2b" {
  for_each          = toset(["api", "client-proxy", "setup"])
  name              = "/${local.name}/${each.key}"
  retention_in_days = 30
}
resource "aws_iam_role" "exec" {
  name               = "${local.name}-ecs-exec"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ecs-tasks.amazonaws.com" } }] })
}
resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "exec" {
  role = aws_iam_role.exec.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = concat([local.e2b_arn], [for s in aws_secretsmanager_secret.mtls : s.arn]) },
    { Effect = "Allow", Action = "kms:Decrypt", Resource = aws_kms_key.data.arn },
  ] })
}

locals {
  secret = { for k in ["POSTGRES_CONNECTION_STRING", "REDIS_CLUSTER_URL", "ADMIN_TOKEN", "SANDBOX_ACCESS_TOKEN_HASH_SEED", "TEAM_API_KEY"] : k => "${local.e2b_arn}:${k}::" }
  # The mTLS files: an entrypoint writes the secret's PEMs to the default paths E2B reads.
  tls_wrap   = "mkdir -p /var/run/e2b/tls /var/run/e2b/trust && printf %s \"$MTLS_CRT\" > /var/run/e2b/tls/tls.crt && printf %s \"$MTLS_KEY\" > /var/run/e2b/tls/tls.key && printf %s \"$MTLS_CA\" > /var/run/e2b/trust/ca.crt && unset MTLS_CRT MTLS_KEY MTLS_CA && exec \"$@\""
  common_env = { ENVIRONMENT = "prod", AWS_REGION = "us-east-1", E2B_TLS_CERT_FILE = "/var/run/e2b/tls/tls.crt", E2B_TLS_KEY_FILE = "/var/run/e2b/tls/tls.key", E2B_TLS_CA_FILE = "/var/run/e2b/trust/ca.crt" }
  services = {
    api = {
      image   = "${local.ecr}/e2b-api:${var.e2b_sha}"
      command = ["./api", "--port", "3000"]
      cpu     = 1024
      memory  = 2048
      ports   = [3000, 5009]
      tgs     = { api-http = 3000, api-grpc = 5009 }
      env = merge(local.common_env, local.mtls_env.api, {
        NODE_ID                    = "api"
        SERVICE_DISCOVERY_PROVIDER = "dns"
        ORCHESTRATOR_DNS_NAME      = local.orch_dns
        TEMPLATE_BUILDER_DNS_NAME  = local.orch_dns
        ORCHESTRATOR_DNS_PORT      = "5008"
        API_INTERNAL_GRPC_PORT     = "5009"
        VOLUME_TOKEN_ENABLED       = "false"
        # The api refuses to start without a log store, but only API reads of sandbox and build logs use it; the
        # edge reads none. ponytail: unreachable Loki; add ClickHouse (CLICKHOUSE_CONNECTION_STRING) when those reads matter.
        LOKI_URL                    = "http://127.0.0.1:3100"
        AUTH_PROVIDER_CONFIG        = "{\"jwt\":[]}"
        PAUSE_REFUSAL_RESTORE       = "true"
        DEFAULT_KERNEL_VERSION      = local.kernel
        DEFAULT_FIRECRACKER_VERSION = local.firecracker
      })
      secrets = { for k in ["POSTGRES_CONNECTION_STRING", "REDIS_CLUSTER_URL", "ADMIN_TOKEN", "SANDBOX_ACCESS_TOKEN_HASH_SEED"] : k => local.secret[k] }
      mtls    = "api"
    }
    client-proxy = {
      image   = "${local.ecr}/e2b-client-proxy:${var.e2b_sha}"
      command = ["./client-proxy"]
      cpu     = 1024
      memory  = 2048
      ports   = [3002, 3003]
      tgs     = { proxy = 3002 }
      env = merge(local.common_env, local.mtls_env.client-proxy, {
        NODE_ID                   = "client-proxy"
        PROXY_PORT                = "3002"
        HEALTH_PORT               = "3003"
        API_INTERNAL_GRPC_ADDRESS = "${aws_lb.internal.dns_name}:5009"
      })
      secrets = { REDIS_CLUSTER_URL = local.secret.REDIS_CLUSTER_URL }
      mtls    = "client-proxy"
    }
  }
}

resource "aws_ecs_task_definition" "e2b" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.exec.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name         = each.key
    image        = each.value.image
    essential    = true
    entryPoint   = ["/bin/sh", "-c", local.tls_wrap, "sh"]
    command      = each.value.command
    portMappings = [for p in each.value.ports : { containerPort = p, protocol = "tcp" }]
    environment  = [for k, v in each.value.env : { name = k, value = v }]
    secrets = concat([for k, v in each.value.secrets : { name = k, valueFrom = v }], [
      for f in ["crt", "key", "ca"] : { name = "MTLS_${upper(f)}", valueFrom = "${aws_secretsmanager_secret.mtls[each.value.mtls].arn}:${f}::" }
    ])
    stopTimeout      = 90
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.e2b[each.key].name, awslogs-region = "us-east-1", awslogs-stream-prefix = each.key } }
  }])
}

resource "aws_ecs_service" "e2b" {
  for_each               = local.services
  name                   = each.key
  cluster                = aws_ecs_cluster.e2b.id
  task_definition        = aws_ecs_task_definition.e2b[each.key].arn
  desired_count          = 2
  launch_type            = "FARGATE"
  enable_execute_command = false
  # Rolling: a new task registers and passes health before an old one drains (E2B's api and proxy are stateless).
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  health_check_grace_period_seconds = 120
  network_configuration {
    subnets         = module.vpc.private_subnets
    security_groups = [local.sg[replace(each.key, "-", "_")]]
  }
  dynamic "load_balancer" {
    for_each = each.value.tgs
    content {
      target_group_arn = aws_lb_target_group.control[load_balancer.key].arn
      container_name   = each.key
      container_port   = load_balancer.value
    }
  }
  depends_on = [aws_lb_listener.control]
}

# ---- setup: run with `aws ecs run-task` (setup/run.sh) after a new e2b_sha and before the services roll.
resource "aws_ecs_task_definition" "setup" {
  family                   = "${local.name}-setup"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([{
    name             = "setup"
    image            = "${local.ecr}/e2b-setup:${var.e2b_sha}-${substr(sha256("${file("${path.module}/setup/Dockerfile")}${file("${path.module}/setup/setup.sh")}"), 0, 7)}"
    essential        = true
    environment      = [{ name = "BOX_RAM_MB", value = tostring(local.box_ram) }]
    secrets          = [for k in ["POSTGRES_CONNECTION_STRING", "TEAM_API_KEY"] : { name = k, valueFrom = local.secret[k] }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.e2b["setup"].name, awslogs-region = "us-east-1", awslogs-stream-prefix = "setup" } }
  }])
}

output "internal_nlb" { value = aws_lb.internal.dns_name }
output "setup_run" {
  value = "aws ecs run-task --cluster ${aws_ecs_cluster.e2b.name} --task-definition ${aws_ecs_task_definition.setup.family} --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[${module.vpc.private_subnets[0]}],securityGroups=[${aws_security_group.api.id}]}'"
}
