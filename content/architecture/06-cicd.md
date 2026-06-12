---
slug: cicd-pipelines
title: CI/CD: how each push becomes a deploy
excerpt: Terraform plan/apply, Lambda zip + version + alias, S3 sync + CloudFront invalidation — the GitHub Actions that make "git push" mean "live in 90 seconds."
tags: [architecture, cicd, aws, github-actions]
status: published
---

## The plain-English version

When I push to `main`, three things happen, independently, in three different GitHub repos:

1. **Terraform** plans and applies infrastructure changes.
2. **Backend** builds a Lambda zip, uploads it, publishes a new version, and flips an alias.
3. **Frontend** builds a React bundle, syncs it to S3, and tells CloudFront to forget the old `index.html`.

End-to-end: 60–90 seconds per project. No EC2 to keep alive, no Kubernetes to operate, no "deploy server." GitHub Actions runs the script, AWS runs the result.

## The three pipelines

Each project has its own. They never call each other. The contract between them is **SSM parameters** — Terraform publishes table names, API URLs, and bucket IDs; the backend and frontend pipelines read them at deploy time.

### Pipeline 1 — Terraform

```yaml
# vanapalli_finances/terraform_finanaces_vanapalli/.github/workflows/plan.yml
name: terraform plan
on: pull_request
jobs:
  plan:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init -backend-config="..."
        working-directory: environments/prod
      - run: terraform plan -out=tfplan
        working-directory: environments/prod
      - uses: actions/github-script@v7
        with:
          script: |
            // post the plan as a PR comment
```

On `pull_request`, plan + comment. On merge to `main`, `apply.yml` runs the same flow with `terraform apply -auto-approve`.

Two safety nets:

- **OIDC, not long-lived access keys.** `id-token: write` lets the runner mint a short-lived token GitHub trades with AWS STS for temporary credentials. No `AWS_SECRET_ACCESS_KEY` stored anywhere.
- **Remote state with locking.** The Terraform backend is S3 + DynamoDB. The DynamoDB lock prevents two simultaneous applies from racing each other, even if I accidentally merge two PRs at once.

### Pipeline 2 — Backend (Lambda)

```yaml
# vanapalli_blog/be_blog_vanapalli/.github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build       # esbuild → dist/index.mjs
      - run: |
          cd dist && zip -r ../lambda.zip . -x "*.map" && cd ..
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}, aws-region: us-east-1 }
      - name: Resolve Lambda function name
        run: |
          FN=$(aws ssm get-parameter \
            --name /vanapalli/prod/blog/lambda-function-name \
            --query Parameter.Value --output text)
          echo "FN_NAME=$FN" >> $GITHUB_ENV
      - name: Update + publish + alias
        run: |
          aws lambda update-function-code \
            --function-name "$FN_NAME" \
            --zip-file fileb://lambda.zip > /dev/null
          aws lambda wait function-updated --function-name "$FN_NAME"
          VERSION=$(aws lambda publish-version \
            --function-name "$FN_NAME" \
            --query Version --output text)
          aws lambda update-alias \
            --function-name "$FN_NAME" \
            --name live \
            --function-version "$VERSION"
      - name: Smoke test
        run: curl -fsS "https://api.blog.vanapalli.com/health"
```

A few things worth highlighting:

- **The pipeline doesn't know the function name.** It reads from SSM (`/vanapalli/prod/blog/lambda-function-name`). That parameter was written by Terraform. If I ever rename the Lambda in Terraform, the deploy still works — no two-place edit.
- **Publish version + update alias** is what makes rollback one click. Every deploy creates an immutable Lambda version (`:42`, `:43`, …). The `live` alias points at the newest. To roll back, I `update-alias` to a previous version — no rebuild, no code change.
- **Smoke test** hits `/health`. If the new code throws on cold start, the test fails and the deploy is marked red. The alias still points to the bad version (manual intervention required) — automated rollback is on my "would be nice" list.

### Pipeline 3 — Frontend (S3 + CloudFront)

```yaml
# vanapalli_blog/fe_blog_vanapalli/.github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}, aws-region: us-east-1 }
      - name: Load build env from SSM
        run: |
          echo "VITE_API_BASE_URL=$(aws ssm get-parameter \
            --name /vanapalli/prod/blog/api-base-url \
            --query Parameter.Value --output text)" >> $GITHUB_ENV
          # …more SSM lookups
      - run: npm run build
      - name: Sync hashed assets (1 year)
        run: |
          aws s3 sync dist/ s3://"$BUCKET"/ \
            --exclude "index.html" \
            --cache-control "public,max-age=31536000,immutable"
      - name: Sync index.html (no cache)
        run: |
          aws s3 cp dist/index.html s3://"$BUCKET"/index.html \
            --cache-control "no-cache,no-store,must-revalidate"
      - name: Invalidate index.html
        run: |
          aws cloudfront create-invalidation \
            --distribution-id "$CF_DIST_ID" \
            --paths /index.html
```

The cache strategy:

- Hashed assets (`app-d3f8a2.js`) are served with `max-age=31536000,immutable`. The browser caches them forever. Safe because their name changes when their content changes.
- `index.html` is served with `no-cache`. The browser always re-fetches. CloudFront also caches it, so we explicitly invalidate `/index.html` after upload.

The invalidation is the only "wait" in the deploy — CloudFront takes a few seconds to propagate. Everything else is fire-and-forget.

## What about Terraform → Lambda coupling?

The Terraform module that creates the Lambda function ships with a **placeholder zip** so the resource can be created before any code exists:

```hcl
# vanapalli_finances/terraform_finanaces_vanapalli/modules/lambda_api/main.tf
resource "aws_lambda_function" "this" {
  function_name = "${var.project}-${var.env}-api"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]

  filename = "${path.module}/files/placeholder.zip"

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}
```

The `lifecycle.ignore_changes` is critical. Without it, every Terraform apply would *also* try to re-deploy the placeholder zip and undo the backend pipeline's work. With it, Terraform owns the function's configuration (memory, env vars, role) and the backend pipeline owns the function's code. Clean separation.

## What I'd change next

- **Cached `node_modules`.** Each pipeline does a fresh `npm ci`. A keyed cache on `package-lock.json` hash would save 30s per run.
- **Auto-rollback on failed smoke test.** Right now a bad deploy stays live until I notice. The fix is small: catch the smoke-test failure, flip the alias back to the previous version, exit non-zero.
- **Concurrency groups.** Two rapid pushes can race in the alias-flip step. `concurrency: deploy-blog-prod` on the workflow would queue them.
- **Drift detection** for Terraform — a nightly `terraform plan` that posts a Slack message if the deployed infra has drifted from main.

---

**Want a deploy pipeline this clean for your own AWS project?** [System Think Van LLC](https://systemthinkvan.com) builds them — [bharat@systemthinkvan.com](mailto:bharat@systemthinkvan.com).
