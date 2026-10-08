data "aws_caller_identity" "current" {}

locals {
  # AWS リソース名の接頭辞（docs/10「命名」）。CDK が後から作るリソースも同じ接頭辞で名前を固定し、
  # IAM ポリシーはその名前で権限を付ける（docs/09「名前の先決め」）
  prefix     = "serverless-practice-app-${var.stage}"
  ssm_prefix = "/serverless-practice-app/${var.stage}"
  account_id = data.aws_caller_identity.current.account_id

  # CDK が作る Lambda の関数名の <name> 部分。handler のファイル名と一致させる（docs/10）
  lambda_names = ["enqueue", "consumer", "data-sync", "notify-slack"]

  # SQS の可視性タイムアウト。Consumer のタイムアウトの 6 倍（AWS 推奨。docs/04）
  queue_visibility_timeout_seconds = var.consumer_timeout_seconds * 6
}
