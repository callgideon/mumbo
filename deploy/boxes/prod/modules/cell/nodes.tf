# Stage 4: sandbox nodes. Plain EC2 with nested virtualization in an Auto Scaling group across three AZs.
# A node boots from stock Ubuntu 24.04 with nodes/node.sh.tftpl; a termination is held by the lifecycle hook
# while the node pauses its boxes (memory kept) and leaves DNS. Upgrades are blue/green through node_count (review B2):
# change e2b_sha and set node_count to 2N, apply, wait until the new nodes are in orchestrators.<private_domain>, then set
# N and apply; scale-in prefers the oldest launch template but rebalances Availability Zones first, so protect the new nodes and
# check every node's launch template version (RUNBOOK "Adding nodes", step 5); each terminated node drains through the hook. Never restart
# orchestrators in place, and never apply while the desired capacity differs from node_count.
locals {
  node_max_size = 10            # the node group max_size; the root's node_count validates against it
  node_type     = "r8i.2xlarge" # 8 vCPU, 64 GiB
  hugepages     = 24576         # 48 GiB of 2 MiB pages for guests: 12 running 4 GiB boxes (review M5)
  firecracker   = "v1.14-0.2.0"
  kernel        = "vmlinux-6.1.177_5008931"
  busybox       = "1.36.1"
  orch_dns      = "orchestrators.${var.private_domain}"
  hook          = "drain"
}

resource "aws_security_group" "nodes" {
  name        = "${local.name}-nodes"
  description = "Sandbox nodes: orchestrator gRPC (mTLS) from api and peers, sandbox traffic from client-proxy"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_vpc_security_group_egress_rule" "nodes" {
  security_group_id = aws_security_group.nodes.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
resource "aws_vpc_security_group_ingress_rule" "nodes" {
  for_each = {
    grpc-api   = [aws_security_group.api.id, 5008]
    grpc-peers = [aws_security_group.nodes.id, 5008]
    proxy-cp   = [aws_security_group.client_proxy.id, 5007]
  }
  security_group_id            = aws_security_group.nodes.id
  referenced_security_group_id = each.value[0]
  ip_protocol                  = "tcp"
  from_port                    = each.value[1]
  to_port                      = each.value[1]
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_iam_role" "nodes" {
  name               = "${local.name}-nodes"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ec2.amazonaws.com" } }] })
}
resource "aws_iam_role_policy_attachment" "nodes_ssm" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "nodes" {
  role = aws_iam_role.nodes.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:AbortMultipartUpload"],
    Resource = [aws_s3_bucket.templates.arn, "${aws_s3_bucket.templates.arn}/*"] },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.data.arn },
    { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = [aws_secretsmanager_secret.mtls["orchestrator"].arn, aws_secretsmanager_secret.e2b.arn] },
    # The zone is shared by every cell: a node may change only its own cell's orchestrators record (design R3).
    { Effect = "Allow", Action = "route53:ChangeResourceRecordSets", Resource = "arn:aws:route53:::hostedzone/${local.zone_id}",
    Condition = { "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = [local.orch_dns] } } },
    { Effect = "Allow", Action = "route53:ListResourceRecordSets", Resource = "arn:aws:route53:::hostedzone/${local.zone_id}" },
    { Effect = "Allow", Action = "ec2:DescribeInstances", Resource = "*" },
    { Effect = "Allow", Action = "autoscaling:CompleteLifecycleAction", Resource = "arn:aws:autoscaling:${local.region}:${data.aws_caller_identity.this.account_id}:autoScalingGroup:*:autoScalingGroupName/${local.name}-nodes" },
  ] })
}
resource "aws_iam_role_policy_attachment" "nodes_cloudwatch" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}
resource "aws_cloudwatch_log_group" "nodes" {
  name              = "/${local.name}/nodes"
  retention_in_days = 30
}
resource "aws_iam_instance_profile" "nodes" {
  name = "${local.name}-nodes"
  role = aws_iam_role.nodes.name
}

resource "aws_launch_template" "nodes" {
  name_prefix            = "${local.name}-node-"
  image_id               = data.aws_ssm_parameter.ubuntu.insecure_value
  instance_type          = local.node_type
  update_default_version = true
  vpc_security_group_ids = [aws_security_group.nodes.id]
  user_data = base64gzip(templatefile("${path.root}/nodes/node.sh.tftpl", {
    region      = local.region, bucket = aws_s3_bucket.templates.bucket, e2b_sha = var.e2b_sha,
    firecracker = local.firecracker, kernel = local.kernel, busybox = local.busybox,
    hugepages   = local.hugepages, nbds = 256,
    mtls_secret = aws_secretsmanager_secret.mtls["orchestrator"].arn, e2b_secret = aws_secretsmanager_secret.e2b.arn,
    mtls_env    = local.mtls_env.orchestrator,
    api_url     = "http://${aws_lb.internal.dns_name}:3000", zone_id = local.zone_id, dns_name = local.orch_dns,
    asg         = "${local.name}-nodes", hook = local.hook, log_group = aws_cloudwatch_log_group.nodes.name,
  }))
  iam_instance_profile { arn = aws_iam_instance_profile.nodes.arn }
  cpu_options { nested_virtualization = "enabled" }
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 500 # reaches running nodes only through blue/green (RUNBOOK "Node disk size")
      volume_type           = "gp3"
      iops                  = 6000
      throughput            = 400
      encrypted             = true # the aws/ebs key: an ASG cannot launch with a customer key it holds no grant on
      delete_on_termination = true
    }
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  monitoring { enabled = true }
  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-node", project = "mumbo", component = "boxes", stage = "prod" }
  }
}

resource "aws_autoscaling_group" "nodes" {
  name                      = "${local.name}-nodes"
  min_size                  = min(2, var.node_count) # at most node_count, below it from 3 nodes up: scale-in from 2N to N must not hit the minimum
  max_size                  = local.node_max_size
  desired_capacity          = var.node_count
  vpc_zone_identifier       = module.vpc.private_subnets
  health_check_type         = "EC2"
  termination_policies      = ["OldestLaunchTemplate", "OldestInstance"]
  enabled_metrics           = ["GroupInServiceInstances", "GroupDesiredCapacity"] # the nodes-below-min alarm reads GroupInServiceInstances
  health_check_grace_period = 600
  default_instance_warmup   = 600
  launch_template {
    id      = aws_launch_template.nodes.id
    version = aws_launch_template.nodes.latest_version
  }
  initial_lifecycle_hook {
    name                 = local.hook
    lifecycle_transition = "autoscaling:EC2_INSTANCE_TERMINATING"
    heartbeat_timeout    = 2400
    default_result       = "CONTINUE"
  }
  # A new launch template version reaches nodes only through blue/green (see the header), never an instance refresh.
  tag {
    key                 = "Name"
    value               = "${local.name}-node"
    propagate_at_launch = true
  }
}
output "orchestrators_dns" { value = local.orch_dns }
