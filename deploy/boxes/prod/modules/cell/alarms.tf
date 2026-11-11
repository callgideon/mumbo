# The cell's alarms (stage 7), in the cell's region: a CloudWatch alarm watches metrics of its own region and notifies
# an SNS topic there. us-east-1 passes the root topic (ops.tf); another cell creates its own, mailed to the same address.
variable "alarm_topic_arn" {
  description = "SNS topic for this cell's alarms; null creates one in the cell's region."
  type        = string
  default     = null
}
variable "alarm_email" {
  description = "Address the cell's own topic mails (alarm_topic_arn null); empty for none. AWS mails a confirmation link once."
  type        = string
  default     = ""
}

resource "aws_sns_topic" "alarms" {
  count = var.alarm_topic_arn == null ? 1 : 0
  name  = "${local.name}-alarms"
}
resource "aws_sns_topic_subscription" "alarms" {
  count     = var.alarm_topic_arn == null && var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_topic = var.alarm_topic_arn != null ? var.alarm_topic_arn : aws_sns_topic.alarms[0].arn
  alarms = merge(
    { api-node-unhealthy = { ns = "mumbo/boxes", metric = "api-node-unhealthy", dims = {}, stat = "Sum", period = 300, threshold = 0, cmp = "GreaterThanThreshold", missing = "notBreaching" } },
    { for k, v in aws_lb_target_group.control : "unhealthy-${k}" => { ns = "AWS/NetworkELB", metric = "UnHealthyHostCount", dims = { TargetGroup = v.arn_suffix, LoadBalancer = aws_lb.internal.arn_suffix }, stat = "Maximum", period = 60, threshold = 0, cmp = "GreaterThanThreshold", missing = "notBreaching" } },
    {
      nodes-below-min = { ns = "AWS/AutoScaling", metric = "GroupInServiceInstances", dims = { AutoScalingGroupName = aws_autoscaling_group.nodes.name }, stat = "Minimum", period = 300, threshold = var.node_count, cmp = "LessThanThreshold", missing = "breaching" }
      memorydb-memory = { ns = "AWS/MemoryDB", metric = "DatabaseMemoryUsagePercentage", dims = { ClusterName = aws_memorydb_cluster.e2b.name }, stat = "Maximum", period = 300, threshold = 75, cmp = "GreaterThanThreshold", missing = "notBreaching" }
      rds-cpu         = { ns = "AWS/RDS", metric = "CPUUtilization", dims = { DBInstanceIdentifier = aws_db_instance.e2b.identifier }, stat = "Average", period = 300, threshold = 80, cmp = "GreaterThanThreshold", missing = "notBreaching" }
      rds-storage     = { ns = "AWS/RDS", metric = "FreeStorageSpace", dims = { DBInstanceIdentifier = aws_db_instance.e2b.identifier }, stat = "Minimum", period = 300, threshold = 5e9, cmp = "LessThanThreshold", missing = "notBreaching" }
    },
    { for s in keys(local.services) : "tasks-${s}" => { ns = "ECS/ContainerInsights", metric = "RunningTaskCount", dims = { ClusterName = aws_ecs_cluster.e2b.name, ServiceName = s }, stat = "Minimum", period = 300, threshold = var.lean ? 1 : 2, cmp = "LessThanThreshold", missing = "breaching" } },
  )
}

resource "aws_cloudwatch_log_metric_filter" "api_node_unhealthy" {
  name           = "api-node-unhealthy"
  log_group_name = aws_cloudwatch_log_group.e2b["api"].name
  pattern        = "\"NodeID status changed\" \"unhealthy\""
  metric_transformation {
    name          = "api-node-unhealthy"
    namespace     = "mumbo/boxes"
    value         = "1"
    default_value = "0"
  }
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
  alarm_actions       = [local.alarm_topic]
  ok_actions          = [local.alarm_topic]
}

# The fullest node's root disk (CloudWatch agent disk_used_percent, nodes/node.sh.tftpl). A Metrics Insights query covers
# every node the group launches without a per-instance alarm.
resource "aws_cloudwatch_metric_alarm" "node_disk" {
  alarm_name          = "${local.name}-node-disk"
  evaluation_periods  = 1
  threshold           = 75
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "Runbook: deploy/boxes/RUNBOOK.md#node-disk"
  alarm_actions       = [local.alarm_topic]
  ok_actions          = [local.alarm_topic]
  metric_query {
    id          = "disk"
    period      = 300
    return_data = true
    expression  = "SELECT MAX(disk_used_percent) FROM SCHEMA(\"mumbo/boxes/nodes\", AutoScalingGroupName, InstanceId, device, fstype, path) WHERE AutoScalingGroupName = '${aws_autoscaling_group.nodes.name}' AND path = '/'"
  }
}
