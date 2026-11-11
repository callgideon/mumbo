# State for the platform. E2B treats Redis as the source of truth for running sandboxes (losing keys kills VMs,
# review B1), so E2B gets MemoryDB (durable multi-AZ log). The edge gets its own ElastiCache: a failover there
# only resets activity timers and budgets (modules/edge).

resource "aws_kms_key" "data" {
  description         = "${local.name} data at rest"
  enable_key_rotation = true
}

resource "aws_security_group" "data" {
  name        = "${local.name}-data"
  description = "Postgres and Redis, reachable only from the platform security groups"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "data" {
  for_each                     = { for p in setproduct(["nodes", "api", "client_proxy", "edge"], [5432, 6379]) : "${p[0]}-${p[1]}" => p }
  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = local.sg[each.value[0]]
  ip_protocol                  = "tcp"
  from_port                    = each.value[1]
  to_port                      = each.value[1]
}

# ---- Postgres for E2B (teams, templates, builds, snapshots). Multi-AZ, 14-day point-in-time recovery.
resource "aws_db_subnet_group" "e2b" {
  name       = "${local.name}-e2b"
  subnet_ids = module.vpc.private_subnets
}
resource "aws_db_instance" "e2b" {
  identifier                   = "${local.name}-e2b"
  engine                       = "postgres"
  engine_version               = "18.6"
  instance_class               = "db.t4g.medium" # resize in place when load grows
  allocated_storage            = 50
  max_allocated_storage        = 500
  storage_type                 = "gp3"
  storage_encrypted            = true
  kms_key_id                   = aws_kms_key.data.arn
  db_name                      = "e2b"
  username                     = "e2b"
  password                     = random_password.postgres.result # one static secret the api and setup read; rotate with an apply
  multi_az                     = !var.lean
  availability_zone            = var.lean ? var.db_availability_zone : null
  db_subnet_group_name         = aws_db_subnet_group.e2b.name
  vpc_security_group_ids       = [aws_security_group.data.id]
  backup_retention_period      = 14
  deletion_protection          = true
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.name}-e2b-final"
  copy_tags_to_snapshot        = true
  performance_insights_enabled = true
  auto_minor_version_upgrade   = true
}

resource "random_password" "postgres" {
  length  = 40
  special = false
}

# ---- MemoryDB for E2B (durable; TLS; ACL user with a generated password).
resource "random_password" "memorydb" {
  length  = 40
  special = false
}
resource "aws_memorydb_user" "e2b" {
  user_name     = "e2b"
  access_string = "on ~* &* +@all"
  authentication_mode {
    type      = "password"
    passwords = [random_password.memorydb.result]
  }
}
resource "aws_memorydb_acl" "e2b" {
  name       = "${local.name}-e2b"
  user_names = [aws_memorydb_user.e2b.user_name]
}
resource "aws_memorydb_subnet_group" "e2b" {
  name       = "${local.name}-e2b"
  subnet_ids = module.vpc.private_subnets
}
resource "aws_memorydb_cluster" "e2b" {
  name                       = "${local.name}-e2b"
  engine                     = "valkey"
  engine_version             = "7.2"
  node_type                  = "db.t4g.medium"
  num_shards                 = 1
  num_replicas_per_shard     = var.lean ? 0 : 1
  acl_name                   = aws_memorydb_acl.e2b.name
  subnet_group_name          = aws_memorydb_subnet_group.e2b.name
  security_group_ids         = [aws_security_group.data.id]
  tls_enabled                = true
  kms_key_arn                = aws_kms_key.data.arn
  snapshot_retention_limit   = 7
  auto_minor_version_upgrade = true
}

# ---- S3: templates and pause snapshots (same bucket layout as E2B). Versioned so an RDS point-in-time restore
# can still find the objects its rows point at (review M4); Bucket Keys avoid one KMS call per ranged GET.
resource "aws_s3_bucket" "templates" { bucket = "${local.name}-templates-${data.aws_caller_identity.this.account_id}" }
resource "aws_s3_bucket_versioning" "templates" {
  bucket = aws_s3_bucket.templates.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "templates" {
  bucket                  = aws_s3_bucket.templates.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "templates" {
  bucket = aws_s3_bucket.templates.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "templates" {
  bucket = aws_s3_bucket.templates.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 14 }
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}

output "postgres_endpoint" { value = aws_db_instance.e2b.address }
output "memorydb_endpoint" { value = "${aws_memorydb_cluster.e2b.cluster_endpoint[0].address}:${aws_memorydb_cluster.e2b.cluster_endpoint[0].port}" }
output "templates_bucket" { value = aws_s3_bucket.templates.bucket }
