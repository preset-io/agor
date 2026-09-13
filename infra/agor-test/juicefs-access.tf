# The comparison endpoint owns its certificate/routing in the JuiceFS branch.
# This shared stack continues to own both security groups, avoiding split ownership.
variable "juicefs_backend_enabled" {
  type    = bool
  default = false
}
