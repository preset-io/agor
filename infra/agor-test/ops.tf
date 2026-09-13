variable "ops_enabled" {
  default = false
}
variable "ops_worker_release" {
  type    = string
  default = ""
}
resource "aws_s3_bucket_metric" "ops" {
  count  = var.ops_enabled ? 1 : 0
  bucket = aws_s3_bucket.workspace.id
  name   = "agor-ops"
}
resource "aws_lb_target_group" "ops" {
  count    = var.ops_enabled ? 1 : 0
  name     = "agor-ops"
  port     = 8790
  protocol = "HTTP"
  vpc_id   = aws_vpc.test.id
  health_check {
    path = "/ops/health"
  }
}
resource "aws_lb_target_group_attachment" "ops" {
  count            = var.ops_enabled ? 1 : 0
  target_group_arn = aws_lb_target_group.ops[0].arn
  target_id        = aws_instance.app.id
  port             = 8790
}
resource "aws_lb_listener_rule" "ops" {
  count        = var.ops_enabled ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 35
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ops[0].arn
  }
  condition {
    host_header {
      values = [var.public_hostname]
    }
  }
  condition {
    path_pattern {
      values = ["/ops", "/ops/*"]
    }
  }
}
resource "aws_launch_template" "ops_worker" {
  count         = var.ops_enabled ? 1 : 0
  name_prefix   = "agor-ops-worker-"
  image_id      = data.aws_ssm_parameter.ami.value
  instance_type = "m7i.xlarge"
  iam_instance_profile {
    name = aws_iam_instance_profile.app.name
  }
  vpc_security_group_ids = [aws_security_group.app.id, aws_security_group.worker_rpc.id]
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_type           = "gp3"
      volume_size           = 150
      encrypted             = true
      delete_on_termination = false
      iops                  = 3000
      throughput            = 250
    }

  }
  user_data = base64encode(templatefile("${path.module}/ops-worker-bootstrap.sh.tftpl", {
    release = var.ops_worker_release, bucket = aws_s3_bucket.source.id
  }))
  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "agor-elastic-worker", Project = "agor-workspace-test"
    }

  }
  tag_specifications {
    resource_type = "volume"
    tags = {
      Name = "agor-elastic-worker-data", Project = "agor-workspace-test"
    }

  }
}
resource "aws_autoscaling_group" "ops_workers" {
  count                 = var.ops_enabled ? 1 : 0
  name                  = "agor-ops-workers"
  min_size              = 0
  max_size              = 4
  desired_capacity      = 0
  vpc_zone_identifier   = [aws_subnet.test[2].id]
  default_cooldown      = 60
  health_check_type     = "EC2"
  protect_from_scale_in = true
  suspended_processes   = ["ReplaceUnhealthy", "AZRebalance"]
  launch_template {
    id      = aws_launch_template.ops_worker[0].id
    version = "$Latest"
  }
  tag {
    key                 = "Project"
    value               = "agor-workspace-test"
    propagate_at_launch = true
  }
  lifecycle {
    ignore_changes = [desired_capacity]
  }
}
resource "aws_iam_role_policy" "ops" {
  count = var.ops_enabled ? 1 : 0
  name  = "agor-ops-observe-and-grow"
  role  = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["cloudwatch:GetMetricData", "autoscaling:DescribeAutoScalingGroups", "ec2:DescribeInstances"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["autoscaling:SetDesiredCapacity"], Resource = aws_autoscaling_group.ops_workers[0].arn
      },
      {
        Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.source.arn}/workspace-releases/ops-*"
      }
    ]
  })
}
