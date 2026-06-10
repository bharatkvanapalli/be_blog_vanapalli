// Lazy env access — values are read on first use, not at module load. Lets
// handlers that only need a subset of env vars skip provisioning the rest.
function lazy<T>(load: () => T): { readonly value: T } {
  let cached: { v: T } | null = null;
  return {
    get value() {
      if (!cached) cached = { v: load() };
      return cached.v;
    },
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const _region = process.env.AWS_REGION ?? "us-east-1";
const _env = lazy(() => required("APP_ENV"));
const _postsTable = lazy(() => required("POSTS_TABLE_NAME"));
const _userPoolId = lazy(() => required("USER_POOL_ID"));
const _adminEmails = lazy<ReadonlySet<string>>(() => {
  const raw = process.env["ADMIN_EMAILS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
});

export const config = {
  region: _region,
  get env() { return _env.value; },
  get postsTable() { return _postsTable.value; },
  get userPoolId() { return _userPoolId.value; },
  get adminEmails() { return _adminEmails.value; },
  // GSI names — kept here so route code doesn't hard-code magic strings.
  // Mirror of `modules/dynamodb/main.tf`.
  postsSlugIndex: process.env["POSTS_SLUG_INDEX"] ?? "slug-index",
  postsStatusPublishedIndex: process.env["POSTS_STATUS_PUBLISHED_INDEX"] ?? "status-publishedAt-index",
};

export type AppConfig = typeof config;
