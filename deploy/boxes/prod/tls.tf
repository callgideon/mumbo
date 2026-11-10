# Stage 3: mutual TLS between E2B's parts, one CA for every cell. Each service's certificate, key and the CA go to one
# Secrets Manager secret per cell (modules/cell/secrets.tf); its host or task writes them to E2B_TLS_{CERT,KEY,CA}_FILE.
# `mtls_env` is each service's E2B_TLS_* env.
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

output "mtls_secret_arns" { value = module.cell_us_east_1.mtls_secret_arns }
output "mtls_env" { value = local.mtls_env }
