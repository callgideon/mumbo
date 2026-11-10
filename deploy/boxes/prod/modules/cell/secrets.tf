# E2B's own secrets, generated here. One Secrets Manager JSON per consumer group; ECS and the nodes read keys
# from it. The team API key is what the edge and the node drain use against the E2B API.
resource "random_id" "admin_token" { byte_length = 32 }
resource "random_id" "hash_seed" { byte_length = 32 }
resource "random_id" "team_api_key" { byte_length = 20 }

locals {
  team_api_key = "e2b_${random_id.team_api_key.hex}"
  postgres_url = "postgresql://e2b:${random_password.postgres.result}@${aws_db_instance.e2b.address}:5432/e2b?sslmode=require"
  # MemoryDB is a cluster: REDIS_CLUSTER_URL with the ACL user (fork patch 644d3c875); rediss turns TLS on.
  redis_url = "rediss://e2b:${random_password.memorydb.result}@${aws_memorydb_cluster.e2b.cluster_endpoint[0].address}:${aws_memorydb_cluster.e2b.cluster_endpoint[0].port}"
}

resource "aws_secretsmanager_secret" "e2b" {
  name       = "${local.name}/e2b"
  kms_key_id = aws_kms_key.data.arn
}
resource "aws_secretsmanager_secret_version" "e2b" {
  secret_id = aws_secretsmanager_secret.e2b.id
  secret_string = jsonencode({
    POSTGRES_CONNECTION_STRING     = local.postgres_url
    REDIS_CLUSTER_URL              = local.redis_url
    ADMIN_TOKEN                    = random_id.admin_token.hex
    SANDBOX_ACCESS_TOKEN_HASH_SEED = random_id.hash_seed.hex
    TEAM_API_KEY                   = local.team_api_key
  })
}
output "e2b_secret_arn" { value = aws_secretsmanager_secret.e2b.arn }

# Each service's mTLS certificate, key and the CA (issued once for every cell, root tls.tf).
resource "aws_secretsmanager_secret" "mtls" {
  for_each   = var.mtls_env
  name       = "${local.name}/mtls/${each.key}"
  kms_key_id = aws_kms_key.data.arn
}
resource "aws_secretsmanager_secret_version" "mtls" {
  for_each      = var.mtls_env
  secret_id     = aws_secretsmanager_secret.mtls[each.key].id
  secret_string = jsonencode({ crt = var.mtls_certs.leaves[each.key].crt, key = var.mtls_certs.leaves[each.key].key, ca = var.mtls_certs.ca_pem })
}
output "mtls_secret_arns" { value = { for s, v in aws_secretsmanager_secret.mtls : s => v.arn } }
