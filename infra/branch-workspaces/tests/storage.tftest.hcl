mock_provider "aws" {}
variables {
  name                    = "workspace-test"
  bucket_name             = "agor-workspace-test"
  kms_key_arn             = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  tenant_access_role_name = "tenant-workspace"
  ami_id                  = "ami-00000000000000000"
  instance_profile_name   = "existing-controller"
  subnet_ids              = ["subnet-00000000000000000"]
  security_group_ids      = ["sg-00000000000000000"]
  alarm_topic_arn         = "arn:aws:sns:us-east-1:123456789012:alarms"
}
run "private_and_disabled_by_default" {
  command = plan
  assert {
    condition     = aws_s3_bucket_public_access_block.workspaces.block_public_acls && aws_s3_bucket_public_access_block.workspaces.block_public_policy && aws_s3_bucket_public_access_block.workspaces.ignore_public_acls && aws_s3_bucket_public_access_block.workspaces.restrict_public_buckets
    error_message = "Workspace checkpoints must remain private."
  }
  assert {
    condition     = aws_autoscaling_group.workers.desired_capacity == 0
    error_message = "Applying the module must not start workers by default."
  }
  assert {
    condition     = aws_s3_bucket_versioning.workspaces.versioning_configuration[0].status == "Enabled"
    error_message = "Workspace objects require versioning."
  }
}
run "encrypted_local_ebs_fallback" {
  command = plan
  variables { use_instance_store = false }
  assert {
    condition     = one(aws_launch_template.worker.block_device_mappings).ebs[0].encrypted
    error_message = "Fallback local disks must be encrypted."
  }
}
