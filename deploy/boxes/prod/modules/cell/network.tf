# One VPC across three AZs. Its range must avoid E2B's in-host sandbox networks (10.11/16, 10.12/16).
# Box egress leaves through one NAT gateway per AZ; their EIPs are BOX_EGRESS_IPS for the edge's model host.
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.2"

  name            = local.name
  cidr            = var.vpc_cidr
  azs             = var.azs
  public_subnets  = [for i in range(3) : cidrsubnet(var.vpc_cidr, 6, i)]     # us-east-1: 10.20.{0,4,8}.0/22
  private_subnets = [for i in range(3) : cidrsubnet(var.vpc_cidr, 3, i + 1)] # us-east-1: 10.20.{32,64,96}.0/19

  enable_nat_gateway     = true
  single_nat_gateway     = var.lean
  one_nat_gateway_per_az = !var.lean
  enable_dns_hostnames   = true
  enable_dns_support     = true

  enable_flow_log                                 = true
  create_flow_log_cloudwatch_log_group            = true
  create_flow_log_cloudwatch_iam_role             = true
  flow_log_max_aggregation_interval               = 600
  flow_log_cloudwatch_log_group_retention_in_days = 30
}

# Private DNS: orchestrators register here (one multivalue record per node, written at boot, removed on drain).
# One zone serves every cell: the first cell creates it, later cells associate their VPC with it (zone_id).
resource "aws_route53_zone" "internal" {
  count = var.zone_id == null ? 1 : 0
  name  = "boxes.internal"
  vpc { vpc_id = module.vpc.vpc_id }
  lifecycle { ignore_changes = [vpc] } # other cells' VPCs join through aws_route53_zone_association
}
moved {
  from = aws_route53_zone.internal
  to   = aws_route53_zone.internal[0]
}
resource "aws_route53_zone_association" "internal" {
  count   = var.zone_id == null ? 0 : 1
  zone_id = var.zone_id
  vpc_id  = module.vpc.vpc_id
}

# S3 through a gateway endpoint: snapshot and backup traffic never crosses NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids
}

# The edge reaches E2B by these names on the internal NLB; client-proxy header routing needs sandbox.<domain>.
resource "aws_route53_record" "internal" {
  for_each = toset(["api", "sandbox"])
  zone_id  = local.zone_id
  name     = "${each.key}.${var.private_domain}"
  type     = "A"
  alias {
    name                   = aws_lb.internal.dns_name
    zone_id                = aws_lb.internal.zone_id
    evaluate_target_health = false
  }
}

