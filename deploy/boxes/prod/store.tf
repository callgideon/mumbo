# R2 (design section 17c): the edge store, one for every region's edge, in us-east-1. ElastiCache Valkey with TLS and,
# since R2, its own security group and AUTH: it used to sit in the cell's data security group, which admits 6379 from
# the sandbox nodes (for E2B's MemoryDB), with no AUTH, so a box VM behind its node's address could reach it. The edges authenticate as
# the user `edge`; `default` stays open until every edge sends credentials (store_default_open), then is turned off.
# Its own security group: only the edges reach 6379 (R6 adds the Mumbai edge's subnets). The cell's data group admits
# the nodes for MemoryDB, so the store must not sit in it.
resource "aws_security_group" "edge_store" {
  name        = "${local.name}-edge-store"
  description = "Edge store (Valkey): 6379 from the edges only"
  vpc_id      = module.cell_us_east_1.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "edge_store" {
  security_group_id            = aws_security_group.edge_store.id
  referenced_security_group_id = module.cell_us_east_1.edge_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "us-east-1 edge"
}
resource "aws_elasticache_subnet_group" "edge" {
  name       = "${local.name}-edge"
  subnet_ids = module.cell_us_east_1.private_subnets
}

variable "store_default_open" {
  description = "Whether the store's default user still answers without a password: true only while an edge without credentials runs (the R2 rollout)."
  type        = bool
  default     = true
}
resource "random_password" "store" {
  length  = 40
  special = false # it goes into a URL
}
resource "aws_elasticache_user" "edge" {
  user_id       = "${local.name}-edge"
  user_name     = "edge"
  engine        = "redis" # Valkey refuses a no-password user; redis-engine users and groups serve Valkey groups
  access_string = "on ~* &* +@all"
  authentication_mode {
    type      = "password"
    passwords = [random_password.store.result]
  }
}
resource "aws_elasticache_user" "default" {
  user_id       = "${local.name}-default"
  user_name     = "default"
  engine        = "redis"                                                 # Valkey refuses a no-password user; redis-engine users and groups serve Valkey groups
  access_string = var.store_default_open ? "on ~* &* +@all" : "off -@all" # closed: off, no commands
  authentication_mode { type = "no-password-required" }
}
resource "aws_elasticache_user_group" "edge" {
  user_group_id = "${local.name}-edge"
  engine        = "redis" # Valkey refuses a no-password user; redis-engine users and groups serve Valkey groups
  user_ids      = [aws_elasticache_user.default.user_id, aws_elasticache_user.edge.user_id]
}

resource "aws_elasticache_replication_group" "edge" {
  replication_group_id       = "${local.name}-edge"
  description                = "mumbo edge shared state"
  engine                     = "valkey"
  engine_version             = "7.2"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.edge.name
  security_group_ids         = [aws_security_group.edge_store.id]
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  kms_key_id                 = module.cell_us_east_1.data_kms_key_arn
  parameter_group_name       = "default.valkey7"
  snapshot_retention_limit   = 3
  user_group_ids             = [aws_elasticache_user_group.edge.user_group_id]
}

# The URL every edge reads as REDIS_URL, replicated to each other edge region.
resource "aws_secretsmanager_secret" "store" {
  name = "${local.name}/edge-store"
  replica { region = "ap-south-1" }
}
resource "aws_secretsmanager_secret_version" "store" {
  secret_id     = aws_secretsmanager_secret.store.id
  secret_string = jsonencode({ url = "rediss://edge:${random_password.store.result}@${aws_elasticache_replication_group.edge.primary_endpoint_address}:6379" })
}
