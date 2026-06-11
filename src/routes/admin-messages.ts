import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/ddb.js";
import { config } from "../lib/config.js";
import { requireAuth, type AuthVariables } from "@bharatkvanapalli/auth-server";
import { requireAdmin } from "../lib/admin.js";
import { messageUpdateSchema } from "../lib/validation.js";
import type { Message } from "../types/index.js";

export const adminMessagesRoutes = new Hono<{ Variables: AuthVariables }>();
adminMessagesRoutes.use("*", requireAuth);
adminMessagesRoutes.use("*", requireAdmin);

// GET /admin/messages?limit=&nextToken=
// Newest-first via createdAt-index. Constant hash key "m" keeps every row
// in one partition — fine for a personal-blog inbox; revisit at scale.
adminMessagesRoutes.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 100);
  const nextToken = c.req.query("nextToken");

  const out = await ddb.send(new QueryCommand({
    TableName: config.messagesTable,
    IndexName: config.messagesCreatedIndex,
    KeyConditionExpression: "pk = :p",
    ExpressionAttributeValues: { ":p": "m" },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: nextToken
      ? (JSON.parse(Buffer.from(nextToken, "base64").toString("utf8")) as Record<string, unknown>)
      : undefined,
  }));

  const next = out.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64")
    : null;
  return c.json({ items: (out.Items ?? []) as Message[], nextToken: next });
});

// GET /admin/messages/:id — fetch full body for the detail view.
adminMessagesRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const got = await ddb.send(new GetCommand({
    TableName: config.messagesTable,
    Key: { messageId: id },
  }));
  const item = got.Item as Message | undefined;
  if (!item) throw new HTTPException(404, { message: "not found" });
  return c.json(item);
});

// PATCH /admin/messages/:id — toggle read flag.
adminMessagesRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = messageUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.errors[0]?.message ?? "invalid input",
    });
  }

  try {
    const out = await ddb.send(new UpdateCommand({
      TableName: config.messagesTable,
      Key: { messageId: id },
      ConditionExpression: "attribute_exists(messageId)",
      UpdateExpression: "SET #r = :r",
      ExpressionAttributeNames: { "#r": "read" },
      ExpressionAttributeValues: { ":r": parsed.data.read },
      ReturnValues: "ALL_NEW",
    }));
    return c.json(out.Attributes as Message);
  } catch (err: unknown) {
    if ((err as { name?: string } | null)?.name === "ConditionalCheckFailedException") {
      throw new HTTPException(404, { message: "not found" });
    }
    throw err;
  }
});

// DELETE /admin/messages/:id — hard delete.
adminMessagesRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await ddb.send(new DeleteCommand({
    TableName: config.messagesTable,
    Key: { messageId: id },
  }));
  return c.body(null, 204);
});
