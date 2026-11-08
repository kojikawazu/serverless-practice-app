# メールの送信記録（docs/05「送信記録」・docs/09「送信記録の保存先」）。
# Consumer が送る前に「送信中」、送った後に「送信済み」を書き、再配信で同じメールを送り直さない（#136）

resource "aws_dynamodb_table" "send_records" {
  name = "${local.prefix}-send-records"

  # 置いておくだけの料金がかからない。デモの読み書きは 1 実行で配信対象の数 × 3 回ほど
  billing_mode = "PAY_PER_REQUEST"

  # <実行名>:<配信対象 ID>。SQS の重複排除 ID と同じ値
  hash_key = "messageKey"

  attribute {
    name = "messageKey"
    type = "S"
  }

  # 期限（エポック秒）を過ぎた記録は DynamoDB が非同期に消す。期限ちょうどに消えることを前提にしない
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  # デモの記録は使い捨て。stack.sh <stage> down で消せるよう、削除保護は付けない（docs/04「運用性」）
  deletion_protection_enabled = false
}
