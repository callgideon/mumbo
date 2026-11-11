# R4 (design section 17c): inter-region VPC peering between the cells, so every edge reaches every cell's E2B API and
# client proxy, and (R6) the Mumbai edge reaches the edge store in us-east-1. Security groups cannot reference a group
# across regions, so cross-cell rules name the other cell's private subnets.
resource "aws_vpc_peering_connection" "use1_aps1" {
  vpc_id      = module.cell_us_east_1.vpc_id
  peer_vpc_id = module.cell_ap_south_1.vpc_id
  peer_region = "ap-south-1"
  tags        = { Name = "${local.name}-use1-aps1" }
}
resource "aws_vpc_peering_connection_accepter" "use1_aps1" {
  provider                  = aws.ap_south_1
  vpc_peering_connection_id = aws_vpc_peering_connection.use1_aps1.id
  auto_accept               = true
  tags                      = { Name = "${local.name}-use1-aps1" }
}

resource "aws_route" "use1_to_aps1" {
  count                     = 3
  route_table_id            = module.cell_us_east_1.private_route_table_ids[count.index]
  destination_cidr_block    = module.cell_ap_south_1.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.use1_aps1.id
}
resource "aws_route" "aps1_to_use1" {
  provider                  = aws.ap_south_1
  count                     = length(module.cell_ap_south_1.private_route_table_ids)
  route_table_id            = module.cell_ap_south_1.private_route_table_ids[count.index]
  destination_cidr_block    = module.cell_us_east_1.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection_accepter.use1_aps1.id
}

# The us-east-1 edge (in that cell's private subnets) reaches Mumbai's API (3000) and client proxy (3002).
resource "aws_vpc_security_group_ingress_rule" "aps1_nlb_from_use1" {
  provider          = aws.ap_south_1
  for_each          = { for p in setproduct(["3000", "3002"], module.cell_us_east_1.edge_subnet_cidrs) : "${p[0]}-${p[1]}" => p }
  security_group_id = module.cell_ap_south_1.nlb_security_group_id
  cidr_ipv4         = each.value[1]
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value[0])
  to_port           = tonumber(each.value[0])
  description       = "us-east-1 edge subnets (R4, R6)"
}
