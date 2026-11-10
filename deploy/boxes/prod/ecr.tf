# Images we build: the forked E2B api (DNS discovery, callgideon/e2b-runtime) and the edge. Tags are immutable
# commit SHAs, so a deploy names exactly what runs and a rollback is the previous tag.
resource "aws_ecr_repository" "images" {
  for_each             = toset(["e2b-api", "e2b-client-proxy", "e2b-setup", "edge"])
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = module.cell_us_east_1.data_kms_key_arn
  }
}
resource "aws_ecr_lifecycle_policy" "images" {
  for_each   = aws_ecr_repository.images
  repository = each.value.name
  policy     = jsonencode({ rules = [{ rulePriority = 1, description = "keep the last 30 images", selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }, action = { type = "expire" } }] })
}
output "ecr_repositories" { value = { for k, r in aws_ecr_repository.images : k => r.repository_url } }
