# One cell: one region's VPC, NAT, private zone, E2B control on ECS, Postgres, MemoryDB, nodes, templates bucket and
# box backups (design section 17c). Its region is the region of the aws provider it is given.
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws" }
    random = { source = "hashicorp/random" }
  }
}

variable "name" {
  description = "Name prefix of every resource (IAM role and S3 bucket names are global: a second cell needs its own)."
  type        = string
}
variable "vpc_cidr" {
  description = "VPC range, a /16. Public subnets are its first three /22s, private subnets its second to fourth /19s."
  type        = string
}
variable "azs" {
  description = "The three Availability Zones of the cell's region."
  type        = list(string)
}
variable "private_domain" {
  description = "Suffix of the cell's private names in the boxes.internal zone: api.<this>, sandbox.<this>, orchestrators.<this>."
  type        = string
}
variable "e2b_sha" {
  description = "Fork commit whose api, client-proxy, setup, orchestrator and envd the cell runs."
  type        = string
}
variable "node_count" {
  description = "Sandbox nodes: the ASG desired capacity."
  type        = number
}
variable "ecr" {
  description = "Image prefix: <registry>/<repository prefix>; images are <this>/e2b-api and so on."
  type        = string
}
variable "mtls_env" {
  description = "E2B_TLS_* env per service: api, client-proxy, orchestrator."
  type        = map(map(string))
}
variable "mtls_certs" {
  description = "Per service in mtls_env: its certificate and key (crt, key); ca_pem is the CA every service trusts."
  type        = object({ ca_pem = string, leaves = map(object({ crt = string, key = string })) })
}
variable "backup_bucket" {
  description = "Box backup bucket name."
  type        = string
}
variable "lean" {
  description = "One NAT gateway, single-AZ Postgres, MemoryDB without a replica and one task per E2B service: no failover, about $350 a month less (founder, R3 lean, 2026-11-11)."
  type        = bool
  default     = false
}
variable "db_instance_class" {
  description = "Postgres instance class. ap-south-1 had no db.t4g.medium capacity on 2026-11-11 (twice, insufficient-capacity), so its cell uses db.t3.medium, which every zone there offers."
  type        = string
  default     = "db.t4g.medium"
}
variable "zone_id" {
  description = "An existing boxes.internal private zone to associate with this cell's VPC instead of creating one (one zone for every cell, design R4); null creates it."
  type        = string
  default     = null
}
variable "edge_role_arns" {
  description = "Every edge's task role (one per edge region, R6): the only principals that may use the backup key."
  type        = list(string)
}

data "aws_caller_identity" "this" {}
data "aws_region" "this" {}

locals {
  name     = var.name
  region   = data.aws_region.this.region
  mtls_env = var.mtls_env
  zone_id  = var.zone_id != null ? var.zone_id : aws_route53_zone.internal[0].zone_id
}
