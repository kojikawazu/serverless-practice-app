# IAM ロール 6 種（docs/06「認可（権限制御）」）。
# CDK はこれらを mutable: false で参照し、grant* でポリシーを足させない。必要な権限はすべてここで明示する。
# まだ存在しない CDK 側のリソース（関数・ステートマシン・ロググループ）は、命名規約で固定した名前で指す。

locals {
  # Lambda ごとに、ログ出力以外で必要な権限。空のものはログ出力だけ
  lambda_statements = {
    enqueue = [{
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.mail.arn]
    }]
    consumer = [{
      # SQS イベントソースが使う操作（Lambda の AWSLambdaSQSQueueExecutionRole と同じ範囲）
      actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      resources = [aws_sqs_queue.mail.arn]
    }]
    data-sync = [
      {
        actions   = ["s3:PutObject"]
        resources = ["${aws_s3_bucket.exports.arn}/exports/*"]
      },
      {
        # .waitForTaskToken で非同期に呼ばれ、結果をタスクトークンで返す（docs/09「LMI（Lambda Managed Instances）」）。
        # ステートマシンの ARN に絞っても通ることを実 AWS で確かめた（2026-10-13）
        actions   = ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"]
        resources = ["arn:aws:states:${var.region}:${local.account_id}:stateMachine:${local.prefix}-batch"]
      },
    ]
    notify-slack = []
  }
}

# ---- Lambda 4 種 ----

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  for_each = toset(local.lambda_names)

  name               = "${local.prefix}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda" {
  for_each = toset(local.lambda_names)

  # ログは自分のロググループにだけ書ける。ロググループは CDK が作るため CreateLogGroup は付けない
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/${local.prefix}-${each.key}:*"]
  }

  dynamic "statement" {
    for_each = local.lambda_statements[each.key]
    content {
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  for_each = toset(local.lambda_names)

  name   = "${local.prefix}-${each.key}"
  role   = aws_iam_role.lambda[each.key].id
  policy = data.aws_iam_policy_document.lambda[each.key].json
}

# ---- ステートマシン ----

data "aws_iam_policy_document" "state_machine_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
    # 他のアカウントのステートマシンにこのロールを使わせない（混乱した代理の防止）
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "state_machine" {
  name               = "${local.prefix}-batch"
  assume_role_policy = data.aws_iam_policy_document.state_machine_assume.json
}

data "aws_iam_policy_document" "state_machine" {
  # ステートマシンが呼ぶのは投入とデータ連携の 2 つだけ。:* はバージョン・エイリアス付きの呼び出し
  statement {
    actions = ["lambda:InvokeFunction"]
    resources = flatten([
      for name in ["enqueue", "data-sync"] : [
        "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.prefix}-${name}",
        "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.prefix}-${name}:*",
      ]
    ])
  }
}

resource "aws_iam_role_policy" "state_machine" {
  name   = "${local.prefix}-batch"
  role   = aws_iam_role.state_machine.id
  policy = data.aws_iam_policy_document.state_machine.json
}

# ---- Scheduler ----

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["states:StartExecution"]
    resources = ["arn:aws:states:${var.region}:${local.account_id}:stateMachine:${local.prefix}-batch"]
  }

  # 起動に失敗し続けた呼び出しを DLQ へ送る（docs/04「リトライ」）。送り先はこの DLQ だけに絞る
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.scheduler_dlq.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${local.prefix}-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}
