import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, type AuthVariables } from "@bharatkvanapalli/auth-server";
import {
  getOrCreateUserBySub,
  isUsernameAvailable,
  updateMe,
} from "../services/users.js";
import { updateMeSchema, usernameSchema } from "../lib/validation.js";

// Shared-identity routes — all reads/writes hit the same DynamoDB row a
// user has on every sibling vanapalli app (finances, games). The default
// auth-web profile loader (`GET <apiBaseUrl>/me`) targets this router.
export const meRoutes = new Hono<{ Variables: AuthVariables }>();
meRoutes.use("*", requireAuth);

// GET /me — return (and lazy-create) the caller's profile row.
meRoutes.get("/", async (c) => {
  const { sub, email } = c.get("claims");
  const profile = await getOrCreateUserBySub(sub, email);
  return c.json(profile);
});

// PUT /me — set profileName and/or claim a username. Username is
// write-once; renames are rejected. Returns the updated row.
meRoutes.put("/", async (c) => {
  const { sub, email } = c.get("claims");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = updateMeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.errors[0]?.message ?? "invalid input",
    });
  }
  try {
    const updated = await updateMe({
      sub,
      email,
      profileName: parsed.data.profileName,
      username: parsed.data.username,
    });
    return c.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "update failed";
    if (/taken|already|cannot be changed/i.test(msg)) {
      throw new HTTPException(409, { message: msg });
    }
    throw err;
  }
});

// GET /me/username-available?candidate=foo — live check for the
// profile-edit form. 400 if the candidate fails shape validation so the
// FE can mirror server-side validation messages without a guess.
meRoutes.get("/username-available", async (c) => {
  const candidate = c.req.query("candidate") ?? "";
  const parsed = usernameSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.errors[0]?.message ?? "invalid candidate",
    });
  }
  const available = await isUsernameAvailable(parsed.data);
  return c.json({ available });
});
