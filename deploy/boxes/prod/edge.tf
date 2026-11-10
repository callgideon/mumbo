# Stage 6: the edge on Fargate behind a public ALB.
#   app.mumbo.si        -> oauth2-proxy :4180 (Supabase sign-in) -> edge :8080 (loopback)
#   *.app.mumbo.si      -> the same; the edge serves approve.app.mumbo.si and project boxes p-<16 hex>.app.mumbo.si, 404 otherwise
#   llm.app.mumbo.si    -> edge model host :8081 (box token + source address = one of our NAT EIPs); llm.boxes.mumbo.si too
#   boxes.mumbo.si (the former public host), api.mumbo.si and *.boxes.mumbo.si -> redirect (old_hosts rules)
# The edge itself is modules/edge; here are its settings and what every region's edge shares: the public records and
# the SSM parameters.
variable "edge_tag" {
  description = "Edge image tag in ECR (mumbo repo commit)."
  type        = string
}
variable "approver_emails" {
  description = "APPROVER_EMAILS: who may merge agent PRs and bind repositories (comma-separated, lowercased). Empty: nobody."
  type        = string
  default     = ""
}
# Optional edge secrets: the task references an SSM parameter, and the exec role may read it, only when enabled. Create
# the parameter first; a task whose parameter is missing does not start.
variable "ntfy_enabled" {
  description = "Pass /mumbo/boxes/ntfy-topic to the edge as NTFY_TOPIC."
  type        = bool
  default     = false
}
variable "github_agent_login" {
  description = "GITHUB_AGENT_LOGIN: the agent's GitHub login, the mumbo-bot App's bot user mumbo-bot[bot]. Set with github_agent_id."
  type        = string
  default     = ""
}
variable "openrouter_models" {
  description = "OPENROUTER_MODELS: the OpenRouter model ids boxes may call through the model host's /openrouter/v1 route, comma-separated. Empty: the route is off and the edge reads no OpenRouter key."
  type        = string
  default     = "qwen/qwen3.8-27b,qwen/qwen3.5-9b"
}
variable "openrouter_zdr" {
  description = "OPENROUTER_ZDR: OpenRouter routes only to zero-data-retention endpoints. false also allows endpoints that retain prompts; none may train on them (data_collection deny, always)."
  type        = bool
  default     = true
}
variable "github_agent_id" {
  description = "GITHUB_AGENT_ID: the numeric user id of github_agent_login (GET /users/mumbo-bot%5Bbot%5D); approvals match the agent by it. Empty: the approvals poller is off."
  type        = string
  default     = ""
  validation {
    # The edge's config() check: both or neither, and a positive integer.
    condition     = can(regex("^([1-9][0-9]*)?$", var.github_agent_id)) && (var.github_agent_id == "") == (var.github_agent_login == "")
    error_message = "github_agent_id must be a numeric GitHub user id, set together with github_agent_login (or both empty)."
  }
}
variable "signin_cookie_name" {
  description = "oauth2-proxy's --cookie-name and the edge's SIGNIN_COOKIE: the edge drops every cookie whose name starts with it from box requests and box Set-Cookie. It starts with _oauth2_proxy_, a prefix every edge image strips."
  type        = string
  default     = "_oauth2_proxy_mumbo"
  validation {
    # The edge's SIGNIN_COOKIE check (edge.mjs cookieName): RFC 9110 token characters.
    condition     = can(regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", var.signin_cookie_name))
    error_message = "signin_cookie_name must be a cookie name: one or more RFC 9110 token characters."
  }
  validation {
    condition     = startswith(var.signin_cookie_name, "_oauth2_proxy_")
    error_message = "signin_cookie_name must start with _oauth2_proxy_: during a rollout or rollback, old edge tasks strip only their own SIGNIN_COOKIE and the _oauth2_proxy prefix, so any other name reaches boxes through them. Exactly _oauth2_proxy is the old host-only cookie's name."
  }
}

module "edge_us_east_1" {
  source = "./modules/edge"

  name                  = local.name
  edge_tag              = var.edge_tag
  approver_emails       = var.approver_emails
  ntfy_enabled          = var.ntfy_enabled
  github_agent_login    = var.github_agent_login
  github_agent_id       = var.github_agent_id
  openrouter_models     = var.openrouter_models
  openrouter_zdr        = var.openrouter_zdr
  signin_cookie_name    = var.signin_cookie_name
  node_count            = var.node_count
  ecr                   = local.ecr
  cert_validation_fqdns = [for r in aws_route53_record.cert : r.fqdn]

  vpc_id                 = module.cell_us_east_1.vpc_id
  public_subnets         = module.cell_us_east_1.public_subnets
  private_subnets        = module.cell_us_east_1.private_subnets
  box_egress_ips         = module.cell_us_east_1.nat_egress_ips
  ecs_cluster_id         = module.cell_us_east_1.ecs_cluster.id
  exec_role              = module.cell_us_east_1.exec_role
  edge_security_group_id = module.cell_us_east_1.edge_security_group_id
  data_security_group_id = module.cell_us_east_1.data_security_group_id
  data_kms_key_arn       = module.cell_us_east_1.data_kms_key_arn
  backup_bucket          = module.cell_us_east_1.backup_bucket
  backups_kms_key_arn    = module.cell_us_east_1.backups_kms_key_arn
  e2b_secret_arn         = module.cell_us_east_1.e2b_secret_arn
  e2b_api_url            = module.cell_us_east_1.e2b_api_url
  e2b_sandbox_url        = module.cell_us_east_1.e2b_sandbox_url
}

data "aws_route53_zone" "public" { name = "mumbo.si" }
resource "aws_route53_record" "cert" {
  # *.X validates with X's record. Keyed by the domain without "*.": record names are unknown until a new certificate exists.
  for_each = { for o in module.edge_us_east_1.domain_validation_options : trimprefix(o.domain_name, "*.") => o... }
  zone_id  = data.aws_route53_zone.public.zone_id
  name     = each.value[0].resource_record_name
  type     = each.value[0].resource_record_type
  records  = [each.value[0].resource_record_value]
  ttl      = 300
  # app/api validation records already exist from the old CDK certificate; ACM reuses one record per name.
  allow_overwrite = true
}

# Public names on the ALB. They replace the trial's A records (allow_overwrite); the trial no longer manages them.
resource "aws_route53_record" "public" {
  for_each        = toset(module.edge_us_east_1.public_names)
  zone_id         = data.aws_route53_zone.public.zone_id
  name            = each.key
  type            = "A"
  allow_overwrite = true
  alias {
    name                   = module.edge_us_east_1.edge_alb.dns_name
    zone_id                = module.edge_us_east_1.edge_alb.zone_id
    evaluate_target_health = false
  }
}

# The edge's settings in SSM; values are managed outside Terraform (edit the allowlist in SSM, then restart the edge
# tasks). The secrets were generated by the trial and are kept as they are (box tokens and
# oauth2-proxy cookies are signed with them); a fresh install sets them by hand, like the OAuth client
# (/mumbo/boxes/oauth-client-{id,secret}, created in Supabase with redirect https://app.mumbo.si/oauth2/callback).
resource "aws_ssm_parameter" "edge" {
  for_each = { "allowed-emails" = "String", "edge-secret" = "SecureString", "cookie-secret" = "SecureString" }
  name     = "/mumbo/boxes/${each.key}"
  type     = each.value
  value    = each.key == "allowed-emails" ? "@mumbo.si,@cambrialabs.ai" : "set outside Terraform"
  lifecycle { ignore_changes = [value] }
}

output "edge_alb" { value = module.edge_us_east_1.edge_alb.dns_name }
output "edge_redis_endpoint" { value = module.edge_us_east_1.edge_redis_endpoint }
