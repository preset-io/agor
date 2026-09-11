variable "name" {
  type = string
}
variable "bucket_name" {
  type = string
}
variable "kms_key_arn" {
  type = string
}
variable "tenant_access_role_name" {
  description = "Existing STS role whose trusted caller fixes the tenant_id session tag; never the unscoped EC2 role."
  type        = string
}
variable "ami_id" {
  type = string
}
variable "instance_type" {
  type    = string
  default = "i4i.xlarge"
}
variable "instance_profile_name" {
  type = string
}
variable "subnet_ids" {
  type = list(string)
}
variable "security_group_ids" {
  type = list(string)
}
variable "desired_capacity" {
  type    = number
  default = 0
}
variable "maximum_capacity" {
  type    = number
  default = 4
}
variable "ebs_gib" {
  type    = number
  default = 300
}
variable "ebs_iops" {
  type    = number
  default = 16000
}
variable "ebs_throughput" {
  type    = number
  default = 1000
}
variable "use_instance_store" {
  type    = bool
  default = true
}
variable "noncurrent_retention_days" {
  type    = number
  default = 30
}
variable "alarm_topic_arn" {
  type = string
}
variable "tags" {
  type    = map(string)
  default = {}
}
