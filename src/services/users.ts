// Users service — wraps the shared identity DynamoDB table owned by
// terraform_vanapalli_landing. Every sibling vanapalli app reads/writes
// the same row (keyed by Cognito sub), so a user's @username and display
// name stay consistent across finances, blog, games, etc.
//
// Slim port of be_finanaces_vanapalli/src/services/users.ts — blog only
// needs read-and-update-self, not the BatchGet / username-prefix search
// pieces finances uses for group membership UX.
//
// All public functions are idempotent / safe to retry. Username writes
// are conditional (write-once) at the DDB layer — racing tabs surface as
// a ConditionalCheckFailedException, which we translate to a friendly
// "username is taken" / "username already set" message.

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/ddb.js";
import { config } from "../lib/config.js";
import type { UserProfile } from "../types/index.js";

const USER_SCOPE = "USER" as const;

// Lazy-create a stub row if the PostConfirmation Lambda hasn't fired yet
// (federated sign-in race, trigger lag, legacy users). The conditional
// Put means concurrent first-reads from two tabs converge on one row.
export async function getOrCreateUserBySub(
  sub: string,
  email: string,
): Promise<UserProfile> {
  const got = await ddb.send(
    new GetCommand({ TableName: config.sharedUsersTable, Key: { userId: sub } }),
  );
  if (got.Item) return got.Item as UserProfile;

  const now = new Date().toISOString();
  const stub: UserProfile = {
    userId: sub,
    email,
    profileCompleted: false,
    createdAt: now,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: config.sharedUsersTable,
        Item: stub,
        ConditionExpression: "attribute_not_exists(userId)",
      }),
    );
    return stub;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      const reread = await ddb.send(
        new GetCommand({
          TableName: config.sharedUsersTable,
          Key: { userId: sub },
        }),
      );
      if (reread.Item) return reread.Item as UserProfile;
    }
    throw err;
  }
}

interface UpdateMeArgs {
  sub: string;
  email: string;
  profileName?: string;
  username?: string;
}

// Set profileName and/or claim a username. Username is write-once:
//   * If the current row has no username and the call sets one, we run a
//     uniqueness check on the GSI then an UpdateItem with
//     `attribute_not_exists(username)` to guard against racing tabs.
//   * If the row already has a username, a second call with a DIFFERENT
//     username is rejected.
//   * Passing the same username as before is a no-op (idempotent).
//
// Flips `profileCompleted` to true once both fields are set at least once.
export async function updateMe(args: UpdateMeArgs): Promise<UserProfile> {
  const { sub, email, profileName, username } = args;

  const existing = await ddb.send(
    new GetCommand({ TableName: config.sharedUsersTable, Key: { userId: sub } }),
  );
  const current = existing.Item as UserProfile | undefined;

  if (username && current?.username && current.username !== username) {
    throw new Error("username cannot be changed");
  }

  if (username && !current?.username) {
    const taken = await ddb.send(
      new QueryCommand({
        TableName: config.sharedUsersTable,
        IndexName: config.usersUsernameIndex,
        KeyConditionExpression: "userScopeKey = :scope AND usernameLower = :u",
        ExpressionAttributeValues: { ":scope": USER_SCOPE, ":u": username },
        Limit: 1,
      }),
    );
    const owner = taken.Items?.[0]?.["userId"];
    if (owner && owner !== sub) {
      throw new Error("username is taken");
    }
  }

  const now = new Date().toISOString();
  const setExprs: string[] = [
    "updatedAt = :now",
    "email = if_not_exists(email, :e)",
    "createdAt = if_not_exists(createdAt, :now)",
  ];
  const exprValues: Record<string, unknown> = {
    ":now": now,
    ":e": email,
  };

  if (profileName !== undefined) {
    setExprs.push("profileName = :n");
    exprValues[":n"] = profileName;
  }

  const claimingUsername = Boolean(username && !current?.username);
  if (claimingUsername) {
    setExprs.push(
      "username = :user",
      "usernameLower = :userLower",
      "userScopeKey = :scope",
    );
    exprValues[":user"] = username;
    exprValues[":userLower"] = username;
    exprValues[":scope"] = USER_SCOPE;
  }

  const willHaveProfileName =
    profileName !== undefined ? Boolean(profileName) : Boolean(current?.profileName);
  const willHaveUsername = claimingUsername || Boolean(current?.username);
  if (willHaveProfileName && willHaveUsername) {
    setExprs.push("profileCompleted = :true");
    exprValues[":true"] = true;
  }

  try {
    const out = await ddb.send(
      new UpdateCommand({
        TableName: config.sharedUsersTable,
        Key: { userId: sub },
        UpdateExpression: `SET ${setExprs.join(", ")}`,
        ConditionExpression: claimingUsername
          ? "attribute_not_exists(username)"
          : undefined,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }),
    );
    return out.Attributes as UserProfile;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new Error("username already set on this account");
    }
    throw err;
  }
}

// Equality lookup on the username GSI. Returns true if no row exists for
// the lowercased candidate. Caller is expected to have validated the
// candidate first.
export async function isUsernameAvailable(candidate: string): Promise<boolean> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: config.sharedUsersTable,
      IndexName: config.usersUsernameIndex,
      KeyConditionExpression: "userScopeKey = :scope AND usernameLower = :u",
      ExpressionAttributeValues: { ":scope": USER_SCOPE, ":u": candidate },
      Limit: 1,
    }),
  );
  return !(out.Items && out.Items.length > 0);
}
