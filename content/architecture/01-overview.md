---
slug: vanapalli-architecture-overview
title: How vanapalli.com is built — a tour of the four-site stack
excerpt: One identity, one apex domain, four small apps. A plain-English tour of how the pieces fit together.
tags: [architecture, overview, aws]
status: published
---

## Why this post exists

Most of what I build lives under `vanapalli.com`. There's a landing site, a blog (you're reading it), a finances app, and a small games site. They look like four separate things, but under the hood they share one identity, one DNS zone, one TLS strategy, and a small set of repeated patterns.

This post is the map. The rest of the series ([Knowledge Base](/kb)) zooms into each piece — auth, AppSync, DynamoDB, security, CI/CD — with real code snippets pulled from the repos.

If you're not technical, the takeaway is: every "app" is really a thin shell on top of the same plumbing. That's why I can ship a new one in a weekend instead of a quarter.

## The four sites

| Site | URL | What it is |
|---|---|---|
| Landing | `vanapalli.com` | Marketing front door. Owns the apex DNS, the shared Cognito user pool, and the shared "users" table. |
| Blog | `blog.vanapalli.com` | This site. Markdown posts in DynamoDB, admin CRUD over an HTTP API. |
| Finances | `finances.vanapalli.com` | Personal finances app. Receipts, budgets, groups, AI categorisation. |
| Games | `games.vanapalli.com` | Score-keeping for casual games (poker, card games). |

They each have three repos: a **frontend** (Vite + React), a **backend** (Node + Hono on Lambda), and a **Terraform** project that owns the AWS infra.

## What's shared vs. what's per-app

Three things are shared across every site:

1. **Identity.** One Cognito user pool, owned by the landing Terraform project. Each app has its own *app client* — so a sign-in on `finances.vanapalli.com` and a sign-in on `blog.vanapalli.com` are the same account, but the issued JWTs have different audiences.
2. **DNS apex.** The Route 53 zone for `vanapalli.com` lives in landing. Every other project *data-sources* it instead of creating its own. That's how subdomains get added without anybody fighting for ownership of the zone.
3. **The "users" DynamoDB table.** Display name, `@username`, profile-completed flag. Every app reads and writes the same row when you sign in, so changing your name in one app changes it everywhere.

Everything else (DynamoDB tables, S3 buckets, Lambdas, CloudFronts) is per-app. That keeps blast radius small: a bug in the games API can't drop the finances tables.

The auth document that pins this down lives in the landing repo:

```
vanapalli_landing/terraform_vanapalli_landing/AUTH.md
```

That file is the source of truth for who owns the user pool, where the client IDs are published, and how a new sibling app onboards.

## How the apex domain works

The landing Terraform creates the Route 53 zone *only* in prod. Every other environment data-sources it:

```hcl
# vanapalli_landing/terraform_vanapalli_landing/modules/dns/main.tf
resource "aws_route53_zone" "this" {
  count = var.create_zone ? 1 : 0
  name  = var.apex_domain
}

data "aws_route53_zone" "existing" {
  count        = var.create_zone ? 0 : 1
  name         = var.apex_domain
  private_zone = false
}
```

Why? Because Route 53 hosted zones are *not* idempotent — if two Terraform projects each `aws_route53_zone "this"`, you end up with two zones, two sets of nameservers, and broken DNS. The `create_zone` flag is a one-time switch: prod creates, every other environment reads.

Each app then mints its own ACM cert in `us-east-1` (CloudFront's required region) for its subdomain. The cert validation records are written into the shared zone via DNS challenge.

## The data path: from your browser to a DynamoDB row

Take "open a post on the blog" as an example. Here's what happens:

1. **DNS.** Your browser resolves `blog.vanapalli.com` against the shared Route 53 zone → CloudFront IP.
2. **CDN.** CloudFront serves the cached `index.html` (no-cache header) and the hashed JS bundles (immutable, year-long cache).
3. **API call.** The React app calls `api.blog.vanapalli.com/posts/<slug>`. That's API Gateway HTTP API in front of a Lambda running Hono.
4. **DynamoDB.** Hono queries the `slug-index` GSI on the posts table. One row comes back.
5. **Render.** React renders the markdown with `react-markdown` + `rehype-sanitize` so any HTML in the content can't escape its sandbox.

If you're signed in, step 3 also carries a Cognito JWT in the `Authorization` header. The Lambda verifies it against the shared user pool, then decides what to allow based on the claims.

For a *write* (admin edits a post), the same path runs through a JWT verifier and then a `requireAdmin` middleware that checks the caller's email against a small allowlist published to SSM. We'll go deep on that in the [common-auth post](/posts/common-auth-shared-cognito).

## The repo layout

Each "site" has three sibling folders:

```
vanapalli_blog/
  be_blog_vanapalli/          # Node + Hono backend
  fe_blog_vanapalli/          # Vite + React frontend
  terraform_blog_vanapalli/   # AWS infra
```

The frontend never imports the backend (they ship at different times). The Terraform never imports either (it consumes their build artefacts via SSM). The only cross-repo coupling is **SSM parameters** — Terraform publishes (table names, API URLs, pool IDs), code reads.

## What I'd change next

- **Pre-warm pipelines.** Each app re-installs `node_modules` on every CI run. A cached layer would shave a minute off every deploy.
- **Cross-app observability.** Right now each app's CloudWatch logs are siloed. A single Log Insights query that spans all four would help when chasing auth bugs.
- **A meta-Terraform project** that owns the SSM parameters every app reads. Today the landing project both creates the pool *and* publishes the SSM params; I'd split those.

## What's in the rest of the series

- [Common auth — one Cognito pool, four apps](/posts/common-auth-shared-cognito)
- [AppSync GraphQL deep-dive](/posts/appsync-graphql-deep-dive)
- [DynamoDB single-table patterns](/posts/dynamodb-single-table-patterns)
- [Security defaults that ship by default](/posts/security-defaults)
- [CI/CD: how this site gets deployed](/posts/cicd-pipelines)
- [Inside the blog itself](/posts/the-blog-itself)
- [Per-app deep-dives: finances, games, landing](/posts/per-app-deep-dives)

---

**Want help building something like this?** I run [System Think Van LLC](https://systemthinkvan.com) and take on consulting projects around AWS architecture, serverless apps, and small teams that need to ship fast. Drop a line at [bharat@systemthinkvan.com](mailto:bharat@systemthinkvan.com).
