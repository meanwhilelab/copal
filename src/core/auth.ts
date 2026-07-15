import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apiClients } from "../db/schema.js";

export type AuthedClient = {
  id: string;
  name: string;
  scopes: string[];
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): string {
  return `cop_${randomBytes(32).toString("base64url")}`;
}

/** Resolve a bearer/path token to an active client, or null. */
export async function authenticate(db: Db, token: string | undefined): Promise<AuthedClient | null> {
  if (!token || token.length < 8) return null;
  const row = await db.query.apiClients.findFirst({
    where: and(eq(apiClients.tokenHash, hashToken(token)), isNull(apiClients.revokedAt)),
  });
  if (!row) return null;
  // fire-and-forget freshness marker; never blocks the request
  void db
    .update(apiClients)
    .set({ lastSeenAt: new Date() })
    .where(eq(apiClients.id, row.id))
    .catch(() => {});
  return { id: row.id, name: row.name, scopes: row.scopes };
}

export function hasScope(client: AuthedClient, scope: "read" | "write" | "admin"): boolean {
  return client.scopes.includes(scope) || client.scopes.includes("admin");
}
