import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/ddb.js";
import { config } from "../lib/config.js";
import { requireAuth, type AuthVariables } from "@bharatkvanapalli/auth-server";
import { requireAdmin } from "../lib/admin.js";
import { postCreateSchema, postUpdateSchema } from "../lib/validation.js";
import type { Post } from "../types/index.js";

export const adminPostsRoutes = new Hono<{ Variables: AuthVariables }>();
adminPostsRoutes.use("*", requireAuth);
adminPostsRoutes.use("*", requireAdmin);

// GET /admin/posts — list ALL posts (drafts + published). Single-author
// blog with bounded growth, so Scan is fine and avoids a third GSI.
adminPostsRoutes.get("/", async (c) => {
  const out = await ddb.send(new ScanCommand({ TableName: config.postsTable }));
  const items = ((out.Items ?? []) as Post[]).sort((a, b) => {
    const ak = a.publishedAt ?? a.createdAt;
    const bk = b.publishedAt ?? b.createdAt;
    return bk.localeCompare(ak);
  });
  return c.json({ items });
});

// POST /admin/posts — create.
// Slug uniqueness: best-effort pre-check via slug-index. Single-author
// workflow makes a race vanishingly unlikely; upgrade to a sentinel-row
// TransactWriteItems if multi-author writes ever land.
adminPostsRoutes.post("/", async (c) => {
  const claims = c.get("claims");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = postCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.errors[0]?.message ?? "invalid input",
    });
  }

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

  const now = new Date().toISOString();
  const postId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const item: Post = {
    postId,
    slug: parsed.data.slug,
    title: parsed.data.title,
    content: parsed.data.content,
    excerpt: parsed.data.excerpt,
    tags: parsed.data.tags,
    status: parsed.data.status,
    // Only set publishedAt for posts that start published. Drafts stay out
    // of the status-publishedAt-index entirely (GSI sort keys must be
    // present for a row to appear in the index), which is what we want.
    // PUT flips publishedAt to "now" on the draft→published transition.
    ...(parsed.data.status === "published" ? { publishedAt: now } : {}),
    authorSub: claims.sub,
    createdAt: now,
  };
  await ddb.send(new PutCommand({
    TableName: config.postsTable,
    Item: item,
    ConditionExpression: "attribute_not_exists(postId)",
  }));
  return c.json(item, 201);
});

// GET /admin/posts/:id — fetch one (draft or published) for the editor.
adminPostsRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const got = await ddb.send(new GetCommand({
    TableName: config.postsTable,
    Key: { postId: id },
  }));
  const item = got.Item as Post | undefined;
  if (!item) throw new HTTPException(404, { message: "not found" });
  return c.json(item);
});

// PUT /admin/posts/:id — partial update.
// If status flips draft → published, stamp publishedAt to "now" so the row
// jumps to the top of the public list. Slug edits re-check uniqueness.
adminPostsRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = postUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.errors[0]?.message ?? "invalid input",
    });
  }

  const current = await ddb.send(new GetCommand({
    TableName: config.postsTable,
    Key: { postId: id },
  }));
  const existing = current.Item as Post | undefined;
  if (!existing) throw new HTTPException(404, { message: "not found" });

  if (parsed.data.slug && parsed.data.slug !== existing.slug) {
    const collision = await ddb.send(new QueryCommand({
      TableName: config.postsTable,
      IndexName: config.postsSlugIndex,
      KeyConditionExpression: "slug = :s",
      ExpressionAttributeValues: { ":s": parsed.data.slug },
      Limit: 1,
    }));
    if ((collision.Items ?? []).length > 0) {
      throw new HTTPException(409, { message: "slug already in use" });
    }
  }

  const now = new Date().toISOString();
  const willPublish =
    parsed.data.status === "published" && existing.status !== "published";

  const sets: string[] = ["updatedAt = :now"];
  const values: Record<string, unknown> = { ":now": now };
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    values[`:${k}`] = v;
    names[`#${k}`] = k;
  }
  if (willPublish) {
    sets.push("publishedAt = :pub");
    values[":pub"] = now;
  }
  if (sets.length === 1) {
    throw new HTTPException(400, { message: "no fields to update" });
  }

  try {
    const out = await ddb.send(new UpdateCommand({
      TableName: config.postsTable,
      Key: { postId: id },
      ConditionExpression: "attribute_exists(postId)",
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }));
    return c.json(out.Attributes as Post);
  } catch (err: unknown) {
    if ((err as { name?: string } | null)?.name === "ConditionalCheckFailedException") {
      throw new HTTPException(404, { message: "not found" });
    }
    throw err;
  }
});

// DELETE /admin/posts/:id — hard delete.
adminPostsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await ddb.send(new DeleteCommand({
    TableName: config.postsTable,
    Key: { postId: id },
  }));
  return c.body(null, 204);
});
