resource "aws_subnet" "metadata" {
  count             = 2
  vpc_id            = aws_vpc.test.id
  cidr_block        = cidrsubnet(aws_vpc.test.cidr_block, 8, 10 + count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "agor-workspace-metadata-${count.index}" }
}
resource "aws_db_subnet_group" "workspace" {
  name       = "agor-workspace-metadata"
  subnet_ids = aws_subnet.metadata[*].id
}
resource "aws_security_group" "metadata" {
  name_prefix = "agor-workspace-metadata-"
  vpc_id      = aws_vpc.test.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}
resource "aws_db_instance" "workspace" {
  identifier                  = "agor-workspace-authority"
  engine                      = "postgres"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "agor_workspace"
  username                    = "agor_bootstrap"
  manage_master_user_password = true
  multi_az                    = true
  publicly_accessible         = false
  db_subnet_group_name        = aws_db_subnet_group.workspace.name
  vpc_security_group_ids      = [aws_security_group.metadata.id]
  backup_retention_period     = 7
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "agor-workspace-authority-final"
  auto_minor_version_upgrade  = true
}
resource "aws_kms_key" "workspace" {
  description             = "Agor isolated test workspace blobs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}
resource "aws_s3_bucket" "workspace" { bucket = "agor-workspace-blobs-${data.aws_caller_identity.current.account_id}" }
resource "aws_s3_bucket_public_access_block" "workspace" {
  bucket                  = aws_s3_bucket.workspace.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.workspace.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_policy" "workspace" {
  bucket = aws_s3_bucket.workspace.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.workspace.arn, "${aws_s3_bucket.workspace.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_secretsmanager_secret" "workspace_runtime" {
  name        = "agor-workspace-runtime"
  description = "Trusted worker SQL credential and control capability; never injected into SDK containers"
}
resource "aws_iam_role_policy" "workspace" {
  role = aws_iam_role.app.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.workspace.arn}/tenants/*/workspace-blobs/*" },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.workspace.arn, Condition = { StringEquals = { "kms:ViaService" = "s3.ap-southeast-2.amazonaws.com" } } },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.workspace_runtime.arn }
  ] })
}
resource "aws_security_group" "worker_rpc" {
  name_prefix = "agor-workspace-rpc-"
  vpc_id      = aws_vpc.test.id
  ingress {
    from_port       = 8787
    to_port         = 8787
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}
resource "aws_instance" "worker" {
  ami                         = data.aws_ssm_parameter.ami.value
  instance_type               = "m7i.xlarge"
  subnet_id                   = aws_subnet.test[1].id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.app.id, aws_security_group.worker_rpc.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 150
    encrypted             = true
    delete_on_termination = false
    throughput            = 250
    iops                  = 3000
  }
  user_data = <<-SCRIPT
    #!/bin/bash
    set -euo pipefail
    dnf install -y docker
    systemctl enable --now docker
    mkdir -p /opt/agor /var/lib/agor
  SCRIPT
  tags      = { Name = "agor-workspace-worker-2" }
}
output "workspace_database_endpoint" { value = aws_db_instance.workspace.address }
output "workspace_admin_secret" { value = aws_db_instance.workspace.master_user_secret[0].secret_arn }
output "workspace_worker_id" { value = aws_instance.worker.id }
output "workspace_worker_addresses" { value = [aws_instance.app.private_ip, aws_instance.worker.private_ip] }
output "workspace_bucket" { value = aws_s3_bucket.workspace.id }

variable "workspace_release" {
  type    = object({ archive = string, sha = string })
  default = null
}
resource "aws_s3_object" "workspace_release" {
  count       = var.workspace_release == null ? 0 : 1
  bucket      = aws_s3_bucket.source.id
  key         = "workspace-releases/${var.workspace_release.sha}.tar.gz"
  source      = var.workspace_release.archive
  source_hash = filemd5(var.workspace_release.archive)
}
resource "aws_iam_role_policy" "workspace_release" {
  role = aws_iam_role.app.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.source.arn}/workspace-releases/*" }
  ] })
}
