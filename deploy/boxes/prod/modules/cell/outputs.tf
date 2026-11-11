# What the edge module and the root's alarms read.
output "nat_egress_ips" { value = module.vpc.nat_public_ips }
output "vpc_id" { value = module.vpc.vpc_id }
output "public_subnets" { value = module.vpc.public_subnets }
output "private_subnets" { value = module.vpc.private_subnets }
output "e2b_api_url" { value = "http://api.${var.private_domain}:3000" }
output "e2b_sandbox_url" { value = "http://sandbox.${var.private_domain}:3002" }
output "ecs_cluster" { value = { id = aws_ecs_cluster.e2b.id, name = aws_ecs_cluster.e2b.name } }
output "exec_role" { value = { id = aws_iam_role.exec.id, arn = aws_iam_role.exec.arn } }
output "edge_security_group_id" { value = aws_security_group.edge.id }
output "data_security_group_id" { value = aws_security_group.data.id }
output "data_kms_key_arn" { value = aws_kms_key.data.arn }
output "backup_bucket" { value = aws_s3_bucket.backup.bucket }
output "backups_kms_key_arn" { value = aws_kms_key.backups.arn }
output "api_log_group" { value = aws_cloudwatch_log_group.e2b["api"].name }
output "control_target_groups" { value = { for k, v in aws_lb_target_group.control : k => v.arn_suffix } }
output "internal_nlb_arn_suffix" { value = aws_lb.internal.arn_suffix }
output "nodes_asg_name" { value = aws_autoscaling_group.nodes.name }
output "memorydb_name" { value = aws_memorydb_cluster.e2b.name }
output "postgres_identifier" { value = aws_db_instance.e2b.identifier }
output "zone_id" { value = local.zone_id }
