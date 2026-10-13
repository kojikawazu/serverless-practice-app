# LMI（Lambda Managed Instances）でデータ連携 Lambda を動かす土台（docs/09「LMI（Lambda Managed Instances）」）。
# dev でだけ作る。LocalStack の今のライセンスでは LMI の API（CreateCapacityProvider）を使えないため（2026-10-13 に確認）。
# CDK も同じ条件（stage が dev）でだけ関数を紐付ける（infra/cdk/lib/batch-stack.ts）。
# 存在する間は EC2 の料金がかかるため、検証の間だけ作り、確かめたら CDK → Terraform の順に消す（docs/09「費用」）。

locals {
  lmi_enabled = var.stage == "dev"

  # AZ ごとにパブリックサブネットを 1 つ置く。既定の 3 台は AZ に分かれて起動するため 3 つにする
  lmi_subnet_count = 3
}

data "aws_availability_zones" "lmi" {
  count = local.lmi_enabled ? 1 : 0

  state = "available"
}

# ---- ネットワーク（パブリックサブネット + IGW。NAT Gateway・VPC エンドポイントは時間課金のため作らない）----

resource "aws_vpc" "lmi" {
  count = local.lmi_enabled ? 1 : 0

  cidr_block = "10.0.0.0/16"
  tags       = { Name = "${local.prefix}-lmi" }
}

resource "aws_internet_gateway" "lmi" {
  count = local.lmi_enabled ? 1 : 0

  vpc_id = aws_vpc.lmi[0].id
  tags   = { Name = "${local.prefix}-lmi" }
}

resource "aws_subnet" "lmi" {
  count = local.lmi_enabled ? local.lmi_subnet_count : 0

  vpc_id            = aws_vpc.lmi[0].id
  availability_zone = data.aws_availability_zones.lmi[0].names[count.index]
  cidr_block        = cidrsubnet(aws_vpc.lmi[0].cidr_block, 8, count.index)
  # インスタンスから CloudWatch Logs・Step Functions・S3 へ IGW 経由で届くよう、パブリック IP を付ける。
  # LMI のインスタンスにこの設定で IP が付くかは公式で確かめられなかったため、dev で確かめる（docs/09）
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.prefix}-lmi-${data.aws_availability_zones.lmi[0].names[count.index]}" }
}

resource "aws_route_table" "lmi" {
  count = local.lmi_enabled ? 1 : 0

  vpc_id = aws_vpc.lmi[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.lmi[0].id
  }
  tags = { Name = "${local.prefix}-lmi" }
}

resource "aws_route_table_association" "lmi" {
  count = local.lmi_enabled ? local.lmi_subnet_count : 0

  subnet_id      = aws_subnet.lmi[count.index].id
  route_table_id = aws_route_table.lmi[0].id
}

# 受信は許さない。送信は AWS API（HTTPS）だけ
resource "aws_security_group" "lmi" {
  count = local.lmi_enabled ? 1 : 0

  name        = "${local.prefix}-lmi"
  description = "LMI instances: no inbound, HTTPS outbound to AWS APIs only"
  vpc_id      = aws_vpc.lmi[0].id
}

resource "aws_vpc_security_group_egress_rule" "lmi_https" {
  count = local.lmi_enabled ? 1 : 0

  security_group_id = aws_security_group.lmi[0].id
  description       = "HTTPS to AWS APIs (CloudWatch Logs, Step Functions, S3)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# ---- キャパシティプロバイダ ----

# Lambda が EC2 インスタンスを起動・終了するために使うロール（公式の手順と同じ信頼ポリシー・管理ポリシー）
data "aws_iam_policy_document" "lmi_operator_assume" {
  count = local.lmi_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lmi_operator" {
  count = local.lmi_enabled ? 1 : 0

  name               = "${local.prefix}-lmi-operator"
  assume_role_policy = data.aws_iam_policy_document.lmi_operator_assume[0].json
}

resource "aws_iam_role_policy_attachment" "lmi_operator" {
  count = local.lmi_enabled ? 1 : 0

  role       = aws_iam_role.lmi_operator[0].name
  policy_arn = "arn:aws:iam::aws:policy/AWSLambdaManagedEC2ResourceOperator"
}

resource "aws_lambda_capacity_provider" "lmi" {
  count = local.lmi_enabled ? 1 : 0

  name = "${local.prefix}-lmi"

  vpc_config {
    subnet_ids         = aws_subnet.lmi[*].id
    security_group_ids = [aws_security_group.lmi[0].id]
  }

  permissions_config {
    capacity_provider_operator_role_arn = aws_iam_role.lmi_operator[0].arn
  }

  # 今の Lambda と同じ arm64。東京で最安の m6g.large と次点の m7g.large に絞り、費用の上限を読めるようにする
  instance_requirements = [{
    architectures           = ["arm64"]
    allowed_instance_types  = ["m6g.large", "m7g.large"]
    excluded_instance_types = null
  }]

  # API の下限（12）。.large（2 vCPU）6 台分で、想定外の拡大で費用が膨らまないようにする
  capacity_provider_scaling_config = [{
    max_vcpu_count   = 12
    scaling_mode     = "Auto"
    scaling_policies = null
  }]

  # ロールのポリシーが付く前に作ると、Lambda が EC2 を操作できずに作成が失敗しうる
  depends_on = [aws_iam_role_policy_attachment.lmi_operator]
}
