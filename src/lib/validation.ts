import { z } from "zod";
import { isReservedUsername } from "./reservedUsernames.js";

// ---------- User profile / username (shared identity) ----------
//
// Mirror of the rules used by every sibling vanapalli app — the same row in
// the shared identity table is read/written by finances, blog, and games, so
// these schemas must stay aligned (see be_finanaces_vanapalli/src/lib/
// validation.ts and fe_blog_vanapalli/src/lib/usernameValidation.ts).
export const USERNAME_MIN = 5;
export const USERNAME_MAX = 20;
const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9]|_(?!_))*[a-z0-9]$/;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN, `username must be at least ${USERNAME_MIN} characters`)
  .max(USERNAME_MAX, `username must be at most ${USERNAME_MAX} characters`)
  .regex(
    USERNAME_REGEX,
    "username may only contain a-z, 0-9, and single underscores (not leading/trailing)",
  )
  .refine((v) => !isReservedUsername(v), {
    message: "that username is reserved",
  });

export const profileNameSchema = z
  .string()
  .trim()
  .min(1, "profileName is required")
  .max(64, "profileName must be at most 64 characters");

function nullishOpt<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((v) => v ?? undefined);
}

export const updateMeSchema = z.object({
  profileName: nullishOpt(profileNameSchema),
  username: nullishOpt(usernameSchema),
}).refine(
  (v) => v.profileName !== undefined || v.username !== undefined,
  { message: "at least one of profileName or username is required" },
);

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

// ---------- Posts ----------

// Slugs are URL path segments — kebab-case lowercase, no slashes or spaces.
// Length cap mirrors typical CMS limits and keeps GSI partitions small.
const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case");

export const postCreateSchema = z.object({
  title: z.string().min(1).max(200),
  slug: slugSchema,
  content: z.string().min(1),
  excerpt: z.string().max(500).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  status: z.enum(["draft", "published"]).default("draft"),
});

export const postUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: slugSchema.optional(),
  content: z.string().min(1).optional(),
  excerpt: z.string().max(500).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  status: z.enum(["draft", "published"]).optional(),
});

export type PostCreateInput = z.infer<typeof postCreateSchema>;
export type PostUpdateInput = z.infer<typeof postUpdateSchema>;

// Contact message from the public /contact form. `website` is a honeypot —
// real submitters never see the field, bots fill every input. Any non-
// empty value short-circuits the write but the handler still returns a
// success response so the bot can't probe for the trap.
export const messageCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  subject: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(5000),
  website: z.string().optional(),
});

export const messageUpdateSchema = z.object({
  read: z.boolean(),
});

export type MessageCreateInput = z.infer<typeof messageCreateSchema>;
export type MessageUpdateInput = z.infer<typeof messageUpdateSchema>;
