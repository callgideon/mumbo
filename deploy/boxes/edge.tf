# The edge beside E2B on the trial host: per-user box backups, the host's permissions to read edge settings and
# the model key, the two public names, and :80/:443 for Caddy. The edge itself is installed by edge/up.sh.

variable "public_host" {
  type    = string
  default = "boxes.mumbo.si"
}
variable "llm_host" {
  type    = string
  default = "llm.boxes.mumbo.si"
}
variable "allowed_emails" {
  description = "Who gets a box: addresses or @domains, comma-separated."
  type        = string
  default     = "@mumbo.si,@cambrialabs.ai"
}
variable "acme_email" {
  type    = string
  default = "ops@mumbo.si"
}

locals {
  host_ip = regex("//([0-9.]+):", module.e2b.api_url)[0]
  tags    = { project = "mumbo", component = "boxes", stage = "trial" }
}

data "aws_caller_identity" "this" {}
data "aws_route53_zone" "mumbo" { name = "mumbo.si" }
data "aws_security_group" "host" {
  name       = "mumbo-boxes-trial"
  depends_on = [module.e2b]
}

# ---- backups: one object per user, older versions kept 30 days.
resource "aws_s3_bucket" "backup" {
  bucket = "mumbo-boxes-backup-${data.aws_caller_identity.this.account_id}"
  tags   = local.tags
}
resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}

# ---- settings and secrets the edge reads at start (edge/up.sh). The OAuth client id/secret are created by hand in
# Supabase (redirect https://<public_host>/oauth2/callback) and put under /mumbo/boxes/oauth-client-{id,secret}.
resource "random_password" "edge_secret" {
  length  = 48
  special = false
}
resource "random_password" "cookie_secret" {
  length  = 32
  special = false
}
locals {
  params = {
    "public-host"    = { value = var.public_host, secure = false }
    "llm-host"       = { value = var.llm_host, secure = false }
    "acme-email"     = { value = var.acme_email, secure = false }
    "allowed-emails" = { value = var.allowed_emails, secure = false }
    "egress-ips"     = { value = local.host_ip, secure = false }
    "backup-bucket"  = { value = aws_s3_bucket.backup.bucket, secure = false }
    "e2b-api-key"    = { value = module.e2b.e2b_api_key, secure = true }
    "edge-secret"    = { value = random_password.edge_secret.result, secure = true }
    "cookie-secret"  = { value = random_password.cookie_secret.result, secure = true }
  }
}
resource "aws_ssm_parameter" "edge" {
  for_each = local.params
  name     = "/mumbo/boxes/${each.key}"
  type     = each.value.secure ? "SecureString" : "String"
  value    = each.value.value
  tags     = local.tags
}

# ---- what the host may do for the edge.
resource "aws_iam_role_policy" "edge" {
  name = "mumbo-boxes-edge"
  role = "mumbo-boxes-trial"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Backups", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = ["${aws_s3_bucket.backup.arn}/users/*"] },
      { Sid = "BackupLookup", Effect = "Allow", Action = ["s3:ListBucket"], Resource = [aws_s3_bucket.backup.arn] },
      { Sid = "EdgeSettings", Effect = "Allow", Action = ["ssm:GetParameter"], Resource = ["arn:aws:ssm:us-east-1:${data.aws_caller_identity.this.account_id}:parameter/mumbo/boxes/*"] },
      { Sid = "ModelKey", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = ["arn:aws:secretsmanager:us-east-1:${data.aws_caller_identity.this.account_id}:secret:mumbo/prod/deepseek-api-key*"] },
    ]
  })
  depends_on = [module.e2b]
}

# ---- public entry: Caddy answers ACME on :80 and serves both names on :443.
resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each          = toset(["80", "443"])
  security_group_id = data.aws_security_group.host.id
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = "0.0.0.0/0"
  description       = "edge ${each.key}"
}
resource "aws_route53_record" "edge" {
  for_each = toset([var.public_host, var.llm_host])
  zone_id  = data.aws_route53_zone.mumbo.zone_id
  name     = each.key
  type     = "A"
  ttl      = 300
  records  = [local.host_ip]
}

output "edge_url" { value = "https://${var.public_host}" }
