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
  likeCount?: number;
}

// One row per inbound contact submission in `vbl-${env}-messages`.
// PK: messageId. GSI: createdAt-index (pk="m", createdAt) — constant hash
// keeps every row in one partition so the admin inbox is a Query, not a
// Scan. Fine while volume is tens-per-day; revisit if it ever spikes.
export interface Message {
  messageId: string;
  pk: "m";
  name: string;
  email: string;
  subject: string;
  body: string;
  createdAt: string;
  read: boolean;
  ipHash?: string;
}
