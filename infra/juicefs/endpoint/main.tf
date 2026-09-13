terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.64.0" }
  }
}
provider "aws" { region = "ap-southeast-2" }
variable "hostname" {
  type    = string
  default = "juicefs.skellige.com.au"
}
variable "enable_https" {
  type    = bool
  default = false
}
variable "load_balancer_arn" { type = string }
variable "listener_arn" { type = string }
variable "instance_id" { type = string }
data "aws_lb" "existing" { arn = var.load_balancer_arn }
resource "aws_acm_certificate" "juicefs" {
  domain_name       = var.hostname
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_lb_target_group" "juicefs" {
  name        = "agor-juicefs"
  port        = 3031
  protocol    = "HTTP"
  vpc_id      = data.aws_lb.existing.vpc_id
  target_type = "instance"
  health_check {
    path    = "/health"
    matcher = "200"
  }
}
resource "aws_lb_target_group_attachment" "juicefs" {
  target_group_arn = aws_lb_target_group.juicefs.arn
  target_id        = var.instance_id
  port             = 3031
}
resource "aws_acm_certificate_validation" "juicefs" {
  count                   = var.enable_https ? 1 : 0
  certificate_arn         = aws_acm_certificate.juicefs.arn
  validation_record_fqdns = [for r in aws_acm_certificate.juicefs.domain_validation_options : r.resource_record_name]
  timeouts { create = "20m" }
}
resource "aws_lb_listener_certificate" "juicefs" {
  count           = var.enable_https ? 1 : 0
  listener_arn    = var.listener_arn
  certificate_arn = aws_acm_certificate_validation.juicefs[0].certificate_arn
}
resource "aws_lb_listener_rule" "juicefs" {
  count        = var.enable_https ? 1 : 0
  listener_arn = var.listener_arn
  priority     = 110
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.juicefs.arn
  }
  condition {
    host_header { values = [var.hostname] }
  }
  depends_on = [aws_lb_listener_certificate.juicefs]
}
output "dns_records" {
  value = concat([
    { type = "CNAME", name = var.hostname, value = data.aws_lb.existing.dns_name }
    ], [for r in aws_acm_certificate.juicefs.domain_validation_options : {
      type = r.resource_record_type, name = r.resource_record_name, value = r.resource_record_value
  }])
}
output "target_group_arn" { value = aws_lb_target_group.juicefs.arn }
