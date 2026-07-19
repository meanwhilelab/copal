import "dotenv/config";
import { DEFAULT_LANE_SET, DEFAULT_STATUS_SET } from "../core/boards.js";
import { db, pool } from "./client.js";
import { boards, items, workspaces } from "./schema.js";

// Minimal, generic first-run seed so a fresh install has something to open: one
// "personal" workspace + one example board with the default status set. Idempotent
// — safe to re-run; it never touches data you've already created.
//
// This is only an example. Make Copal yours by creating your own workspaces and
// boards (via the console, the REST API, or an MCP client) — see SETUP.md. You do
// not have to keep, or re-run, this seed.

const [inserted] = await db
  .insert(workspaces)
  .values({ slug: "personal", name: "Personal" })
  .onConflictDoNothing()
  .returning();
const personal =
  inserted ?? (await db.query.workspaces.findFirst({ where: (t, { eq }) => eq(t.slug, "personal") }));
if (!personal) throw new Error("could not create or find the 'personal' workspace");

const existing = await db.query.boards.findFirst({
  where: (t, { eq }) => eq(t.name, "Getting started"),
});

if (existing) {
  console.log("seed already present — nothing to do");
} else {
  const [board] = await db
    .insert(boards)
    .values({
      workspaceId: personal.id,
      name: "Getting started",
      statusSet: DEFAULT_STATUS_SET,
      laneSet: DEFAULT_LANE_SET,
    })
    .returning();
  if (!board) throw new Error("board insert failed");

  const firstStatus = DEFAULT_STATUS_SET.find((s) => !s.terminal)?.key ?? DEFAULT_STATUS_SET[0]!.key;
  await db.insert(items).values([
    { boardId: board.id, name: "Drag me to another column to change my status", status: firstStatus, priority: "media" },
    { boardId: board.id, name: "Click any cell to edit — priority, due date, progress, a link, or a description", status: firstStatus, priority: "bassa" },
  ]);
  console.log("seeded: 'personal' workspace + 'Getting started' board (2 example items)");
}

await pool.end();
