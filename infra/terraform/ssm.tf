# Terraform → CDK の受け渡し（docs/05「SSM パラメータ」）。名前は /serverless-practice-app/<stage>/<name>。
# 秘匿値を置かないため、型はすべて String にする

locals {
  ssm_parameters = merge(
    {
      "queue/url"                = aws_sqs_queue.mail.url
      "queue/arn"                = aws_sqs_queue.mail.arn
      "dlq/arn"                  = aws_sqs_queue.mail_dlq.arn
      "bucket/name"              = aws_s3_bucket.exports.bucket
      "schedule-group/name"      = aws_scheduler_schedule_group.batch.name
      "role/state-machine/arn"   = aws_iam_role.state_machine.arn
      "role/scheduler/arn"       = aws_iam_role.scheduler.arn
      "consumer/timeout-seconds" = tostring(var.consumer_timeout_seconds)
    },
    { for name in local.lambda_names : "role/${name}/arn" => aws_iam_role.lambda[name].arn },
    # LMI を使うステージ（dev）だけ。CDK も同じ条件でだけこのパラメータを読む（lmi.tf）
    local.lmi_enabled ? { "capacity-provider/arn" = aws_lambda_capacity_provider.lmi[0].arn } : {},
  )
}

resource "aws_ssm_parameter" "handoff" {
  for_each = local.ssm_parameters

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "String"
  value = each.value
}
