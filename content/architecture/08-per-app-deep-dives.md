---
slug: per-app-deep-dives
title: Per-app deep-dives — finances, games, landing
excerpt: What's specific to each app in the vanapalli family — the AppSync schema in finances, the score-keeping data model in games, and why landing owns the identity layer.
tags: [architecture, finances, games, landing]
status: published
---

## The plain-English version

The shared layers (identity, DNS, the users table) are covered elsewhere in the [Knowledge Base](/kb). This post is a brief tour of the *app-specific* bits — the stuff each site needed that the others didn't.

If you're trying to map "how would I build something like X" to a concrete starting point, this is the page.

## finances.vanapalli.com

The most ambitious app in the family.

### What it does

Personal-finance app for one or more "groups" (a household, a couple, roommates). Track receipts, build monthly budgets, categorise transactions, see who spent what. The AI angle is small but useful: upload a photo of a receipt, get back vendor / line items / total parsed automatically.

### Stack additions over the baseline

- **AppSync** (covered in [the AppSync post](/posts/appsync-graphql-deep-dive)) — because the data is a real graph and the mobile UI benefits from picking slices per screen.
- **S3 bucket for receipts.** Private, presigned-URL upload from the React app. Receipts are scoped to a group; only group members can read.
- **Secrets Manager for the Gemini API key.** Used by the receipt-parser Lambda. Rotation isn't automated yet but the wiring is in place.
- **A second backend Lambda** dedicated to the AppSync resolver dispatcher — keeps the synchronous request-path code separate from the longer-running AI-parsing code.

### The interesting Terraform shape

```
terraform_finanaces_vanapalli/modules/
├── api_gateway/        # HTTP API in front of REST routes (auth, /me, /receipts)
├── appsync/            # GraphQL API + schema
├── dynamodb/           # budgets, transactions, groups, group-members
├── frontend_hosting/   # S3 + CloudFront for finances.vanapalli.com
├── lambda_api/         # the AppSync resolver Lambda
└── receipts/           # the receipt-parsing pipeline (S3, EventBridge, Lambda)
```

The split between `api_gateway/` and `appsync/` mirrors the split in the code: GraphQL handles structured queries, the REST API handles file upload + presigned URLs + sign-in callbacks.

### One concrete pattern worth borrowing

Group membership is the gate for *every* finances DynamoDB read. The check is a two-line helper:

```ts
// shape from vanapalli_finances/be_finanaces_vanapalli/src/appsync/lib/auth.ts
const sub = callerSub(event);
await requireGroupMembership(input.groupId, sub);
```

Every mutation calls it before touching budgets/transactions. It's deliberately repetitive — the same line in fifty resolvers. The repetition makes the gate impossible to miss in code review.

## games.vanapalli.com

The smallest app, and a good "this is the baseline pattern" example.

### What it does

Score-keeping for casual games. Today: a generic match scoreboard (for any game), and a poker side-pot tracker. Members can join "groups" (friends groups), and matches belong to a group. Leaderboards roll up over time.

### Stack

Pure REST. No GraphQL, no subscriptions. Score-keeping is mostly write-mostly, read-on-demand — exactly the shape REST is good at.

```
terraform_game_vanapalli/modules/
├── api_gateway/        # HTTP API
├── dynamodb/           # matches, poker-tables, groups
├── frontend_hosting/   # S3 + CloudFront
└── lambda_api/         # one Lambda for all routes
```

The `appsync/` module exists in the repo but is currently unused — vestigial from an early prototype where I assumed games would need real-time updates. They don't (yet). When a future game needs live scoreboards, that module gets dusted off.

### One concrete pattern worth borrowing

Matches use a composite primary key — `matchId` as PK, no sort key. Groups own matches via a GSI keyed on `groupId`. That gives two query paths cheaply:

- "Show me this one match" — Get by `matchId`
- "Show me every match in this group, newest first" — Query the GSI with `groupId` + sort key `createdAt DESC`

No `Scan` anywhere in the read path.

The "constant partition key" trick from the [DynamoDB post](/posts/dynamodb-single-table-patterns) shows up here too: poker tables that haven't been claimed live under `pk = "open"` so the lobby is a single `Query`.

## vanapalli.com (landing)

The smallest backend surface — it owns the identity layer and the apex DNS, but its own page is mostly a static React site.

### What it does

- Front-door marketing page for everything I build.
- Owns the Route 53 zone for `vanapalli.com`.
- Owns the Cognito user pool, hosted UI, identity providers (Google sign-in).
- Owns the shared `users` DynamoDB table (display name, `@username`).
- Owns the `/me` REST endpoint that every sibling app proxies for profile reads/writes.

### Stack

```
terraform_vanapalli_landing/
├── modules/
│   ├── dns/            # Route 53 zone, NS records, wildcard ACM cert
│   ├── identity/       # Cognito user pool, app clients, users table
│   ├── frontend_hosting/  # S3 + CloudFront for vanapalli.com
│   └── lambda_api/     # /me API
```

### Why landing owns the identity layer

The first app I built was the landing site. It needed sign-in for the contact-form throttling. By the time I added the second app (games), the obvious move was to *reuse* the existing pool, not stand up a second one. By the third (finances), the pattern was locked in.

If I were starting over today I might split identity into its *own* Terraform project — independent of any "frontend" site — so the landing page isn't the de facto owner of the entire vanapalli auth stack. But splitting it now would be churn for no functional gain, so it stays.

### The auth document

The single most useful artefact in the landing repo is [`AUTH.md`](https://github.com/) (paraphrasing the repo file). It pins down: who owns the pool, where the parameters get published, how a new app onboards, what the rotation story is. Three pages of plain prose that saves an hour of "wait where does this come from" every time I add something.

Every sibling project has its own *consumption*-side `AUTH.md` — the finances repo, the games repo, the blog repo all have one — that says "we read these params, we expect these claims, this is how we gate admin." Three pages × four repos. Beats trying to keep it all in code comments.

## What's the same across all three

The repeating pattern, distilled:

1. **One Lambda per backend.** Hono routes, esbuild bundle, Lambda alias for blue/green.
2. **DynamoDB PAY_PER_REQUEST.** Two or three tables, two GSIs each, point-in-time recovery on.
3. **CloudFront in front of a private S3 bucket** via OAC. ACM cert in `us-east-1`. SPA routing wired to redirect 403/404 → `index.html`.
4. **Three GitHub Actions workflows** per project — terraform-plan, terraform-apply, deploy. (Frontend repos have just deploy; backend repos have deploy plus a CI tests workflow.)
5. **SSM as the bus** between Terraform and code.

You could call the pattern "AWS serverless monorepo, but un-monolithed." Each app is its own monorepo of three folders, each shares the same shape.

## What I'd change next (across the family)

- **A shared `npm` package for the auth middleware** is in place (`@bharatkvanapalli/auth-server`). I'd extend it to include the admin-gate primitive so every app gets the same email-allowlist behaviour for free.
- **A meta-doc** at the root of `vanapalli_all/` that lists every SSM parameter and which project publishes vs. consumes it. Today that knowledge is scattered across AUTH.md files.
- **Per-environment isolation.** Today prod and a future "dev" share more than I'd like (the user pool, the users table). When I onboard a second contributor I'll split those.

---

**Reading this and thinking "I'd love help laying out a stack like this for my own project"?** That's what I do — [System Think Van LLC](https://systemthinkvan.com), [bharat@systemthinkvan.com](mailto:bharat@systemthinkvan.com).
