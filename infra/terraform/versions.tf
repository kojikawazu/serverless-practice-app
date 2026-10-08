terraform {
  # docs/09「技術スタック」の Terraform 1.14 系に合わせる
  required_version = "~> 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
  }

  # state は S3 に置く（.claude/rules/iac.md）。ステージで変わる key だけを envs/<stage>.s3.tfbackend に分け、
  # init で -backend-config として渡す（scripts/terraform.sh）。
  # local では tflocal が接続先を LocalStack に差し替え、このバケットを LocalStack 内に自動で作る
  backend "s3" {
    bucket       = "kojikawazu-tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "serverless-practice-app"
      Stage     = var.stage
      ManagedBy = "terraform"
    }
  }
}
