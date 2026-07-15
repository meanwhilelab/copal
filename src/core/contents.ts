import type { Db } from "../db/client.js";
import { contents } from "../db/schema.js";
import { recordEvent } from "./audit.js";
import type { AuthedClient } from "./auth.js";
import { enqueueEmbed, enqueueJob } from "./jobs.js";

export async function saveContent(
  db: Db,
  client: AuthedClient,
  input: {
    workspaceId: string;
    title: string;
    sourceType: string; // link | pdf | email | note
    sourceUrl?: string;
    body?: string;
    language?: string;
  },
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(contents)
      .values({ ...input, createdByClientId: client.id })
      .returning();
    await enqueueJob(tx as unknown as Db, "content_catalogue", row!.id);
    await enqueueEmbed(tx as unknown as Db, "content", row!.id); // initial embed from body; re-embedded after catalogue
    await recordEvent(tx as unknown as Db, client, {
      action: "create",
      entityType: "content",
      entityId: row!.id,
      detail: { title: row!.title, sourceType: row!.sourceType, workspaceId: input.workspaceId },
    });
    return row!;
  });
}
