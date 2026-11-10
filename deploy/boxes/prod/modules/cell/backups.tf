# Box backups, moved here from the trial's Terraform (deploy/boxes/edge.tf) when the trial host was retired (2026-11-09). Backups
# hold each user's browser profile (signed-in accounts), so the bucket encrypts with a key that only the edge role may use;
# the account root keeps key administration. Objects written before the switch stay SSE-S3 until the next backup
# overwrites them; noncurrent versions expire after 30 days.
resource "aws_kms_key" "backups" {
  description         = "${local.name} box backups (users' files, chats and browser profiles)"
  enable_key_rotation = true
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "Administration", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.this.account_id}:root" },
    Action = ["kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"], Resource = "*" },
    { Sid = "EdgeUse", Effect = "Allow", Principal = { AWS = var.edge_role_arn }, Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = "*" },
  ] })
}
resource "aws_kms_alias" "backups" {
  name          = "alias/${local.name}-backups"
  target_key_id = aws_kms_key.backups.key_id
}

resource "aws_s3_bucket" "backup" { bucket = var.backup_bucket }
resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backups.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}
