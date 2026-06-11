import { z } from "zod";

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
