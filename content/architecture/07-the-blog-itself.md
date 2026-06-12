---
slug: the-blog-itself
title: Inside the blog — Hono on Lambda, React on CloudFront, markdown in DynamoDB
excerpt: How this site you're reading is built. Route shapes, admin gating, and how a post goes from a markdown file to a public URL.
tags: [architecture, blog, hono, lambda, react]
status: published
---

## The plain-English version

This site is on purpose the *boring* one. It's a personal blog — there's no need for AppSync, no need for subscriptions, no need for a CMS. Markdown content sits in DynamoDB, a tiny Node API reads it, a React app renders it. Total moving parts: small.

That said, the boring choices add up to something I'm proud of: the admin UI works on a phone, posts render in under a second from a CDN, and adding a new post is one form submission *or* one `npm run seed:content` away. The whole thing costs about $1.20/month at my traffic levels.

## The shape

```
┌──────────────────────┐      ┌──────────────────────┐
│  CloudFront          │ ───▶ │  S3 (private)        │   ← React bundle
│  blog.vanapalli.com  │      └──────────────────────┘
└─────────┬────────────┘
          │
          │ API calls
          ▼
┌──────────────────────┐      ┌──────────────────────┐
│  API Gateway HTTP    │ ───▶ │  Lambda (Hono)       │
│  api.blog.vanapalli  │      │  Node 20, arm64      │
└──────────────────────┘      └──────────┬───────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  DynamoDB           │
                              │  posts, messages    │
                              └─────────────────────┘
```

Three Lambdas? No — **one Lambda** handling every route. Hono is small enough that the cold start is ~150ms. Splitting per-route would multiply cold starts without paying for it elsewhere.

## The Hono app

The whole API entry point is short enough to fit on one screen:

```ts
// vanapalli_blog/be_blog_vanapalli/src/app.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { postsRoutes } from "./routes/posts.js";
import { adminPostsRoutes } from "./routes/admin-posts.js";
import { messagesRoutes } from "./routes/messages.js";
import { meRoutes } from "./routes/me.js";

export const app = new Hono();

app.use("*", logger());
app.use("*", cors({ /* …allowed origins… */ }));

app.get("/health", (c) => c.json({ ok: true }));

app.route("/posts", postsRoutes);              // public
app.route("/admin/posts", adminPostsRoutes);   // gated by requireAuth + requireAdmin
app.route("/messages", messagesRoutes);        // public POST + admin GET
app.route("/me", meRoutes);                    // requires auth (any user)

export default app;
```

The Lambda handler imports `app` and wraps it in the Hono → API Gateway adapter:

```ts
// vanapalli_blog/be_blog_vanapalli/src/handler.ts (shape)
import { handle } from "hono/aws-lambda";
import { app } from "./app.js";
export const handler = handle(app);
```

## Public vs. admin

Split by route prefix. The public routes don't require auth at all — API Gateway is configured with `authorization_type = "NONE"` for them. The admin routes use the same Lambda but enforce auth inside Hono:

```ts
// vanapalli_blog/be_blog_vanapalli/src/routes/admin-posts.ts
adminPostsRoutes.use("*", requireAuth);
adminPostsRoutes.use("*", requireAdmin);
```

API Gateway *could* do the JWT check itself (HTTP APIs support Cognito authorisers). I chose to do it inside the Lambda for two reasons:

1. The same code path runs locally during tests — no need to spin up a fake authoriser.
2. The admin email allowlist already lives in the Lambda's env. Running both checks in one place keeps the gate co-located.

The trade-off: a bad token still costs a Lambda invocation. At my volume that's fine; for a high-traffic API, API-Gateway-level auth saves money.

## A write, end to end

A `PUT /admin/posts/:id` from the admin UI:

1. **Frontend** calls `adminPostsApi.update(id, { title: "…", content: "…", status: "published" })`. The shared `auth-web` fetch wrapper attaches the user's ID token.
2. **API Gateway** routes it to the Lambda. No edge-level auth check.
3. **Hono** matches `PUT /admin/posts/:id`. `requireAuth` parses and verifies the JWT (JWKS cached in memory). `requireAdmin` checks the email against the allowlist.
4. **Validation.** `postUpdateSchema.safeParse(body)` — a Zod schema rejects missing/extra fields.
5. **Slug uniqueness re-check** (if the slug changed). One `Query` on the `slug-index` GSI.
6. **DynamoDB UpdateCommand.** Atomic update with `ConditionExpression: "attribute_exists(postId)"` so a deleted post can't be re-created via an update.
7. **publishedAt** is stamped to "now" if the status flipped draft → published. That makes the row sortable in the `status-publishedAt-index`.
8. **Response.** Updated row goes back to the frontend; React Query invalidates its cache.

The whole thing typically runs in 40–80ms server-side after a warm cold start.

## How posts get into the table

Two paths now:

### Path A — the admin UI

Sign in to `blog.vanapalli.com`, hit `/admin`, click "New post." The form is `react-hook-form` + `zod` + a live markdown preview. Save flips status; "Publish" sets `publishedAt`.

### Path B — markdown files in the repo

For the [Architecture series](/kb) (this post included), the source of truth is a markdown file under `be_blog_vanapalli/content/architecture/`. A small seed script reads each `.md`, parses frontmatter with `gray-matter`, and upserts into DynamoDB:

```ts
// vanapalli_blog/be_blog_vanapalli/scripts/seed-content.ts
const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"));
for (const file of files) {
  const { data: fm, content } = matter(readFileSync(join(CONTENT_DIR, file), "utf8"));
  const existing = await findExistingPostId(fm.slug);
  if (existing) {
    await ddb.send(new UpdateCommand({ /* update title/content/tags/status */ }));
  } else {
    await ddb.send(new PutCommand({ /* new postId, set publishedAt */ }));
  }
}
```

Run with:

```
AWS_PROFILE=… POSTS_TABLE_NAME=vbl-prod-posts SEED_AUTHOR_SUB=<sub> npm run seed:content
```

Re-running is safe — it upserts by slug. Both paths can co-exist for the same post: the seed script lays down the initial version, and the admin UI is fine to edit afterwards.

## The frontend, briefly

Vite + React + Tailwind + React Router + React Query. Two cuts worth mentioning:

- **Admin routes are lazy-loaded.** The markdown editor pulls in `react-markdown` + a syntax highlighter, which is heavy. Public readers never download that chunk.

```tsx
// vanapalli_blog/fe_blog_vanapalli/src/main.tsx
const AdminPosts = lazy(() => import("./pages/admin/AdminPosts"));
const AdminPostNew = lazy(() => import("./pages/admin/AdminPostNew"));
```

- **`useIsAdmin()` is a build-time check.** The admin email list is baked into the bundle at deploy time (via the SSM fetch in the deploy workflow). So the admin nav links render the instant React mounts — no network round-trip.

## What I'd change next

- **Tag-based filter on the public list.** The [`/kb`](/kb) view filters posts client-side today. Once there are enough posts, I'll add a `tag-index` GSI and push the filter to DynamoDB.
- **Image hosting.** Posts can include external image URLs, but I don't have an S3 bucket for blog assets yet. A `uploads.blog.vanapalli.com` bucket + signed URLs is a one-evening project.
- **RSS feed.** A `/rss.xml` endpoint that re-uses the same `status-publishedAt-index` query. Cheap, useful, surprising how often people still subscribe via RSS.
- **A "draft preview" share link.** Today a draft is admin-only. A signed magic-link URL would let me get feedback before publishing.

---

**Building a content site and want it to be this lightweight?** I do small-team consulting for projects like this through [System Think Van LLC](https://systemthinkvan.com) — [bharat@systemthinkvan.com](mailto:bharat@systemthinkvan.com).
