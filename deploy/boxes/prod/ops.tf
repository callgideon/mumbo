# Stage 7: alarms. Every alarm goes to one SNS topic; runbooks are in ../RUNBOOK.md, one section per alarm name.
# Unencrypted on purpose: CloudWatch cannot publish to a topic under the aws/sns key, and alarm text holds no secret.
resource "aws_sns_topic" "alarms" { name = "${local.name}-alarms" }

# Log-derived signals: the edge logs one JSON line per box event; the api logs node status changes.
locals {
  log_metrics = {
    edge-backup-failed  = { group = aws_cloudwatch_log_group.edge.name, pattern = "{ $.msg = \"backup failed\" }" }
    edge-pause-failed   = { group = aws_cloudwatch_log_group.edge.name, pattern = "{ $.msg = \"pause failed\" }" }
    edge-errors         = { group = aws_cloudwatch_log_group.edge.name, pattern = "{ $.edge = \"error\" }" }
    edge-dropped-create = { group = aws_cloudwatch_log_group.edge.name, pattern = "{ $.msg = \"dropped unfinished create\" }" }
    # The forwarder's refusal and the approvals poller's failure both carry this text (github-app.mjs mintToken).
    github-not-approved = { group = aws_cloudwatch_log_group.edge.name, pattern = "\"mumbo-bot App permissions not approved\"" }
    api-node-unhealthy  = { group = aws_cloudwatch_log_group.e2b["api"].name, pattern = "\"NodeID status changed\" \"unhealthy\"" }
  }
}
resource "aws_cloudwatch_log_metric_filter" "ops" {
  for_each       = local.log_metrics
  name           = each.key
  log_group_name = each.value.group
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.key
    namespace     = "mumbo/boxes"
    value         = "1"
    default_value = "0"
  }
}

locals {
  tg  = { for k, v in aws_lb_target_group.edge : "edge-${k}" => { tg = v.arn_suffix, lb = aws_lb.edge.arn_suffix, ns = "AWS/ApplicationELB" } }
  ntg = { for k, v in aws_lb_target_group.control : k => { tg = v.arn_suffix, lb = aws_lb.internal.arn_suffix, ns = "AWS/NetworkELB" } }
  alarms = merge(
    { for k, v in local.log_metrics : k => { ns = "mumbo/boxes", metric = k, dims = {}, stat = "Sum", period = 300, threshold = 0, cmp = "GreaterThanThreshold", missing = "notBreaching" } },
    { for k, v in merge(local.tg, local.ntg) : "unhealthy-${k}" => { ns = v.ns, metric = "UnHealthyHostCount", dims = { TargetGroup = v.tg, LoadBalancer = v.lb }, stat = "Maximum", period = 60, threshold = 0, cmp = "GreaterThanThreshold", missing = "notBreaching" } },
    {
      edge-5xx        = { ns = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", dims = { LoadBalancer = aws_lb.edge.arn_suffix }, stat = "Sum", period = 300, threshold = 20, cmp = "GreaterThanThreshold", missing = "notBreaching" }
      nodes-below-min = { ns = "AWS/AutoScaling", metric = "GroupInServiceInstances", dims = { AutoScalingGroupName = aws_autoscaling_group.nodes.name }, stat = "Minimum", period = 300, threshold = aws_autoscaling_group.nodes.min_size, cmp = "LessThanThreshold", missing = "breaching" }
      memorydb-memory = { ns = "AWS/MemoryDB", metric = "DatabaseMemoryUsagePercentage", dims = { ClusterName = aws_memorydb_cluster.e2b.name }, stat = "Maximum", period = 300, threshold = 75, cmp = "GreaterThanThreshold", missing = "notBreaching" }
      rds-cpu         = { ns = "AWS/RDS", metric = "CPUUtilization", dims = { DBInstanceIdentifier = aws_db_instance.e2b.identifier }, stat = "Average", period = 300, threshold = 80, cmp = "GreaterThanThreshold", missing = "notBreaching" }
      rds-storage     = { ns = "AWS/RDS", metric = "FreeStorageSpace", dims = { DBInstanceIdentifier = aws_db_instance.e2b.identifier }, stat = "Minimum", period = 300, threshold = 5e9, cmp = "LessThanThreshold", missing = "notBreaching" }
    },
    { for s in ["api", "client-proxy", "edge"] : "tasks-${s}" => { ns = "ECS/ContainerInsights", metric = "RunningTaskCount", dims = { ClusterName = aws_ecs_cluster.e2b.name, ServiceName = s }, stat = "Minimum", period = 300, threshold = 2, cmp = "LessThanThreshold", missing = "breaching" } },
  )
}
resource "aws_cloudwatch_metric_alarm" "ops" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  namespace           = each.value.ns
  metric_name         = each.value.metric
  dimensions          = each.value.dims
  statistic           = each.value.stat
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = each.value.cmp
  treat_missing_data  = each.value.missing
  alarm_description   = "Runbook: deploy/boxes/RUNBOOK.md#${each.key}"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
output "alarm_topic" { value = aws_sns_topic.alarms.arn }
