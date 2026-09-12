terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 6.64.0" } }
}
provider "aws" {
  region = "ap-southeast-2"
  default_tags { tags = { Project = "agor-workspace-test", ManagedBy = "terraform" } }
}
variable "allowed_cidr" { type = string }
variable "source_archive" { type = string }
variable "source_sha" { type = string }
data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }
data "aws_ssm_parameter" "ami" { name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64" }
resource "aws_vpc" "test" {
  cidr_block           = "10.87.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "agor-workspace-test" }
}
resource "aws_internet_gateway" "test" { vpc_id = aws_vpc.test.id }
resource "aws_subnet" "test" {
  count             = 3
  vpc_id            = aws_vpc.test.id
  cidr_block        = cidrsubnet(aws_vpc.test.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index % 2]
  tags              = { Name = "agor-test-${count.index < 2 ? "alb" : "app"}-${count.index}" }
}
resource "aws_route_table" "internet" {
  vpc_id = aws_vpc.test.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.test.id
  }
}
resource "aws_route_table_association" "internet" {
  count          = 3
  subnet_id      = aws_subnet.test[count.index].id
  route_table_id = count.index == 2 && var.nat_egress_enabled ? aws_route_table.app_egress.id : aws_route_table.internet.id
}
resource "aws_security_group" "alb" {
  name_prefix = "agor-test-alb-"
  vpc_id      = aws_vpc.test.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }
  dynamic "ingress" {
    for_each = var.enable_https ? [1] : []
    content {
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
  egress {
    from_port   = 3030
    to_port     = 3030
    protocol    = "tcp"
    cidr_blocks = [aws_subnet.test[2].cidr_block]
  }
}
resource "aws_security_group" "app" {
  name_prefix = "agor-test-app-"
  vpc_id      = aws_vpc.test.id
  ingress {
    from_port       = 3030
    to_port         = 3030
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_s3_bucket" "source" { bucket = "agor-test-source-${data.aws_caller_identity.current.account_id}" }
resource "aws_s3_bucket_public_access_block" "source" {
  bucket                  = aws_s3_bucket.source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "source" {
  bucket = aws_s3_bucket.source.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_policy" "source" {
  bucket = aws_s3_bucket.source.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.source.arn, "${aws_s3_bucket.source.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_s3_object" "source" {
  bucket      = aws_s3_bucket.source.id
  key         = "source/${var.source_sha}.tar.gz"
  source      = var.source_archive
  source_hash = filemd5(var.source_archive)
}
resource "aws_iam_role" "app" {
  name_prefix        = "agor-test-app-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "source" {
  role   = aws_iam_role.app.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["s3:GetObject"], Resource = aws_s3_object.source.arn }] })
}
resource "aws_iam_instance_profile" "app" { role = aws_iam_role.app.name }
resource "aws_lb" "app" {
  name               = "agor-workspace-test"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.test[0].id, aws_subnet.test[1].id]
  idle_timeout       = 300
}
resource "aws_lb_target_group" "app" {
  name     = "agor-workspace-test"
  port     = 3030
  protocol = "HTTP"
  vpc_id   = aws_vpc.test.id
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
}
resource "aws_lb_listener" "app" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = var.enable_https ? "redirect" : "forward"
    target_group_arn = var.enable_https ? null : aws_lb_target_group.app.arn
    dynamic "redirect" {
      for_each = var.enable_https ? [1] : []
      content {
        protocol    = "HTTPS"
        port        = "443"
        host        = var.public_hostname
        status_code = "HTTP_301"
      }
    }
  }
}
resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.ami.value
  instance_type               = "m7i.xlarge"
  subnet_id                   = aws_subnet.test[2].id
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
  user_data                   = templatefile("${path.module}/bootstrap.sh.tftpl", { bucket = aws_s3_bucket.source.id, key = aws_s3_object.source.key, sha = var.source_sha, hostname = aws_lb.app.dns_name })
  user_data_replace_on_change = true
  depends_on                  = [aws_iam_role_policy.source, aws_iam_role_policy_attachment.ssm, aws_route_table_association.internet]
  tags                        = { Name = "agor-workspace-test" }
}
resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = 3030
}
output "fqdn" { value = aws_lb.app.dns_name }
output "url" { value = var.enable_https ? "https://${var.public_hostname}/ui/" : "http://${aws_lb.app.dns_name}/ui/" }
output "instance_id" { value = aws_instance.app.id }
output "source_sha" { value = var.source_sha }
