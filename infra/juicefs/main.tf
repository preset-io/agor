terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.64.0" }
  }
}
# Storage module: callers supply their isolated VPC and worker identities.
variable "name" {
  type    = string
  default = "agor-juicefs"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use a lowercase deployment name."
  }
}
variable "vpc_id" { type = string }
variable "private_subnet_ids" {
  type = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Provide private subnets in at least two availability zones."
  }
}
variable "worker_security_group_id" { type = string }
variable "worker_role_name" { type = string }
variable "multi_az" {
  type    = bool
  default = false
}
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
resource "aws_s3_bucket" "data" {
  bucket        = "${var.name}-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_policy" "tls" {
  bucket = aws_s3_bucket.data.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.data.arn, "${aws_s3_bucket.data.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
resource "aws_iam_role_policy" "data" {
  role = var.worker_role_name
  name = "${var.name}-storage"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = aws_s3_bucket.data.arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], Resource = "${aws_s3_bucket.data.arn}/*" }
  ] })
}
resource "aws_security_group" "metadata" {
  name_prefix = "${var.name}-metadata-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.worker_security_group_id]
  }
}
resource "aws_db_subnet_group" "metadata" {
  name_prefix = "${var.name}-"
  subnet_ids  = var.private_subnet_ids
}
resource "aws_db_instance" "metadata" {
  identifier                  = "${var.name}-metadata"
  engine                      = "postgres"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  max_allocated_storage       = 100
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "juicefs"
  username                    = "juicefs"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.metadata.name
  vpc_security_group_ids      = [aws_security_group.metadata.id]
  publicly_accessible         = false
  multi_az                    = var.multi_az
  backup_retention_period     = 7
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name}-final"
}
resource "aws_iam_role_policy" "metadata_secret" {
  role = var.worker_role_name
  name = "${var.name}-metadata-secret"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = ["secretsmanager:GetSecretValue"],
    Resource = aws_db_instance.metadata.master_user_secret[0].secret_arn
  }] })
}
output "bucket_url" { value = "https://${aws_s3_bucket.data.bucket}.s3.${data.aws_region.current.region}.amazonaws.com" }
output "metadata_url" { value = "postgres://juicefs@${aws_db_instance.metadata.endpoint}/juicefs?sslmode=require" }
output "metadata_secret_arn" { value = aws_db_instance.metadata.master_user_secret[0].secret_arn }
