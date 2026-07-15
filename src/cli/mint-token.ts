import "dotenv/config";
import { db, pool } from "../db/client.js";
import { apiClients } from "../db/schema.js";
import { generateToken, hashToken } from "../core/auth.js";

// Usage: npm run mint-token -- <name> [scopes,comma,separated]
const name = process.argv[2];
const scopes = (process.argv[3] ?? "read,write").split(",").map((s) => s.trim());
if (!name) {
  console.error("usage: npm run mint-token -- <client-name> [scopes]");
  process.exit(1);
}

const token = generateToken();
await db.insert(apiClients).values({ name, tokenHash: hashToken(token), scopes });
console.log(`client:  ${name}`);
console.log(`scopes:  ${scopes.join(",")}`);
console.log(`token:   ${token}`);
console.log("Store it now — only the hash is kept.");
await pool.end();
