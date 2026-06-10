import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthVariables } from "@bharatkvanapalli/auth-server";
import { config } from "./config.js";

// Admin gate for /admin/posts/*. Runs AFTER requireAuth, so `claims.email`
// is guaranteed to be set. Compares case-insensitively against the SSM-
// published ADMIN_EMAILS allowlist. A growth path to a per-user flag in
// the shared users table is just swapping this body — the middleware
// signature stays identical.
export const requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const claims = c.get("claims");
  const email = claims.email?.toLowerCase();
  if (!email || !config.adminEmails.has(email)) {
    throw new HTTPException(403, { message: "admin only" });
  }
  await next();
};
