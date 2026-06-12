---
slug: appsync-graphql-deep-dive
title: AppSync, explained for humans — and why finances uses it
excerpt: When GraphQL beats REST, how AppSync glues a Cognito-signed schema to Lambda resolvers, and the real snippets that power finances.vanapalli.com.
tags: [architecture, appsync, graphql, aws]
status: published
---

## The plain-English version

GraphQL is a way of asking an API for *exactly* the data you want and nothing else. Instead of a fixed `/budgets/123` endpoint that returns a fixed shape, you say "give me budget 123's name, its monthly limit, and the last three transactions." The server figures out how to fetch each piece.

**AppSync** is AWS's managed GraphQL service. You hand it a schema and a bunch of "resolvers" (functions that fetch each field), and it gives you back a fully hosted endpoint with authentication, subscriptions, and caching built in. You never run a GraphQL server yourself.

The finances app uses AppSync because budgets, groups, members, and transactions form a real graph. The blog doesn't, because posts are flat — REST is fine. **Pick the tool for the shape of your data, not because GraphQL is trendy.**

## Why finances picked AppSync

Three things sealed it:

1. **The data is genuinely a graph.** A group has members, who have profiles, who have transactions, which belong to budgets. The mobile UI wants different slices on different screens. With REST I'd have written six bespoke endpoints; with GraphQL the client picks the slice.
2. **Real-time updates.** AppSync ships GraphQL *subscriptions* over WebSocket. When my wife adds a transaction on her phone, my screen updates in under a second. No polling, no DIY pub/sub.
3. **Schema-level auth.** AppSync lets you annotate types with Cognito auth directly. The gate at the door is declarative, not buried in middleware.

## What the schema looks like

The full schema is ~680 lines. Here's the shape of one type to show the pattern:

```graphql
# vanapalli_finances/terraform_finanaces_vanapalli/modules/appsync/schema.graphql
type Budget
  @aws_cognito_user_pools
{
  budgetId: ID!
  groupId: ID!
  name: String!
  monthlyLimit: Float!
  currency: String!
  createdAt: AWSDateTime!
  transactions(limit: Int, nextToken: String): TransactionConnection
}

type Mutation {
  createBudget(input: CreateBudgetInput!): Budget!
    @aws_cognito_user_pools
}

type Subscription {
  onBudgetUpdated(groupId: ID!): Budget
    @aws_subscribe(mutations: ["updateBudget", "deleteBudget"])
    @aws_cognito_user_pools
}
```

Three things to notice:

- `@aws_cognito_user_pools` on the type means: a valid Cognito JWT is required to read any field on this type. AppSync rejects the request *before* a resolver fires.
- The nested `transactions` field is its own resolver. It runs only if the client actually asks for it — that's GraphQL's main win.
- `@aws_subscribe` declares a real-time stream tied to specific mutations. AppSync handles the WebSocket plumbing.

## How resolvers are wired

AppSync ships two flavours of resolver: VTL templates (legacy) and JS resolvers (modern). I use neither directly — instead, every resolver is a thin "dispatch" that calls a Lambda function. That keeps the business logic in Node/TypeScript with proper unit tests.

The Terraform that creates the API:

```hcl
# vanapalli_finances/terraform_finanaces_vanapalli/modules/appsync/main.tf
resource "aws_appsync_graphql_api" "this" {
  name                = "${var.project}-${var.env}-api"
  authentication_type = "AMAZON_COGNITO_USER_POOLS"

  user_pool_config {
    user_pool_id   = var.user_pool_id
    aws_region     = var.region
    default_action = "ALLOW"
  }

  schema = file("${path.module}/schema.graphql")

  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.logs.arn
    field_log_level          = "ERROR"
  }
}
```

`default_action = "ALLOW"` means the schema-level directive is the gate; without `@aws_cognito_user_pools` a type would be public. I always annotate explicitly so removing a directive can't accidentally expose a query.

## The dispatcher

Every resolver invokes one Lambda. The Lambda routes by GraphQL field name:

```ts
// vanapalli_finances/be_finanaces_vanapalli/src/appsync/handler.ts
import type { AppSyncResolverHandler } from "aws-lambda";
import * as budgets from "./resolvers/budgets.js";
import * as groups from "./resolvers/groups.js";
import * as transactions from "./resolvers/transactions.js";

const resolvers: Record<string, Function> = {
  "Query.budget": budgets.get,
  "Query.budgetsByGroup": budgets.listByGroup,
  "Mutation.createBudget": budgets.create,
  "Mutation.updateBudget": budgets.update,
  "Budget.transactions": transactions.listByBudget,
  // …
};

export const handler: AppSyncResolverHandler<unknown, unknown> = async (event) => {
  const key = `${event.info.parentTypeName}.${event.info.fieldName}`;
  const fn = resolvers[key];
  if (!fn) throw new Error(`No resolver for ${key}`);
  return fn(event);
};
```

That's it. The whole "AppSync ↔ Node" boundary is one switch statement. Every resolver becomes a plain function I can call from a Vitest test.

## Row-level auth inside resolvers

Schema-level Cognito gating answers "is this a real user?" But "is this user allowed to read **budget 123**?" has to happen inside the resolver. Two helpers do the work:

```ts
// vanapalli_finances/be_finanaces_vanapalli/src/appsync/lib/auth.ts
export function callerSub(event: AppSyncEvent): string {
  const sub = event.identity?.sub;
  if (!sub) throw new Error("Unauthenticated");
  return sub;
}

export async function requireGroupMembership(
  groupId: string,
  sub: string,
): Promise<void> {
  const member = await ddb.send(new GetCommand({
    TableName: groupsTable,
    Key: { groupId, memberSub: sub },
  }));
  if (!member.Item) throw new Error("Forbidden");
}
```

Every mutation resolver runs `await requireGroupMembership(input.groupId, callerSub(event))` before it touches the row. Same shape every time — easy to spot if it's missing in code review.

## Subscriptions, briefly

The interesting part of AppSync subscriptions is the filter. The schema declared `onBudgetUpdated(groupId: ID!)` — clients subscribe with a specific `groupId`, and AppSync only pushes events whose payload matches. I never wrote that filter code; the engine does it.

Cost-wise, subscriptions are billed per connection-minute. For a personal app with low concurrency this is rounding-error. For a B2B SaaS you'd want to budget it.

## Where AppSync hurts

Honest list:

- **Local dev is awkward.** There's no good local AppSync emulator. I run resolvers as unit tests and only hit the real endpoint from a deployed environment.
- **VTL/JS resolvers can't share code easily.** That's why I dispatch every field to one Lambda — I'd rather pay a millisecond of overhead than maintain two languages.
- **Schema migrations are append-only-ish.** Removing a field that a deployed client still queries throws an error for that client. You version by adding, deprecating, then removing once you confirm no traffic.

## What I'd change next

- **Split the dispatcher into multiple Lambdas** for the resolvers that fan out heavily (transactions list). Currently every field uses one function — cold starts amortise well but per-field tuning would help.
- **AppSync caching for read-mostly queries** like `Query.budgetsByGroup`. A 30-second TTL would cut DynamoDB reads materially.
- **Switch to JS resolvers** for the trivial pass-throughs (e.g. nested type expansions). The Lambda hop is unnecessary there.

---

**Building something on AppSync and stuck on auth or schema design?** Happy to help — [System Think Van LLC](https://systemthinkvan.com), [bharat@systemthinkvan.com](mailto:bharat@systemthinkvan.com).
