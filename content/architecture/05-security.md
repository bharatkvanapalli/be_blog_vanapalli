---
slug: security-defaults
title: Security defaults that ship by default
excerpt: CloudFront OAC, private S3, least-privilege IAM, no secrets in code — the boring practices that keep a small AWS stack safe.
tags: [architecture, security, aws]
status: published
---

## The plain-English version

Most production breaches are not exotic. They're a public S3 bucket, a leaked API key in a public repo, an IAM role with `AdministratorAccess`, or a server with a port nobody remembers exposing. The fix isn't a security product — it's a set of *defaults* that ship with every project, so the unsafe option is hard to reach.

This is the list of defaults that every vanapalli site starts with. Each one comes from Terraform — nothing is "remember to click this in the AWS console."

## 1. The frontend bucket is private. Always.

The S3 bucket that hosts a built React app is **not** a website bucket. It's a regular bucket with public access fully blocked. CloudFront fetches objects via an Origin Access Control (OAC) — a SigV4-signed identity that only CloudFront has.

```hcl
# vanapalli_finances/terraform_finanaces_vanapalli/modules/frontend_hosting/main.tf
resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}
```

The `AWS:SourceArn` condition is what makes this safe. Without it, *any* CloudFront distribution in *any* AWS account could read the bucket if it knew the name. With it, only **this specific distribution** can.

## 2. Least-privilege IAM for every Lambda

Every Lambda gets a custom IAM role with explicit table ARNs and specific actions. Never `dynamodb:*`, never `Resource: *`.

```hcl
# vanapalli_finances/terraform_finanaces_vanapalli/modules/lambda_api/main.tf
data "aws_iam_policy_document" "lambda" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [
      aws_dynamodb_table.budgets.arn,
      "${aws_dynamodb_table.budgets.arn}/index/*",
      aws_dynamodb_table.transactions.arn,
      "${aws_dynamodb_table.transactions.arn}/index/*",
    ]
  }

  statement {
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.receipts.arn}/*"]
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${aws_secretsmanager_secret.gemini.arn}-*"]
  }
}
```

Three things to notice:

1. The DynamoDB statement is **per-table**, with GSI ARNs explicit (`/index/*`).
2. S3 actions are scoped to the receipts bucket — the Lambda can't read the frontend bucket even if it tries.
3. Secrets are scoped with a `-*` suffix because Secrets Manager appends a 6-char random ID to every version ARN. Without the wildcard, the policy breaks when the secret rotates.

A Lambda compromised by a supply-chain attack can do exactly what the policy says — no more.

## 3. No secrets in code, no secrets in env files

Two flavours of secret-ish thing:

- **Configuration** (table names, API URLs, pool IDs) lives in **SSM Parameter Store**. Free, versioned, IAM-controlled. Read at Lambda boot or fetched by CI at deploy time.
- **True secrets** (API keys, OAuth client secrets) live in **AWS Secrets Manager**. Encrypted with a KMS key, auto-rotatable, audited.

Neither lives in the repo. Neither lives in a `.env` file shipped to the user's laptop. The frontend reads SSM at build time during CI:

```yaml
# vanapalli_blog/fe_blog_vanapalli/.github/workflows/deploy.yml
- name: Load build env from SSM
  run: |
    echo "VITE_API_BASE_URL=$(aws ssm get-parameter \
      --name /vanapalli/prod/blog/api-base-url \
      --query Parameter.Value --output text)" >> $GITHUB_ENV
    echo "VITE_ADMIN_EMAILS=$(aws ssm get-parameter \
      --name /vanapalli/prod/blog/admin-emails \
      --with-decryption --query Parameter.Value --output text)" >> $GITHUB_ENV
```

GitHub never sees a static config file. The build job pulls fresh values on every deploy. Rotating an admin email is one SSM put + one workflow re-run.

## 4. TLS everywhere, no exceptions

Every site has an ACM certificate (free) in `us-east-1` (CloudFront's required region) and one ACM cert in the home region for API Gateway custom domains. DNS validation, auto-renewed.

The CloudFront distribution rejects anything below TLSv1.2:

```hcl
viewer_certificate {
  acm_certificate_arn      = var.cert_arn
  minimum_protocol_version = "TLSv1.2_2021"
  ssl_support_method       = "sni-only"
}
```

API Gateway HTTP APIs default to TLSv1.2; no extra config needed.

## 5. CORS that says no by default

The blog API allows exactly two origins: `https://blog.vanapalli.com` (production) and the local dev URL. Everything else gets a CORS rejection. No `Access-Control-Allow-Origin: *`.

```ts
// vanapalli_blog/be_blog_vanapalli/src/app.ts (shape)
app.use("*", cors({
  origin: (origin) =>
    origin === "https://blog.vanapalli.com" || origin === "http://localhost:5173"
      ? origin
      : null,
  credentials: true,
}));
```

The `: null` return is important — Hono's `cors` middleware omits the `Access-Control-Allow-Origin` header entirely when the origin isn't allowed, which is the safer shape than echoing back the request origin.

## 6. Markdown content is sanitised before render

The blog stores arbitrary markdown in DynamoDB. Markdown allows inline HTML — which means a malicious admin (or a future bug in the editor) could embed a `<script>` tag. The render path strips that:

```tsx
// vanapalli_blog/fe_blog_vanapalli/src/pages/PostDetail.tsx (shape)
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeSanitize]}
>
  {post.content}
</ReactMarkdown>
```

`rehype-sanitize` strips `<script>`, `<iframe>`, dangerous `on*` attributes, and `javascript:` URLs. The default schema is opinionated and tight; safe choice.

## 7. The contact form has a honeypot

Bots love contact forms. The blog's form includes a hidden `website` field. Real users never see it; bots that fill every input get a fake-success response:

```ts
// shape from src/routes/messages.ts
if (parsed.data.website && parsed.data.website.length > 0) {
  return c.json({ ok: true }, 201);   // pretend success, write nothing
}
```

No CAPTCHA, no third-party JS, no friction for humans. Has cut bot submissions to roughly zero.

## 8. CloudWatch logs, no log statements that print secrets

Lambda code never logs request bodies, never logs JWT tokens, never logs DynamoDB items wholesale. `@aws-lambda-powertools/logger` is configured to require an explicit `extras` object — you have to opt-in to logging fields, which is the right default.

## What I'd change next

- **WAF on the public API.** Today there's no rate limiting in front of `/posts/:slug/like`. A motivated kid with a script could inflate counts. AWS WAF managed rules + a rate-based rule would fix it cheaply.
- **CloudTrail-driven alerting.** I read CloudWatch logs reactively. A CloudTrail → EventBridge → SNS pipeline for IAM changes ("AdministratorAccess attached to a role") would catch the worst-case scenarios.
- **SOPS for any local secrets.** Not used today (everything is SSM/Secrets Manager) but if I ever onboard a contractor with read access to a repo, I'd want encrypted-at-rest secrets they can decrypt locally with their KMS key.

---

**Want help threading these defaults into your own AWS account?** I do exactly this for clients via [System Think Van LLC](https://systemthinkvan.com) — [bharat@systemthinkvan.com](mailto:bharat@systemthinkvan.com).
