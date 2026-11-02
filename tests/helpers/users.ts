import type { Kysely } from "kysely";
import { createUser } from "../../src/server/auth/service";
import type { DB } from "../../src/server/db/schema";
import type { Actor } from "../../src/server/command/runner";

export const TEST_PASSWORD = "correct-horse-battery-staple";

let counter = 0;

export async function makeUser(
  db: Kysely<DB>,
  roles: string[],
  prefix = "user",
): Promise<{ userId: string; username: string; actor: Actor }> {
  counter++;
  const username = `${prefix}${counter}.${Date.now().toString(36)}`.toLowerCase();
  const { userId } = await createUser(
    db,
    { kind: "system", name: "test" },
    {
      username,
      displayName: `Test ${prefix} ${counter}`,
      password: TEST_PASSWORD,
      roles,
    },
  );
  return { userId, username, actor: { kind: "user", userId } };
}
