# Stage 6: the edge on Fargate behind a public ALB.
#   boxes.mumbo.si      -> oauth2-proxy :4180 (Supabase sign-in, same client and callback as the trial) -> edge :8080 (loopback)
#   llm.boxes.mumbo.si  -> edge model host :8081 (box token + source address = one of our NAT EIPs)
# The edge reaches E2B by private names on the internal NLB; client-proxy header routing needs sandbox.<domain>.
variable "edge_tag" {
  description = "Edge image tag in ECR (mumbo repo commit)."
  type        = string
}

locals {
  public_host  = "boxes.mumbo.si"
  llm_host     = "llm.boxes.mumbo.si"
  backup_store = "mumbo-boxes-backup-${data.aws_caller_identity.this.account_id}" # created by the trial (../edge.tf); users' backups carry over
  # The shared Fargate server's names; they redirect here since it was retired (2026-11-09).
  old_hosts = ["app.mumbo.si", "api.mumbo.si"]
}

resource "aws_route53_record" "internal" {
  for_each = toset(["api", "sandbox"])
  zone_id  = aws_route53_zone.internal.zone_id
  name     = "${each.key}.boxes.internal"
  type     = "A"
  alias {
    name                   = aws_lb.internal.dns_name
    zone_id                = aws_lb.internal.zone_id
    evaluate_target_health = false
  }
}

# ---- certificate and public ALB
data "aws_route53_zone" "public" { name = "mumbo.si" }
resource "aws_acm_certificate" "edge" {
  domain_name               = local.public_host
  subject_alternative_names = concat([local.llm_host], local.old_hosts)
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_route53_record" "cert" {
  for_each = { for o in aws_acm_certificate.edge.domain_validation_options : o.domain_name => o }
  zone_id  = data.aws_route53_zone.public.zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  records  = [each.value.resource_record_value]
  ttl      = 300
  # app/api validation records already exist from the old CDK certificate; ACM reuses one record per name.
  allow_overwrite = true
}
resource "aws_acm_certificate_validation" "edge" {
  certificate_arn         = aws_acm_certificate.edge.arn
  validation_record_fqdns = [for r in aws_route53_record.cert : r.fqdn]
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ALB for the edge"
  vpc_id      = module.vpc.vpc_id
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
  security_group_id            = aws_security_group.edge.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = each.key
  to_port                      = each.key
}

resource "aws_lb" "edge" {
  name                       = "${local.name}-edge"
  load_balancer_type         = "application"
  subnets                    = module.vpc.public_subnets
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
  vpc_id               = module.vpc.vpc_id
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
  for_each     = { user = [10, local.public_host], model = [20, local.llm_host] }
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value[0]
  condition {
    host_header { values = [each.value[1]] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.edge[each.key].arn
  }
}
resource "aws_lb_listener_rule" "old_hosts" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 5
  condition {
    host_header { values = local.old_hosts }
  }
  action {
    type = "redirect"
    redirect {
      host        = local.public_host
      port        = "443"
      protocol    = "HTTPS"
      path        = "/#{path}"
      query       = "#{query}"
      status_code = "HTTP_301"
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
resource "aws_iam_role_policy" "edge" {
  role = aws_iam_role.edge.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "arn:aws:s3:::${local.backup_store}/users/*" },
    { Effect = "Allow", Action = "s3:ListBucket", Resource = "arn:aws:s3:::${local.backup_store}" },
    { Effect = "Allow", Action = "ssm:GetParameter", Resource = "arn:aws:ssm:us-east-1:${data.aws_caller_identity.this.account_id}:parameter/mumbo/boxes/edge-secret" },
    { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = "arn:aws:secretsmanager:us-east-1:${data.aws_caller_identity.this.account_id}:secret:mumbo/prod/deepseek-api-key-*" },
  ] })
}
resource "aws_iam_role_policy" "exec_edge" {
  role = aws_iam_role.exec.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "ssm:GetParameters", Resource = "arn:aws:ssm:us-east-1:${data.aws_caller_identity.this.account_id}:parameter/mumbo/boxes/*" },
  ] })
}

locals {
  ssm = "arn:aws:ssm:us-east-1:${data.aws_caller_identity.this.account_id}:parameter/mumbo/boxes"
}
resource "aws_ecs_task_definition" "edge" {
  family                   = "${local.name}-edge"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.exec.arn
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
        "--provider=oidc", "--oidc-issuer-url=https://qkvcouccrhyjiarkauyo.supabase.co/auth/v1",
        "--redirect-url=https://${local.public_host}/oauth2/callback", "--scope=openid email", "--code-challenge-method=S256",
        "--cookie-secure=true", "--cookie-samesite=lax", "--cookie-csrf-per-request=true", "--cookie-csrf-expire=10m",
        "--reverse-proxy=true", "--pass-user-headers=true", "--skip-provider-button=true", "--email-domain=*",
        "--upstream=http://127.0.0.1:8080", "--http-address=0.0.0.0:4180",
        "--upstream-timeout=120s", # a first visit creates the box and restores its backup before answering
      ]
      secrets = [
        { name = "OAUTH2_PROXY_CLIENT_ID", valueFrom = "${local.ssm}/oauth-client-id" },
        { name = "OAUTH2_PROXY_CLIENT_SECRET", valueFrom = "${local.ssm}/oauth-client-secret" },
        { name = "OAUTH2_PROXY_COOKIE_SECRET", valueFrom = "${local.ssm}/cookie-secret" },
      ]
      logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.edge.name, awslogs-region = "us-east-1", awslogs-stream-prefix = "oauth2-proxy" } }
    },
    {
      name         = "edge"
      image        = "${local.ecr}/edge:${var.edge_tag}"
      essential    = true
      portMappings = [{ containerPort = 8081, protocol = "tcp" }]
      environment = [for k, v in {
        PUBLIC_HOST       = local.public_host
        LLM_HOST          = local.llm_host
        BACKUP_BUCKET     = local.backup_store
        BOX_EGRESS_IPS    = join(",", module.vpc.nat_public_ips)
        E2B_API_URL       = "http://api.boxes.internal:3000"
        E2B_SANDBOX_URL   = "http://sandbox.boxes.internal:3002"
        REDIS_URL         = "rediss://${aws_elasticache_replication_group.edge.primary_endpoint_address}:6379"
        LISTEN_HOST       = "127.0.0.1"
        MODEL_LISTEN_HOST = "0.0.0.0"
        AWS_REGION        = "us-east-1"
        PAUSE_IDLE        = "false" # boxes stay running (founder, 2026-11-09); cost work later
      } : { name = k, value = v }]
      secrets = [
        { name = "ALLOWED_EMAILS", valueFrom = "${local.ssm}/allowed-emails" },
        { name = "E2B_API_KEY", valueFrom = local.secret.TEAM_API_KEY },
      ]
      stopTimeout      = 60
      logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.edge.name, awslogs-region = "us-east-1", awslogs-stream-prefix = "edge" } }
    },
  ])
}
resource "aws_ecs_service" "edge" {
  name                               = "edge"
  cluster                            = aws_ecs_cluster.e2b.id
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
    subnets         = module.vpc.private_subnets
    security_groups = [aws_security_group.edge.id]
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
  depends_on = [aws_lb_listener_rule.edge]
}

output "edge_alb" { value = aws_lb.edge.dns_name }

# Public names on the ALB. They replace the trial's A records (allow_overwrite); the trial no longer manages them.
resource "aws_route53_record" "public" {
  for_each        = toset(concat([local.public_host, local.llm_host], local.old_hosts))
  zone_id         = data.aws_route53_zone.public.zone_id
  name            = each.key
  type            = "A"
  allow_overwrite = true
  alias {
    name                   = aws_lb.edge.dns_name
    zone_id                = aws_lb.edge.zone_id
    evaluate_target_health = false
  }
}
