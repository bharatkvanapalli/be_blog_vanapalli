import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/ddb.js";
import { config } from "../lib/config.js";
import type { Post } from "../types/index.js";

// Public like endpoint. No auth — anti-abuse is one-per-browser on the
// client (localStorage) plus the API Gateway throttle. Server stays
// stateless: an atomic ADD on the post row, no per-user record.

export const publicLikesRoutes = new Hono();

// POST /posts/:slug/like — increments likeCount on the post and returns
// the new total. 404 for unknown slugs and for drafts so the existence
// of a draft slug can't be probed via the like endpoint.
publicLikesRoutes.post("/:slug/like", async (c) => {
  const slug = c.req.param("slug");

  const found = await ddb.send(new QueryCommand({
    TableName: config.postsTable,
    IndexName: config.postsSlugIndex,
    KeyConditionExpression: "slug = :s",
    ExpressionAttributeValues: { ":s": slug },
    Limit: 1,
  }));
  const post = (found.Items?.[0] ?? undefined) as Post | undefined;
  if (!post || post.status !== "published") {
    throw new HTTPException(404, { message: "not found" });
  }

  const updated = await ddb.send(new UpdateCommand({
    TableName: config.postsTable,
    Key: { postId: post.postId },
    ConditionExpression: "attribute_exists(postId)",
    UpdateExpression: "ADD likeCount :one",
    ExpressionAttributeValues: { ":one": 1 },
    ReturnValues: "UPDATED_NEW",
  }));

  const likes = Number(
    (updated.Attributes as { likeCount?: number } | undefined)?.likeCount ?? 0,
  );
  return c.json({ likes });
});
