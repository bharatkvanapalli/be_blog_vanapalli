---
slug: dynamodb-single-table-patterns
title: DynamoDB without the dogma — the patterns I actually use
excerpt: Primary keys, GSIs, and the "constant partition key" trick I use for the admin inbox. With the real tables behind blog.vanapalli.com.
tags: [architecture, dynamodb, aws]
status: published
---

## The plain-English version

DynamoDB is AWS's "give me a key, get back a row" database. It's fast, cheap, and infinitely scalable as long as you don't need SQL. The catch: you design the **shape of your queries up front**, not the shape of your data. There's no "I'll just JOIN" escape hatch.

This post is the patterns I actually reach for — not the famous "single-table design" essays that involve fifteen entity types crammed onto one PK. Those work for Amazon-scale catalogues. For a personal-scale app, simpler is better.

## The three things you tune

1. **Primary key.** A single attribute (`postId`) or a hash+range pair (`groupId`, `transactionId`). DynamoDB only lets you query by primary key directly.
2. **Global Secondary Indexes (GSIs).** A second "view" of the table, keyed differently. You pay for storage and a tiny extra write cost; you get a new query path.
3. **What you project into a GSI.** Full record vs. keys-only vs. specific attributes. Smaller projections = cheaper writes.

If a query doesn't fit a primary key or a GSI, your options are: (a) add a GSI, (b) `Scan` the table (slow + expensive), or (c) restructure. (c) is usually the right answer.

## The blog's tables

Two tables back this site:

```hcl
# vanapalli_blog/terraform_blog_vanapalli/modules/dynamodb/main.tf
resource "aws_dynamodb_table" "posts" {
  name         = "${local.prefix}-posts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "postId"

  attribute { name = "postId"      type = "S" }
  attribute { name = "slug"        type = "S" }
  attribute { name = "status"      type = "S" }
  attribute { name = "publishedAt" type = "S" }

  global_secondary_index {
    name            = "slug-index"
    hash_key        = "slug"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "status-publishedAt-index"
    hash_key        = "status"
    range_key       = "publishedAt"
    projection_type = "ALL"
  }
}
```

Two GSIs, both deliberate:

- `slug-index` — answers "fetch the post whose URL slug is `vanapalli-architecture-overview`." The reader hits this on every page load.
- `status-publishedAt-index` — answers "list every published post, newest first." The home page hits this on every page load.

Drafts never appear in the second index. Why? **DynamoDB only indexes a row in a GSI when *both* the hash key and the range key are present.** A draft has no `publishedAt`, so it's invisible to the public-list query *for free* — no `FilterExpression` needed.

```ts
// vanapalli_blog/be_blog_vanapalli/src/types/index.ts
export interface Post {
  postId: string;
  slug: string;
  status: "draft" | "published";
  publishedAt?: string;   // only set when published
  // …
}
```

That single decision saves a per-request scan-and-filter and keeps drafts genuinely private.

## The "constant partition key" trick

The messages table (contact form submissions) needs a different kind of query: "list the most recent N messages, newest first." There's no natural partition for that — every submission is independent.

The lazy answer is `Scan`. It works at low volume but degrades as the table grows. The better answer is a GSI with a *constant* hash key:

```ts
// vanapalli_blog/be_blog_vanapalli/src/types/index.ts
export interface Message {
  messageId: string;
  pk: "m";              // ← constant. Every row has the same value.
  createdAt: string;
  // …name, email, body, etc.
}
```

The matching GSI in Terraform:

```hcl
global_secondary_index {
  name            = "createdAt-index"
  hash_key        = "pk"
  range_key       = "createdAt"
  projection_type = "ALL"
}
```

Now the admin inbox is a `Query`, not a `Scan`:

```ts
await ddb.send(new QueryCommand({
  TableName: messagesTable,
  IndexName: "createdAt-index",
  KeyConditionExpression: "pk = :p",
  ExpressionAttributeValues: { ":p": "m" },
  ScanIndexForward: false,    // newest first
  Limit: 25,
}));
```

The trade-off: every message lands in the same partition. That's a problem at high volume (DynamoDB has a 1000 WCU / 3000 RCU per partition cap), but the inbox sees tens-per-day. The simple model wins until it doesn't.

When it doesn't (say, 1M messages/day), the migration is: shard the constant partition into N buckets (`m_0`, `m_1`, …), query each in parallel. Same pattern, different cardinality.

## The shared users table

Owned by landing, read by everyone:

```ts
export interface UserProfile {
  userId: string;        // PK
  email: string;
  profileName?: string;
  username?: string;
  usernameLower?: string;
  profileCompleted: boolean;
}
```

With a GSI on `usernameLower`:

```hcl
global_secondary_index {
  name            = "usernameLower-index"
  hash_key        = "usernameLower"
  projection_type = "ALL"
}
```

That index answers "is this username taken?" The `Lower` variant lets the check be case-insensitive without storing two copies — the canonical row keeps the user's casing for display.

## Slug uniqueness, the boring way

Slug uniqueness is the one place I'd consider single-table design (slugs as their own entity row with a `ConditionCheck`). Instead I do best-effort:

```ts
// vanapalli_blog/be_blog_vanapalli/src/routes/admin-posts.ts
const existing = await ddb.send(new QueryCommand({
  TableName: config.postsTable,
  IndexName: config.postsSlugIndex,
  KeyConditionExpression: "slug = :s",
  ExpressionAttributeValues: { ":s": parsed.data.slug },
  Limit: 1,
}));
if ((existing.Items ?? []).length > 0) {
  throw new HTTPException(409, { message: "slug already in use" });
}
```

This has a theoretical race condition (two creates with the same slug at the exact same second). Single-author blog — never going to happen. If it ever becomes a multi-author site, I switch to a sentinel row + `TransactWriteItems`. Until then, two seconds of code beats half an hour of correctness pedantry.

## Cost realities

PAY_PER_REQUEST billing on this blog: under a dollar a month. Point-in-time recovery enabled, server-side encryption with the AWS-managed key, no provisioned throughput to forget about. The whole "DynamoDB is expensive" reputation comes from teams who over-provisioned RCUs/WCUs and never turned them down.

## What I'd change next

- **Add a `tag-index` GSI** on the posts table so the [Knowledge Base view](/kb) can `Query` instead of fetching all posts and filtering client-side. Currently the public list is small enough that I don't bother — but I'll regret that around post #50.
- **TTL on draft posts.** A draft sitting for six months is probably a bad idea I should be reminded of. `expiresAt` + DynamoDB TTL would auto-delete after a year.
- **A read-only IAM role for analytics.** Today everything reads/writes through the Lambda role. A separate role for any future analytics job would shrink the blast radius.

---

**Need help shaping a DynamoDB access pattern for a real workload?** [System Think Van LLC](https://systemthinkvan.com) does this work — [bharat@systemthinkvan.com](mailto:bharat@systemthinkvan.com).
