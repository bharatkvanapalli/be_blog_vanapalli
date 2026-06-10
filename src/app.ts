import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { publicPostsRoutes } from "./routes/public-posts.js";
import { adminPostsRoutes } from "./routes/admin-posts.js";
import { logger } from "./lib/logger.js";

export const app = new Hono();

app.use("*", honoLogger((msg) => logger.info(msg)));

app.get("/health", (c) => c.json({ ok: true }));

// Order matters for clarity — public routes first, admin behind /admin.
app.route("/posts", publicPostsRoutes);
app.route("/admin/posts", adminPostsRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  logger.error("Unhandled error", { err: err instanceof Error ? err.message : String(err) });
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
