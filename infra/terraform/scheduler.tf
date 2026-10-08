# Schedule の入れ物。Schedule 定義（cron とターゲット）は CDK が作る（docs/09「IaC の責務分担」）
resource "aws_scheduler_schedule_group" "batch" {
  name = local.prefix
}
