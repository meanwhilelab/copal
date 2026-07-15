import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import { NotFoundError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a workspace by its slug or uuid. */
export async function resolveWorkspace(db: Db, slugOrId: string) {
  const row = await db.query.workspaces.findFirst({
    where: UUID_RE.test(slugOrId) ? eq(workspaces.id, slugOrId) : eq(workspaces.slug, slugOrId),
  });
  if (!row) throw new NotFoundError(`unknown workspace "${slugOrId}" — pass an existing workspace slug or uuid`);
  return row;
}
