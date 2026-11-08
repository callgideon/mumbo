# Week-1 trial of the per-user box platform: E2B Embed (Firecracker, single node) on one nested-virtualization
# m8i.xlarge in its own VPC in us-east-1. Nothing peers with the account's other VPCs.
# The ref pins e2b-dev/runtime main; upgrading is a deliberate change of it.
terraform {
  backend "s3" {
    bucket       = "mumbo-tfstate-641134885443"
    key          = "boxes/trial.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "client_cidrs" {
  description = "IPv4 CIDRs that may reach the E2B API, dashboard and sandbox proxy."
  type        = list(string)
}

module "e2b" {
  source       = "github.com/e2b-dev/runtime//embed/terraform/aws?ref=aa7739834e3e3384c8fd1a526adf251c7751d76d"
  name         = "mumbo-boxes-trial"
  client_cidrs = var.client_cidrs
  # 8 GiB of the 16 GiB host for guest memory; 11 GiB starved the host's own memory once ~20 VMs ran.
  hugepages = 4096
  tags         = { project = "mumbo", component = "boxes", stage = "trial" }
}

output "api_url" { value = module.e2b.api_url }
output "sandbox_url" { value = module.e2b.sandbox_url }
output "dashboard_url" { value = module.e2b.dashboard_url }
output "session_command" { value = module.e2b.session_command }
output "e2b_api_key" {
  value     = module.e2b.e2b_api_key
  sensitive = true
}
