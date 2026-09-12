variable "public_hostname" {
  type    = string
  default = "agor.skellige.com.au"
}
variable "enable_https" {
  description = "Enable after the external DNS CNAMEs are published. Keeps existing access unchanged while validation is pending."
  type        = bool
  default     = false
}
resource "aws_acm_certificate" "app" {
  domain_name       = var.public_hostname
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_acm_certificate_validation" "app" {
  count                   = var.enable_https ? 1 : 0
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_acm_certificate.app.domain_validation_options : record.resource_record_name]
  timeouts { create = "20m" }
}
resource "aws_lb_listener" "https" {
  count             = var.enable_https ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.app[0].certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
output "certificate_dns_records" {
  value = [for record in aws_acm_certificate.app.domain_validation_options : {
    type  = record.resource_record_type
    name  = record.resource_record_name
    value = record.resource_record_value
  }]
}
output "application_dns_record" {
  value = { type = "CNAME", name = var.public_hostname, value = aws_lb.app.dns_name }
}
