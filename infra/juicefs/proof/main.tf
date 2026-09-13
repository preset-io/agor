terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.64.0" }
  }
}
provider "aws" { region = "ap-southeast-2" }
variable "worker_role_name" { type = string }
variable "bucket_name" { type = string }
resource "aws_iam_role_policy" "proof" {
  name = "agor-juicefs-isolated-proof"
  role = var.worker_role_name
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], Resource = "arn:aws:s3:::${var.bucket_name}/agor-juicefs-proof/*" },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = "arn:aws:s3:::${var.bucket_name}", Condition = { StringLike = { "s3:prefix" = ["agor-juicefs-proof/*"] } } },
    { Effect = "Allow", Action = ["s3:GetBucketLocation"], Resource = "arn:aws:s3:::${var.bucket_name}" }
  ] })
}
