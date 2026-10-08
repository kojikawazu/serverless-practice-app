# データ連携の出力先バケット（docs/05「連携ファイル」・docs/06「データ保護」）

resource "aws_s3_bucket" "exports" {
  # バケット名は全アカウントで一意のため、アカウント ID を付ける（docs/10「命名」）
  bucket = "${local.prefix}-exports-${local.account_id}"

  # デモの出力は使い捨て。削除時（CDK → Terraform の順）に中身ごと消し、残骸を残さない（docs/04「運用性」）
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "exports" {
  bucket = aws_s3_bucket.exports.id

  # ACL を無効にし、アクセス制御をバケットポリシーと IAM に一本化する
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket = aws_s3_bucket.exports.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    id     = "expire-exports"
    status = "Enabled"

    filter {
      prefix = "exports/"
    }

    # 連携ファイルは 7 日で消す（docs/04「保持期間」）
    expiration {
      days = 7
    }
  }
}

# HTTPS 以外のアクセスを拒否する
data "aws_iam_policy_document" "exports_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.exports.arn,
      "${aws_s3_bucket.exports.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "exports" {
  bucket = aws_s3_bucket.exports.id
  policy = data.aws_iam_policy_document.exports_tls_only.json

  # 公開ブロックを先に適用してからポリシーを付ける
  depends_on = [aws_s3_bucket_public_access_block.exports]
}
