# メール送信キュー（SQS FIFO）と DLQ（docs/05「メールメッセージ」・docs/04「保持期間」）

resource "aws_sqs_queue" "mail_dlq" {
  name       = "${local.prefix}-mail-dlq.fifo"
  fifo_queue = true

  # DLQ の中身を後から確認できるよう、本キュー（1 日）より長く保持する
  message_retention_seconds = 345600 # 4 日
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "mail" {
  name       = "${local.prefix}-mail.fifo"
  fifo_queue = true

  # 重複排除 ID は投入 Lambda が決定的に作るため、本文からの自動生成は使わない
  content_based_deduplication = false

  visibility_timeout_seconds = local.queue_visibility_timeout_seconds
  message_retention_seconds  = 86400 # 1 日
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.mail_dlq.arn
    # 3 回受信しても処理できなければ DLQ へ移す（docs/04「リトライ」）
    maxReceiveCount = 3
  })
}

# DLQ に移せるのはメール送信キューからだけにする
resource "aws_sqs_queue_redrive_allow_policy" "mail_dlq" {
  queue_url = aws_sqs_queue.mail_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.mail.arn]
  })
}

# Scheduler の起動の失敗を受ける DLQ（docs/04「リトライ」・#101）。
# Scheduler は FIFO キューを DLQ に使えないため標準キューにする（公式「Configuring a schedule's dead-letter queue」）。
# 届いたことの通知は、CDK のアラームが送信数で拾う
resource "aws_sqs_queue" "scheduler_dlq" {
  name = "${local.prefix}-scheduler-dlq"

  # メール送信の DLQ と同じく、中身（エラーコード・予定時刻）を後から確認できる長さにする
  message_retention_seconds = 345600 # 4 日
  sqs_managed_sse_enabled   = true
}
