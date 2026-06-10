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
