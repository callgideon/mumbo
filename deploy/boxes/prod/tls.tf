# Stage 3: mutual TLS between E2B's parts. Each service's certificate, key and the CA go to one Secrets Manager
# secret; its host or task writes them to E2B_TLS_{CERT,KEY,CA}_FILE. `mtls_env` is each service's E2B_TLS_* env.
module "mtls" {
  source       = "./mtls"
  trust_domain = "boxes.internal"
  services     = ["api", "client-proxy", "orchestrator"]
}

locals {
  spiffe = { for s in ["api", "client-proxy", "orchestrator"] : s => "spiffe://boxes.internal/${s}" }
  # `required` on every gRPC port and hop. The api's HTTP port stays off: only the edge calls it, through
  # the private NLB, with the E2B API key. client-proxy -> orchestrator :5007 is sandbox traffic, which
  # E2B does not encrypt; the node security group admits it from client-proxy only.
  mtls_env = {
    api = {
      E2B_TLS_INTERNAL_GRPC_MODE       = "required"
      E2B_TLS_INTERNAL_GRPC_ALLOW      = local.spiffe["client-proxy"]
      E2B_TLS_ORCHESTRATOR_CLIENT_MODE = "on"
      E2B_TLS_ORCHESTRATOR_EXPECT      = local.spiffe.orchestrator
    }
    client-proxy = {
      E2B_TLS_API_CLIENT_MODE = "on"
      E2B_TLS_API_EXPECT      = local.spiffe.api
    }
    orchestrator = {
      E2B_TLS_GRPC_MODE         = "required"
      E2B_TLS_GRPC_ALLOW        = "${local.spiffe.api},${local.spiffe.orchestrator}"
      E2B_TLS_PEERS_CLIENT_MODE = "on"
      E2B_TLS_PEERS_EXPECT      = local.spiffe.orchestrator
    }
  }
}

resource "aws_secretsmanager_secret" "mtls" {
  for_each   = local.spiffe
  name       = "${local.name}/mtls/${each.key}"
  kms_key_id = aws_kms_key.data.arn
}
resource "aws_secretsmanager_secret_version" "mtls" {
  for_each      = local.spiffe
  secret_id     = aws_secretsmanager_secret.mtls[each.key].id
  secret_string = jsonencode({ crt = module.mtls.leaves[each.key].crt, key = module.mtls.leaves[each.key].key, ca = module.mtls.ca_pem })
}

output "mtls_secret_arns" { value = { for s, v in aws_secretsmanager_secret.mtls : s => v.arn } }
output "mtls_env" { value = local.mtls_env }
