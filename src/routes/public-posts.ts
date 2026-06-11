import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/ddb.js";
import { config } from "../lib/config.js";
import type { Post } from "../types/index.js";

// Public reader endpoints. NO requireAuth — these are also wired in the
// terraform env layer as explicit `authorization_type = "NONE"` routes so
// API Gateway lets them through without a JWT.

export const publicPostsRoutes = new Hono();

// GET /posts?limit=&nextToken=
// Lists published posts newest-first via the status-publishedAt-index GSI.
publicPostsRoutes.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "20") || 20, 50);
  const nextToken = c.req.query("nextToken");

  const out = await ddb.send(new QueryCommand({
    TableName: config.postsTable,
    IndexName: config.postsStatusPublishedIndex,
    KeyConditionExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "published" },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: nextToken
      ? (JSON.parse(Buffer.from(nextToken, "base64").toString("utf8")) as Record<string, unknown>)
      : undefined,
  }));

  const next = out.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64")
    : null;
  const items = ((out.Items ?? []) as Post[]).map((p) => ({
    ...p,
    likeCount: p.likeCount ?? 0,
  }));
  return c.json({ items, nextToken: next });
});

// GET /posts/:slug — single published post by slug. Drafts 404 here even
// if a slug match exists, so a draft slug can't leak via URL guessing.
publicPostsRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const out = await ddb.send(new QueryCommand({
    TableName: config.postsTable,
    IndexName: config.postsSlugIndex,
    KeyConditionExpression: "slug = :s",
    ExpressionAttributeValues: { ":s": slug },
    Limit: 1,
  }));
  const item = (out.Items?.[0] ?? undefined) as Post | undefined;
  if (!item || item.status !== "published") {
    throw new HTTPException(404, { message: "not found" });
  }
  return c.json({ ...item, likeCount: item.likeCount ?? 0 });
});
