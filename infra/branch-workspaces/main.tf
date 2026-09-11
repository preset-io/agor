# Existing Agor PostgreSQL remains the metadata authority: no second metadata database.
resource "aws_s3_bucket" "workspaces" {
  bucket        = var.bucket_name
  force_destroy = false
  tags          = var.tags
}
resource "aws_s3_bucket_public_access_block" "workspaces" {
  bucket                  = aws_s3_bucket.workspaces.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn

    }
    bucket_key_enabled = true

  }
}
resource "aws_s3_bucket_lifecycle_configuration" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id
  rule {
    id     = "incomplete-and-noncurrent-only"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_retention_days
    }

  }
  depends_on = [aws_s3_bucket_versioning.workspaces]
}
# Bucket policy denies plaintext transport. The wildcard principal is DENY-only.
data "aws_iam_policy_document" "bucket" {
  statement {
    effect    = "Deny"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.workspaces.arn, "${aws_s3_bucket.workspaces.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }

  }
}
resource "aws_s3_bucket_policy" "workspaces" {
  bucket = aws_s3_bucket.workspaces.id
  policy = data.aws_iam_policy_document.bucket.json
}
data "aws_iam_policy_document" "tenant" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.workspaces.arn}/tenants/$${aws:PrincipalTag/tenant_id}/workspace-blobs/*"]
    condition {
      test     = "Null"
      variable = "aws:PrincipalTag/tenant_id"
      values   = ["false"]
    }

  }
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.workspaces.arn]
    }

  }
}
resource "aws_iam_role_policy" "tenant" {
  name   = "${var.name}-workspace-content"
  role   = var.tenant_access_role_name
  policy = data.aws_iam_policy_document.tenant.json
}
resource "aws_launch_template" "worker" {
  name_prefix            = "${var.name}-"
  image_id               = var.ami_id
  instance_type          = var.instance_type
  vpc_security_group_ids = var.security_group_ids
  iam_instance_profile {
    name = var.instance_profile_name
  }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  user_data = base64encode(templatefile("${path.module}/worker-storage.sh.tftpl", { use_instance_store = var.use_instance_store }))
  dynamic "block_device_mappings" {
    for_each = var.use_instance_store ? [] : [1]
    content {
      device_name = "/dev/sdf"
      ebs {
        volume_type           = "gp3"
        volume_size           = var.ebs_gib
        iops                  = var.ebs_iops
        throughput            = var.ebs_throughput
        encrypted             = true
        kms_key_id            = var.kms_key_arn
        delete_on_termination = true

      }

    }

  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = var.name })
  }
}
resource "aws_autoscaling_group" "workers" {
  name                = var.name
  min_size            = 0
  max_size            = var.maximum_capacity
  desired_capacity    = var.desired_capacity
  vpc_zone_identifier = var.subnet_ids
  launch_template {
    id      = aws_launch_template.worker.id
    version = tostring(aws_launch_template.worker.latest_version)
  }
  initial_lifecycle_hook {
    name                 = "checkpoint-before-termination"
    lifecycle_transition = "autoscaling:EC2_INSTANCE_TERMINATING"
    heartbeat_timeout    = 600
    default_result       = "CONTINUE"

  }
}
resource "aws_cloudwatch_metric_alarm" "workspace_failures" {
  alarm_name          = "${var.name}-workspace-failures"
  namespace           = "Agor/Workspace"
  metric_name         = "fencing_failure"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  period              = 60
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
}
output "bucket_name" {
  value = aws_s3_bucket.workspaces.id
}
output "launch_template_id" {
  value = aws_launch_template.worker.id
}
output "autoscaling_group_name" {
  value = aws_autoscaling_group.workers.name
}
