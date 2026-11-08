# mumbo boxes, production (PRODUCTION.md). Separate state from the trial in ../main.tf.
terraform {
  required_version = ">= 1.10"
  backend "s3" {
    bucket       = "mumbo-tfstate-641134885443"
    key          = "boxes/prod.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    tls    = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags { tags = { project = "mumbo", component = "boxes", stage = "prod" } }
}

locals {
  name = "mumbo-boxes"
  azs  = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

data "aws_caller_identity" "this" {}
