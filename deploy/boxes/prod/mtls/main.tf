# Private CA and one leaf per E2B service for mutual TLS (PRODUCTION.md stage 3). Pure `tls` provider, so
# check.sh can issue the same certificates locally. Keys live in Terraform state, as the MemoryDB password does.
# ponytail: CA key in state; move to ACM Private CA ($400/month) if the CA must be non-exportable.
terraform {
  required_providers { tls = { source = "hashicorp/tls", version = "~> 4.0" } }
}

variable "trust_domain" { type = string }
variable "services" { type = list(string) }

resource "tls_private_key" "ca" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}
resource "tls_self_signed_cert" "ca" {
  private_key_pem = tls_private_key.ca.private_key_pem
  subject { common_name = "${var.trust_domain} CA" }
  is_ca_certificate     = true
  validity_period_hours = 24 * 365 * 10
  allowed_uses          = ["cert_signing", "crl_signing"]
}

resource "tls_private_key" "leaf" {
  for_each    = toset(var.services)
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}
resource "tls_cert_request" "leaf" {
  for_each        = toset(var.services)
  private_key_pem = tls_private_key.leaf[each.key].private_key_pem
  subject { common_name = each.key }
  # E2B admits a peer by exactly one spiffe URI SAN; peers are dialled by IP, so no DNS SAN is checked.
  uris = ["spiffe://${var.trust_domain}/${each.key}"]
}
resource "tls_locally_signed_cert" "leaf" {
  for_each              = toset(var.services)
  cert_request_pem      = tls_cert_request.leaf[each.key].cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 24 * 365
  # An apply in the last 60 days re-issues; E2B re-reads the files every minute.
  early_renewal_hours = 24 * 60
  allowed_uses        = ["digital_signature", "key_agreement", "server_auth", "client_auth"]
}

output "ca_pem" { value = tls_self_signed_cert.ca.cert_pem }
output "leaves" {
  sensitive = true
  value = { for s in var.services : s => {
    crt = tls_locally_signed_cert.leaf[s].cert_pem
    key = tls_private_key.leaf[s].private_key_pem
    id  = "spiffe://${var.trust_domain}/${s}"
  } }
}
