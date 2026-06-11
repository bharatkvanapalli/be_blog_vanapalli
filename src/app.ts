import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { publicPostsRoutes } from "./routes/public-posts.js";
import { publicLikesRoutes } from "./routes/public-likes.js";
import { publicMessagesRoutes } from "./routes/public-messages.js";
import { meRoutes } from "./routes/me.js";
import { adminPostsRoutes } from "./routes/admin-posts.js";
import { adminMessagesRoutes } from "./routes/admin-messages.js";
import { logger } from "./lib/logger.js";

export const app = new Hono();

app.use("*", honoLogger((msg) => logger.info(msg)));

app.get("/health", (c) => c.json({ ok: true }));

// Order matters for clarity — public routes first, admin behind /admin.
// Likes mount on /posts alongside the reader endpoints; Hono composes both
// routers on the same prefix without collision.
app.route("/posts", publicPostsRoutes);
app.route("/posts", publicLikesRoutes);
app.route("/messages", publicMessagesRoutes);
app.route("/me", meRoutes);
app.route("/admin/posts", adminPostsRoutes);
app.route("/admin/messages", adminMessagesRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  logger.error("Unhandled error", { err: err instanceof Error ? err.message : String(err) });
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
