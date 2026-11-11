# State moves from the single-stack layout to one cell and one edge for us-east-1 (design section 17c, R1).
# Keep them: they are how an older state reaches the module addresses.
moved {
  from = module.vpc
  to   = module.cell_us_east_1.module.vpc
}
moved {
  from = aws_autoscaling_group.nodes
  to   = module.cell_us_east_1.aws_autoscaling_group.nodes
}
moved {
  from = aws_cloudwatch_log_group.e2b
  to   = module.cell_us_east_1.aws_cloudwatch_log_group.e2b
}
moved {
  from = aws_cloudwatch_log_group.nodes
  to   = module.cell_us_east_1.aws_cloudwatch_log_group.nodes
}
moved {
  from = aws_db_instance.e2b
  to   = module.cell_us_east_1.aws_db_instance.e2b
}
moved {
  from = aws_db_subnet_group.e2b
  to   = module.cell_us_east_1.aws_db_subnet_group.e2b
}
moved {
  from = aws_ecs_cluster.e2b
  to   = module.cell_us_east_1.aws_ecs_cluster.e2b
}
moved {
  from = aws_ecs_service.e2b
  to   = module.cell_us_east_1.aws_ecs_service.e2b
}
moved {
  from = aws_ecs_task_definition.e2b
  to   = module.cell_us_east_1.aws_ecs_task_definition.e2b
}
moved {
  from = aws_ecs_task_definition.setup
  to   = module.cell_us_east_1.aws_ecs_task_definition.setup
}
moved {
  from = aws_iam_instance_profile.nodes
  to   = module.cell_us_east_1.aws_iam_instance_profile.nodes
}
moved {
  from = aws_iam_role.exec
  to   = module.cell_us_east_1.aws_iam_role.exec
}
moved {
  from = aws_iam_role.nodes
  to   = module.cell_us_east_1.aws_iam_role.nodes
}
moved {
  from = aws_iam_role_policy.exec
  to   = module.cell_us_east_1.aws_iam_role_policy.exec
}
moved {
  from = aws_iam_role_policy.nodes
  to   = module.cell_us_east_1.aws_iam_role_policy.nodes
}
moved {
  from = aws_iam_role_policy_attachment.exec
  to   = module.cell_us_east_1.aws_iam_role_policy_attachment.exec
}
moved {
  from = aws_iam_role_policy_attachment.nodes_cloudwatch
  to   = module.cell_us_east_1.aws_iam_role_policy_attachment.nodes_cloudwatch
}
moved {
  from = aws_iam_role_policy_attachment.nodes_ssm
  to   = module.cell_us_east_1.aws_iam_role_policy_attachment.nodes_ssm
}
moved {
  from = aws_kms_alias.backups
  to   = module.cell_us_east_1.aws_kms_alias.backups
}
moved {
  from = aws_kms_key.backups
  to   = module.cell_us_east_1.aws_kms_key.backups
}
moved {
  from = aws_kms_key.data
  to   = module.cell_us_east_1.aws_kms_key.data
}
moved {
  from = aws_launch_template.nodes
  to   = module.cell_us_east_1.aws_launch_template.nodes
}
moved {
  from = aws_lb.internal
  to   = module.cell_us_east_1.aws_lb.internal
}
moved {
  from = aws_lb_listener.control
  to   = module.cell_us_east_1.aws_lb_listener.control
}
moved {
  from = aws_lb_target_group.control
  to   = module.cell_us_east_1.aws_lb_target_group.control
}
moved {
  from = aws_memorydb_acl.e2b
  to   = module.cell_us_east_1.aws_memorydb_acl.e2b
}
moved {
  from = aws_memorydb_cluster.e2b
  to   = module.cell_us_east_1.aws_memorydb_cluster.e2b
}
moved {
  from = aws_memorydb_subnet_group.e2b
  to   = module.cell_us_east_1.aws_memorydb_subnet_group.e2b
}
moved {
  from = aws_memorydb_user.e2b
  to   = module.cell_us_east_1.aws_memorydb_user.e2b
}
moved {
  from = aws_route53_record.internal
  to   = module.cell_us_east_1.aws_route53_record.internal
}
moved {
  from = aws_route53_zone.internal
  to   = module.cell_us_east_1.aws_route53_zone.internal
}
moved {
  from = aws_s3_bucket.backup
  to   = module.cell_us_east_1.aws_s3_bucket.backup
}
moved {
  from = aws_s3_bucket.templates
  to   = module.cell_us_east_1.aws_s3_bucket.templates
}
moved {
  from = aws_s3_bucket_lifecycle_configuration.backup
  to   = module.cell_us_east_1.aws_s3_bucket_lifecycle_configuration.backup
}
moved {
  from = aws_s3_bucket_lifecycle_configuration.templates
  to   = module.cell_us_east_1.aws_s3_bucket_lifecycle_configuration.templates
}
moved {
  from = aws_s3_bucket_public_access_block.backup
  to   = module.cell_us_east_1.aws_s3_bucket_public_access_block.backup
}
moved {
  from = aws_s3_bucket_public_access_block.templates
  to   = module.cell_us_east_1.aws_s3_bucket_public_access_block.templates
}
moved {
  from = aws_s3_bucket_server_side_encryption_configuration.backup
  to   = module.cell_us_east_1.aws_s3_bucket_server_side_encryption_configuration.backup
}
moved {
  from = aws_s3_bucket_server_side_encryption_configuration.templates
  to   = module.cell_us_east_1.aws_s3_bucket_server_side_encryption_configuration.templates
}
moved {
  from = aws_s3_bucket_versioning.backup
  to   = module.cell_us_east_1.aws_s3_bucket_versioning.backup
}
moved {
  from = aws_s3_bucket_versioning.templates
  to   = module.cell_us_east_1.aws_s3_bucket_versioning.templates
}
moved {
  from = aws_secretsmanager_secret.e2b
  to   = module.cell_us_east_1.aws_secretsmanager_secret.e2b
}
moved {
  from = aws_secretsmanager_secret.mtls
  to   = module.cell_us_east_1.aws_secretsmanager_secret.mtls
}
moved {
  from = aws_secretsmanager_secret_version.e2b
  to   = module.cell_us_east_1.aws_secretsmanager_secret_version.e2b
}
moved {
  from = aws_secretsmanager_secret_version.mtls
  to   = module.cell_us_east_1.aws_secretsmanager_secret_version.mtls
}
moved {
  from = aws_security_group.api
  to   = module.cell_us_east_1.aws_security_group.api
}
moved {
  from = aws_security_group.client_proxy
  to   = module.cell_us_east_1.aws_security_group.client_proxy
}
moved {
  from = aws_security_group.data
  to   = module.cell_us_east_1.aws_security_group.data
}
moved {
  from = aws_security_group.edge
  to   = module.cell_us_east_1.aws_security_group.edge
}
moved {
  from = aws_security_group.nlb
  to   = module.cell_us_east_1.aws_security_group.nlb
}
moved {
  from = aws_security_group.nodes
  to   = module.cell_us_east_1.aws_security_group.nodes
}
moved {
  from = aws_vpc_endpoint.s3
  to   = module.cell_us_east_1.aws_vpc_endpoint.s3
}
moved {
  from = aws_vpc_security_group_egress_rule.all
  to   = module.cell_us_east_1.aws_vpc_security_group_egress_rule.all
}
moved {
  from = aws_vpc_security_group_egress_rule.nodes
  to   = module.cell_us_east_1.aws_vpc_security_group_egress_rule.nodes
}
moved {
  from = aws_vpc_security_group_ingress_rule.control
  to   = module.cell_us_east_1.aws_vpc_security_group_ingress_rule.control
}
moved {
  from = aws_vpc_security_group_ingress_rule.data
  to   = module.cell_us_east_1.aws_vpc_security_group_ingress_rule.data
}
moved {
  from = aws_vpc_security_group_ingress_rule.nodes
  to   = module.cell_us_east_1.aws_vpc_security_group_ingress_rule.nodes
}
moved {
  from = random_id.admin_token
  to   = module.cell_us_east_1.random_id.admin_token
}
moved {
  from = random_id.hash_seed
  to   = module.cell_us_east_1.random_id.hash_seed
}
moved {
  from = random_id.team_api_key
  to   = module.cell_us_east_1.random_id.team_api_key
}
moved {
  from = random_password.memorydb
  to   = module.cell_us_east_1.random_password.memorydb
}
moved {
  from = random_password.postgres
  to   = module.cell_us_east_1.random_password.postgres
}
moved {
  from = aws_acm_certificate.edge
  to   = module.edge_us_east_1.aws_acm_certificate.edge
}
moved {
  from = aws_acm_certificate_validation.edge
  to   = module.edge_us_east_1.aws_acm_certificate_validation.edge
}
moved {
  from = aws_cloudwatch_log_group.edge
  to   = module.edge_us_east_1.aws_cloudwatch_log_group.edge
}
moved {
  from = aws_ecs_service.edge
  to   = module.edge_us_east_1.aws_ecs_service.edge
}
moved {
  from = aws_ecs_task_definition.edge
  to   = module.edge_us_east_1.aws_ecs_task_definition.edge
}
moved {
  from = aws_elasticache_replication_group.edge
  to   = module.edge_us_east_1.aws_elasticache_replication_group.edge
}
moved {
  from = aws_elasticache_subnet_group.edge
  to   = module.edge_us_east_1.aws_elasticache_subnet_group.edge
}
moved {
  from = aws_iam_role.edge
  to   = module.edge_us_east_1.aws_iam_role.edge
}
moved {
  from = aws_iam_role_policy.edge
  to   = module.edge_us_east_1.aws_iam_role_policy.edge
}
moved {
  from = aws_iam_role_policy.exec_edge
  to   = module.edge_us_east_1.aws_iam_role_policy.exec_edge
}
moved {
  from = aws_lb.edge
  to   = module.edge_us_east_1.aws_lb.edge
}
moved {
  from = aws_lb_listener.http
  to   = module.edge_us_east_1.aws_lb_listener.http
}
moved {
  from = aws_lb_listener.https
  to   = module.edge_us_east_1.aws_lb_listener.https
}
moved {
  from = aws_lb_listener_rule.edge
  to   = module.edge_us_east_1.aws_lb_listener_rule.edge
}
moved {
  from = aws_lb_listener_rule.old_hosts
  to   = module.edge_us_east_1.aws_lb_listener_rule.old_hosts
}
moved {
  from = aws_lb_listener_rule.x_forwarded_uri
  to   = module.edge_us_east_1.aws_lb_listener_rule.x_forwarded_uri
}
moved {
  from = aws_lb_target_group.edge
  to   = module.edge_us_east_1.aws_lb_target_group.edge
}
moved {
  from = aws_security_group.alb
  to   = module.edge_us_east_1.aws_security_group.alb
}
moved {
  from = aws_vpc_security_group_egress_rule.alb
  to   = module.edge_us_east_1.aws_vpc_security_group_egress_rule.alb
}
moved {
  from = aws_vpc_security_group_ingress_rule.alb
  to   = module.edge_us_east_1.aws_vpc_security_group_ingress_rule.alb
}
moved {
  from = aws_vpc_security_group_ingress_rule.edge
  to   = module.edge_us_east_1.aws_vpc_security_group_ingress_rule.edge
}

# The cell's alarms moved into modules/cell/alarms.tf (R5).
moved {
  from = aws_cloudwatch_metric_alarm.ops["api-node-unhealthy"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["api-node-unhealthy"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["unhealthy-api-http"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["unhealthy-api-http"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["unhealthy-api-grpc"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["unhealthy-api-grpc"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["unhealthy-proxy"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["unhealthy-proxy"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["nodes-below-min"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["nodes-below-min"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["memorydb-memory"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["memorydb-memory"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["rds-cpu"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["rds-cpu"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["rds-storage"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["rds-storage"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["tasks-api"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["tasks-api"]
}
moved {
  from = aws_cloudwatch_metric_alarm.ops["tasks-client-proxy"]
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.ops["tasks-client-proxy"]
}
moved {
  from = aws_cloudwatch_metric_alarm.node_disk
  to   = module.cell_us_east_1.aws_cloudwatch_metric_alarm.node_disk
}
moved {
  from = aws_cloudwatch_log_metric_filter.ops["api-node-unhealthy"]
  to   = module.cell_us_east_1.aws_cloudwatch_log_metric_filter.api_node_unhealthy
}
