export type { AuthClaims } from "@bharatkvanapalli/auth-server";

export type PostStatus = "draft" | "published";

// One row per post in `vbl-prod-posts`. PK: postId. GSIs: slug-index (slug),
// status-publishedAt-index (status, publishedAt). publishedAt is set when
// status flips to "published" and rewritten on subsequent edits so the
// public list stays stably sorted newest-first.
export interface Post {
  postId: string;
  slug: string;
  title: string;
  content: string;
  excerpt?: string;
  tags?: string[];
  status: PostStatus;
  publishedAt?: string;
  authorSub: string;
  createdAt: string;
  updatedAt?: string;
}
