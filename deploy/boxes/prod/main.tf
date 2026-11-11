# mumbo boxes, production (PRODUCTION.md). Separate state from the trial in ../main.tf.
# One cell (modules/cell) and one edge (modules/edge) per region (design section 17c); us-east-1 is the only region.
# What every region shares stays here: the mTLS CA (tls.tf), ECR (ecr.tf), alarms (ops.tf), the public records and the
# edge's SSM settings (edge.tf).
terraform {
  required_version = ">= 1.10"
  backend "s3" {
    bucket       = "mumbo-tfstate-641134885443"
    key          = "boxes/prod.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    tls    = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

# The modules take their region from this provider; a second region adds an aliased provider and its own module calls.
provider "aws" {
  region = "us-east-1"
  default_tags { tags = { project = "mumbo", component = "boxes", stage = "prod" } }
}

locals {
  name = "mumbo-boxes"
  # Images we build, pulled by every cell from the registry in this region (ecr.tf).
  ecr = "${split("/", aws_ecr_repository.images["edge"].repository_url)[0]}/${local.name}"
}

data "aws_caller_identity" "this" {}

variable "e2b_sha" {
  description = "Fork commit whose orchestrator and envd the nodes run (setup/build.sh uploads them)."
  type        = string
}

variable "node_count" {
  description = "Sandbox nodes: the ASG desired capacity and the nodes-below-min alarm threshold. The edge cap is MAX_RUNNING_UNITS = 2 * (12 * node_count - 2) capacity units: a 4096 MB person or project box is 2 units (edge/template.mjs memoryMB) and a 2048 MB child sandbox is 1 (the mumbo-child build argument), 12 boxes per node on 48 GiB of guest hugepages, minus 2 boxes of headroom."
  type        = number
  default     = 2
  validation {
    condition     = floor(var.node_count) == var.node_count && var.node_count >= 1 && var.node_count <= 10
    error_message = "node_count must be a whole number from 1 to 10 (the node group's max_size)."
  }
}

module "cell_us_east_1" {
  source = "./modules/cell"

  name           = local.name
  vpc_cidr       = "10.20.0.0/16" # avoids E2B's in-host sandbox networks (10.11/16, 10.12/16)
  azs            = ["us-east-1a", "us-east-1b", "us-east-1c"]
  private_domain = "boxes.internal" # the first cell keeps the names it had before cells
  e2b_sha        = var.e2b_sha
  node_count     = var.node_count
  ecr            = local.ecr
  mtls_env       = local.mtls_env
  mtls_certs     = { ca_pem = module.mtls.ca_pem, leaves = module.mtls.leaves }
  backup_bucket  = "mumbo-boxes-backup-${data.aws_caller_identity.this.account_id}" # created by the trial (../edge.tf); users' backups carry over
  edge_role_arn  = module.edge_us_east_1.role_arn
}

# The Mumbai cell (design section 17c, R3), lean on the founder's choice (2026-11-11). node_count stays 0 until its E2B
# build (setup/build.sh into its templates bucket, R5) is in place: a node boots from that build.
provider "aws" {
  alias  = "ap_south_1"
  region = "ap-south-1"
  default_tags { tags = { project = "mumbo", component = "boxes", stage = "prod" } }
}

variable "node_count_ap_south_1" {
  description = "Sandbox nodes in the ap-south-1 cell; 0 until R5 puts the E2B build in its templates bucket."
  type        = number
  default     = 0
}

module "cell_ap_south_1" {
  source    = "./modules/cell"
  providers = { aws = aws.ap_south_1 }

  name           = "${local.name}-aps1" # IAM role and S3 bucket names are global
  vpc_cidr       = "10.21.0.0/16"       # clear of 10.11/16, 10.12/16 (E2B in-host) and 10.20/16 (us-east-1)
  azs            = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
  private_domain = "ap-south-1.boxes.internal"
  zone_id        = module.cell_us_east_1.zone_id # one boxes.internal zone for every cell (R4)
  lean           = true
  e2b_sha        = var.e2b_sha
  node_count     = var.node_count_ap_south_1
  ecr            = local.ecr
  mtls_env       = local.mtls_env
  mtls_certs     = { ca_pem = module.mtls.ca_pem, leaves = module.mtls.leaves } # SPIFFE ids, not names: the same leaves serve every cell
  backup_bucket  = "${local.name}-aps1-backup-${data.aws_caller_identity.this.account_id}"
  edge_role_arn  = module.edge_us_east_1.role_arn # the Mumbai edge's role joins in R6
}

output "nat_egress_ips" { value = module.cell_us_east_1.nat_egress_ips }
output "aps1_nat_egress_ips" { value = module.cell_ap_south_1.nat_egress_ips }
output "aps1_e2b_api_url" { value = module.cell_ap_south_1.e2b_api_url }
output "aps1_e2b_secret_arn" { value = module.cell_ap_south_1.e2b_secret_arn }
output "postgres_endpoint" { value = module.cell_us_east_1.postgres_endpoint }
output "memorydb_endpoint" { value = module.cell_us_east_1.memorydb_endpoint }
output "templates_bucket" { value = module.cell_us_east_1.templates_bucket }
output "e2b_secret_arn" { value = module.cell_us_east_1.e2b_secret_arn }
output "internal_nlb" { value = module.cell_us_east_1.internal_nlb }
output "setup_run" { value = module.cell_us_east_1.setup_run }
output "orchestrators_dns" { value = module.cell_us_east_1.orchestrators_dns }
