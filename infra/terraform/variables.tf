variable "stage" {
  description = "ステージ名。リソース名と SSM パラメータのパスに入る（docs/10「命名」）"
  type        = string

  validation {
    condition     = contains(["local", "dev"], var.stage)
    error_message = "stage は local か dev のどちらかにしてください。"
  }
}

variable "region" {
  description = "リージョン（docs/04「対応環境」）"
  type        = string
  default     = "ap-northeast-1"
}

variable "consumer_timeout_seconds" {
  description = <<-EOT
    Consumer Lambda のタイムアウト（秒）。SQS の可視性タイムアウトはこの 6 倍にする（docs/04）。
    値の正本はここで、SSM 経由で CDK に渡す。CDK 側に同じ値を書かないことで、2 つがずれない
  EOT
  type        = number
  default     = 10

  validation {
    condition     = var.consumer_timeout_seconds >= 1 && var.consumer_timeout_seconds * 6 <= 43200
    error_message = "consumer_timeout_seconds は 1 以上、かつ 6 倍が可視性タイムアウトの上限（43200 秒）以下にしてください。"
  }
}
