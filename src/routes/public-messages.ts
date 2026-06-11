import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { ddb } from "../lib/ddb.js";
import { config } from "../lib/config.js";
import { messageCreateSchema } from "../lib/validation.js";
import type { Message } from "../types/index.js";

// Public contact form sink. No auth. Spam defense is layered:
//   - Honeypot field `website`: bots fill every input; humans never see it.
//     Trapped submissions return 201 so the bot can't probe the trap.
//   - API Gateway throttle handles burst/volume.
// Real abuse-mitigation (Turnstile etc.) is deferred until something shows up.

export const publicMessagesRoutes = new Hono();

function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

// POST /messages — accept a contact submission.
publicMessagesRoutes.post("/", async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = messageCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.errors[0]?.message ?? "invalid input",
    });
  }

  // Honeypot trip — silently swallow. Same 201 as a real submission so a
  // bot probing for the trap learns nothing.
  if (parsed.data.website && parsed.data.website.length > 0) {
    return c.json({ ok: true }, 201);
  }

  const xff = c.req.header("x-forwarded-for");
  const ip = xff ? xff.split(",")[0]?.trim() : undefined;

  const now = new Date().toISOString();
  const messageId = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const item: Message = {
    messageId,
    pk: "m",
    name: parsed.data.name,
    email: parsed.data.email,
    subject: parsed.data.subject,
    body: parsed.data.body,
    createdAt: now,
    read: false,
    ipHash: hashIp(ip),
  };
  await ddb.send(new PutCommand({
    TableName: config.messagesTable,
    Item: item,
    ConditionExpression: "attribute_not_exists(messageId)",
  }));
  return c.json({ ok: true }, 201);
});
