# Dedicated /24s for the edge's tasks (design R6): a cross-region rule (another cell's NLB, the edge store) names these
# subnets, never the whole VPC, whose private subnets also hold the sandbox nodes. Egress through the cell's NAT.
resource "aws_subnet" "edge" {
  count             = 3
  vpc_id            = module.vpc.vpc_id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 16 + count.index) # 10.x.16.0/24 to 10.x.18.0/24
  availability_zone = var.azs[count.index]
  tags              = { Name = "${local.name}-edge-${var.azs[count.index]}" }
}
resource "aws_route_table_association" "edge" {
  count          = 3
  subnet_id      = aws_subnet.edge[count.index].id
  route_table_id = module.vpc.private_route_table_ids[min(count.index, length(module.vpc.private_route_table_ids) - 1)]
}
output "edge_subnets" { value = aws_subnet.edge[*].id }
output "edge_subnet_cidrs" { value = aws_subnet.edge[*].cidr_block }
