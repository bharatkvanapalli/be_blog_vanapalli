// Upserts every markdown file under content/architecture/ into the posts
// table. Idempotent: if a row with the file's slug already exists, the
// content/title/excerpt/tags/status are updated and updatedAt bumped; if
// not, a new row is inserted using the same logic as POST /admin/posts.
//
// Run locally:
//   AWS_PROFILE=… \
//   POSTS_TABLE_NAME=vbl-prod-posts \
//   SEED_AUTHOR_SUB=<your-cognito-sub> \
//   npm run seed:content
//
// Add --dry-run to print intended writes without touching DynamoDB.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Post, PostStatus } from "../src/types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = join(__dirname, "..", "content", "architecture");

const region = process.env.AWS_REGION ?? "us-east-1";
const table = required("POSTS_TABLE_NAME");
const slugIndex = process.env.POSTS_SLUG_INDEX ?? "slug-index";
const authorSub = required("SEED_AUTHOR_SUB");
const dryRun = process.argv.includes("--dry-run");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

interface Frontmatter {
  slug: string;
  title: string;
  excerpt?: string;
  tags?: string[];
  status?: PostStatus;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function loadPosts(): Array<{ file: string; fm: Frontmatter; content: string }> {
  const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md")).sort();
  return files.map((file) => {
    const raw = readFileSync(join(CONTENT_DIR, file), "utf8");
    const parsed = matter(raw);
    const fm = parsed.data as Frontmatter;
    if (!fm.slug || !fm.title) {
      throw new Error(`${file}: missing slug or title in frontmatter`);
    }
    return { file, fm, content: parsed.content.trim() };
  });
}

async function findExistingPostId(slug: string): Promise<string | null> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: table,
      IndexName: slugIndex,
      KeyConditionExpression: "slug = :s",
      ExpressionAttributeValues: { ":s": slug },
      Limit: 1,
    }),
  );
  const item = (out.Items ?? [])[0] as Post | undefined;
  return item?.postId ?? null;
}

async function upsert(
  fm: Frontmatter,
  content: string,
): Promise<"created" | "updated"> {
  const status: PostStatus = fm.status ?? "published";
  const now = new Date().toISOString();
  const existingId = await findExistingPostId(fm.slug);

  if (existingId) {
    if (dryRun) {
      console.log(`  [dry-run] would UPDATE ${existingId}`);
      return "updated";
    }
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { postId: existingId },
        UpdateExpression:
          "SET title = :t, content = :c, excerpt = :e, tags = :g, #s = :st, updatedAt = :u",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":t": fm.title,
          ":c": content,
          ":e": fm.excerpt ?? null,
          ":g": fm.tags ?? [],
          ":st": status,
          ":u": now,
        },
      }),
    );
    return "updated";
  }

  const postId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const item: Post = {
    postId,
    slug: fm.slug,
    title: fm.title,
    content,
    excerpt: fm.excerpt,
    tags: fm.tags,
    status,
    ...(status === "published" ? { publishedAt: now } : {}),
    authorSub,
    createdAt: now,
  };
  if (dryRun) {
    console.log(`  [dry-run] would CREATE ${postId}`);
    return "created";
  }
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: item,
      ConditionExpression: "attribute_not_exists(postId)",
    }),
  );
  return "created";
}

async function main() {
  const posts = loadPosts();
  console.log(
    `Seeding ${posts.length} post(s) from ${CONTENT_DIR}${dryRun ? " (dry-run)" : ""}`,
  );
  for (const p of posts) {
    process.stdout.write(`- ${p.fm.slug} … `);
    const result = await upsert(p.fm, p.content);
    console.log(result);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
