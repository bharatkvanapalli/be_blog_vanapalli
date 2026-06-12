---
slug: common-auth-shared-cognito
title: One Cognito pool, four apps — how common auth works
excerpt: Why a single user pool with per-app clients beats four siloed pools, and the exact JWT-verify + admin-gate code that runs on every request.
tags: [architecture, auth, cognito, aws]
status: published
---

## The plain-English version

When you sign up at `finances.vanapalli.com`, you can sign into `blog.vanapalli.com` with the same email and password — no second account, no second password. That's because every site in the vanapalli family points at the **same Cognito user pool**. There's one set of users, one set of passwords, one hosted-UI sign-in page.

But the apps are also independent. The blog admin permissions don't leak into finances. The finances workspace data doesn't leak into games. The trick is: each app has its own *app client* under the shared pool, and each app validates the *audience* claim on incoming tokens. Same pool, different keys to the front door.

## Why not one pool per app?

I started by drawing it that way and threw the diagram out. Per-app pools sound clean until you actually use them:

- Users have to sign up four times.
- Display names drift between apps.
- "Sign in with Google" has to be wired four times (each pool needs its own OAuth callback list).
- Forgot-password flows are four separate experiences.

A single pool with per-app clients gives you isolation where it matters (audience-scoped JWTs, separate redirect URLs, separate logging) without forcing the user to keep four mental accounts.

## Who owns what

```
terraform_vanapalli_landing  ← owns the user pool, hosted UI, identity providers, shared users table
terraform_blog_vanapalli     ← reads pool ID + blog app client ID from SSM, configures API Gateway authoriser
terraform_finanaces_vanapalli ← same pattern: SSM lookups, app-client-scoped authoriser
terraform_game_vanapalli      ← same
```

The landing Terraform publishes a handful of parameters under `/vanapalli/prod/identity/`:

- `/vanapalli/prod/identity/user-pool-id`
- `/vanapalli/prod/identity/user-pool-arn`
- `/vanapalli/prod/identity/clients/blog/client-id`
- `/vanapalli/prod/identity/clients/finances/client-id`
- `/vanapalli/prod/identity/clients/games/client-id`
- `/vanapalli/prod/identity/users-table-name`

Every other Terraform project reads those, never creates them. That's how new apps onboard: you add a client, publish its ID, and the consumer project picks it up on the next plan.

## What the JWT looks like

Cognito mints a JSON Web Token like this (decoded):

```json
{
  "sub": "8b4e2d2c-…-…-…-…",
  "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXX",
  "aud": "<blog-app-client-id>",
  "email": "you@example.com",
  "email_verified": true,
  "iat": 1718…,
  "exp": 1718…
}
```

The interesting fields:

- `sub` — stable user ID. This is what gets written into DynamoDB rows as `authorSub` or `userId`. **Never** use email as a primary key; emails change, `sub` does not.
- `iss` — issuer. Every app verifies this against the shared pool URL.
- `aud` — audience. The blog API rejects tokens whose `aud` is the games app client, even though both are valid Cognito tokens. That stops cross-app token replay.
- `email` — used for the admin allowlist gate.

## The verify code

Every backend uses the same shared library — `@bharatkvanapalli/auth-server`. It's a small JWT-verifier middleware for Hono. The blog wires it up here:

```ts
// vanapalli_blog/be_blog_vanapalli/src/routes/admin-posts.ts
import { requireAuth, type AuthVariables } from "@bharatkvanapalli/auth-server";
import { requireAdmin } from "../lib/admin.js";

export const adminPostsRoutes = new Hono<{ Variables: AuthVariables }>();
adminPostsRoutes.use("*", requireAuth);
adminPostsRoutes.use("*", requireAdmin);
```

`requireAuth` does three things:

1. Pull the bearer token off the `Authorization` header.
2. Verify the signature against the pool's JWKS (cached in memory between invocations).
3. Verify `iss`, `aud`, and `exp`. If anything fails, throw `401`.

It then stores the parsed claims on the request context so downstream handlers can read `c.get("claims")`.

## The admin gate

JWT verification proves "you are a real user." It does *not* prove "you are allowed to edit posts." That's a second gate:

```ts
// vanapalli_blog/be_blog_vanapalli/src/lib/admin.ts
import { HTTPException } from "hono/http-exception";
import type { Context, Next } from "hono";
import { config } from "./config.js";

export async function requireAdmin(c: Context, next: Next) {
  const claims = c.get("claims") as { email?: string } | undefined;
  const email = claims?.email?.toLowerCase();
  if (!email || !config.adminEmails.has(email)) {
    throw new HTTPException(403, { message: "admin only" });
  }
  await next();
}
```

The allowlist is a comma-separated list in an SSM parameter (`/vanapalli/prod/blog/admin-emails`), loaded into the Lambda's environment by Terraform. Tiny, boring, works.

When the team grows past "me," I'll swap this for a Cognito group check (`cognito:groups` claim contains `"admin"`) and admin assignment moves to the Cognito console. The route shape doesn't change.

## Fine-grained checks inside resolvers

The finances app uses AppSync with a richer pattern: schema-level auth gates *who can call the API at all*, then resolver code does row-level checks. The helpers live here:

```ts
// vanapalli_finances/be_finanaces_vanapalli/src/appsync/lib/auth.ts
export function callerSub(ctx: AppSyncIdentityContext): string {
  const sub = ctx.identity?.sub;
  if (!sub) throw new Error("Unauthenticated");
  return sub;
}

export function requireGroupMembership(
  ctx: AppSyncIdentityContext,
  groupId: string,
  members: string[],
): void {
  if (!members.includes(callerSub(ctx))) {
    throw new Error(`Not a member of group ${groupId}`);
  }
}
```

The pattern: `callerSub` answers "who is this," `requireGroupMembership` answers "are they allowed to touch *this row*." Resolvers compose both before hitting DynamoDB.

## The frontend side

The frontend uses `@bharatkvanapalli/auth-web` (the matching client library):

```tsx
// vanapalli_blog/fe_blog_vanapalli/src/main.tsx
<VanapalliAuthProvider
  app="blog"
  apiBaseUrl={env.apiBaseUrl}
  loadProfile={() => usersApi.me()}
>
```

That single line wires up:

- Amplify Auth pointing at the shared pool with the blog client ID
- The hosted-UI sign-in/sign-up/forgot-password flows
- An auto-fetch of the shared profile row on sign-in (so display name shows up immediately)
- The fetch wrapper that attaches the ID token to every API call

The same provider is used by finances and games, just with a different `app` prop. The library reads the corresponding client ID from the env at build time.

## What I'd change next

- **Cognito groups for admin.** Already mentioned — the allowlist works at scale of one. Two admins and I'm switching.
- **Refresh-token rotation.** Default in Amplify is "rotate on refresh." I should double-check that's still on after the last Amplify upgrade.
- **A staging pool.** Today prod and dev share a pool. If I ever onboard a teammate, that mixing gets awkward.

---

**Want help wiring shared identity into your own multi-app stack?** I do that for a living through [System Think Van LLC](https://systemthinkvan.com) — [bharat@systemthinkvan.com](mailto:bharat@systemthinkvan.com).
