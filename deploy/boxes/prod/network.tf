# One VPC across three AZs. 10.20/16 avoids E2B's in-host sandbox networks (10.11/16, 10.12/16).
# Box egress leaves through one NAT gateway per AZ; their EIPs are BOX_EGRESS_IPS for the edge's model host.
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.2"

  name            = local.name
  cidr            = "10.20.0.0/16"
  azs             = local.azs
  public_subnets  = ["10.20.0.0/22", "10.20.4.0/22", "10.20.8.0/22"]
  private_subnets = ["10.20.32.0/19", "10.20.64.0/19", "10.20.96.0/19"]

  enable_nat_gateway     = true
  single_nat_gateway     = false
  one_nat_gateway_per_az = true
  enable_dns_hostnames   = true
  enable_dns_support     = true

  enable_flow_log                                 = true
  create_flow_log_cloudwatch_log_group            = true
  create_flow_log_cloudwatch_iam_role             = true
  flow_log_max_aggregation_interval               = 600
  flow_log_cloudwatch_log_group_retention_in_days = 30
}

# Private DNS: orchestrators register here (one multivalue record per node, written at boot, removed on drain).
resource "aws_route53_zone" "internal" {
  name = "boxes.internal"
  vpc { vpc_id = module.vpc.vpc_id }
}

# S3 through a gateway endpoint: snapshot and backup traffic never crosses NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.us-east-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids
}

output "nat_egress_ips" { value = module.vpc.nat_public_ips }
