// Linear issue enrichment (optional, LINEAR_API_KEY-gated). An issue a board
// item tracks is fetched with its sub-issue tree and rendered to the text stored
// on the issue's `content` row (see core/linear-issues.ts), which the item_context
// compile then reads like any other linked material. Everything here degrades
// silently — a bad URL or any fetch failure must never break a compile, only
// leave the last good snapshot in place.

const LINEAR_ISSUE_PATH_RE = /^\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/.*)?$/;

/** Split a Linear issue URL into its org slug and issue identifier, tolerating a
 *  missing slug, trailing slashes and query strings. Null for anything else. */
function splitLinearIssueUrl(url: string): { org: string; identifier: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.toLowerCase() !== "linear.app") return null;
  const m = parsed.pathname.match(LINEAR_ISSUE_PATH_RE);
  return m ? { org: m[1]!, identifier: m[2]! } : null;
}

/** Extract the issue identifier (e.g. "NAT-2061") from a Linear issue URL.
 *  Returns null for anything that isn't a linear.app issue URL. */
export function parseLinearIssueUrl(url: string): string | null {
  return splitLinearIssueUrl(url)?.identifier ?? null;
}

/** The stable, slug-free form of a Linear issue URL — the identity of a tracked
 *  issue's content row. The org slug is preserved: the same identifier in two
 *  Linear orgs is two different issues. */
export function canonicalLinearUrl(url: string): string | null {
  const parts = splitLinearIssueUrl(url);
  return parts ? `https://linear.app/${parts.org}/issue/${parts.identifier}` : null;
}

export type LinearIssueNode = {
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  updatedAt: string;
  children: LinearIssueNode[];
};

const ISSUE_FIELDS = "identifier title description updatedAt state { name }";
const CHILDREN_PER_LEVEL = 25;
const MAX_DEPTH = 3;

// Children are nested statically in the document, so the whole tree costs one
// round trip instead of one per node.
const nest = (depth: number): string =>
  depth === 0
    ? ISSUE_FIELDS
    : `${ISSUE_FIELDS} children(first: ${CHILDREN_PER_LEVEL}) { nodes { ${nest(depth - 1)} } }`;
const ISSUE_QUERY = `query($id: String!) { issue(id: $id) { ${nest(MAX_DEPTH)} } }`;

type GqlIssueNode = {
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { name: string } | null;
  children?: { nodes?: GqlIssueNode[] } | null;
};

type GraphQlIssueResponse = { data?: { issue?: GqlIssueNode | null }; errors?: unknown[] };

const toNode = (n: GqlIssueNode): LinearIssueNode => ({
  identifier: n.identifier,
  title: n.title,
  description: n.description ?? null,
  state: n.state?.name ?? "unknown",
  updatedAt: n.updatedAt,
  children: (n.children?.nodes ?? []).map(toNode),
});

/** Fetch a Linear issue and its sub-issue tree (3 levels) by identifier — or by
 *  UUID, which Linear's `issue(id:)` resolves too. Never throws: returns null on
 *  a non-200, GraphQL errors, a missing issue, bad JSON or a timeout (5s).
 *  `fetchImpl` is injectable for tests. */
export async function fetchLinearIssueTree(
  identifier: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearIssueNode | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        // Linear personal API keys go bare — no "Bearer" prefix.
        Authorization: apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: ISSUE_QUERY, variables: { id: identifier } }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as GraphQlIssueResponse;
    if (json.errors && json.errors.length > 0) return null;
    const issue = json.data?.issue;
    return issue ? toNode(issue) : null;
  } catch {
    return null; // network error, abort/timeout, bad JSON, ...
  } finally {
    clearTimeout(timeout);
  }
}

// Descriptions get shorter the deeper they sit, so a large epic can't crowd out
// the item's own declared material. Index = depth (0 = the root).
const DESC_CAPS = [2000, 800, 400, 200];
export const LINEAR_MAX_NODES = 50;
export const LINEAR_BODY_CAP = 12_000;

function flatten(node: LinearIssueNode, depth: number, acc: { node: LinearIssueNode; depth: number }[]) {
  for (const c of node.children) {
    acc.push({ node: c, depth });
    flatten(c, depth + 1, acc);
  }
}

/** Render an issue tree to the text stored in contents.body — the root's
 *  description followed by a depth-first, indented sub-issue outline. Both caps
 *  announce themselves when they bite: a silent truncation would tell the model
 *  the tree is complete when it isn't. */
export function renderLinearIssueTree(root: LinearIssueNode): string {
  const head = root.description?.trim() ? root.description.slice(0, DESC_CAPS[0]!) : "(no description)";
  const all: { node: LinearIssueNode; depth: number }[] = [];
  flatten(root, 1, all);
  const shown = all.slice(0, LINEAR_MAX_NODES - 1); // the root itself is a node
  const lines = shown.map(({ node, depth }) => {
    const indent = "   ".repeat(depth - 1);
    const cap = DESC_CAPS[Math.min(depth, DESC_CAPS.length - 1)]!;
    const desc = node.description?.trim() ? node.description.slice(0, cap) : "(no description)";
    return (
      `${indent}└─ ${node.identifier} — ${node.title} [${node.state}] · updated ${node.updatedAt.slice(0, 10)}\n` +
      `${indent}   ${desc}`
    );
  });
  const omitted = all.length - shown.length;
  if (omitted > 0) lines.push(`… ${omitted} further sub-issues not shown`);
  const body = [head, ...lines].join("\n");
  return body.length > LINEAR_BODY_CAP ? `${body.slice(0, LINEAR_BODY_CAP)}\n… truncated` : body;
}
