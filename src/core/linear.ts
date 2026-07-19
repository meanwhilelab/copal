// Linear issue enrichment (optional, LINEAR_API_KEY-gated): when a board item's
// `link` points at a Linear issue, the item_context compile fetches the live
// issue and folds title/description/state into the material the Librarian
// synthesizes. Both functions degrade silently — a bad/missing URL or any
// fetch failure must never break the compile, only skip the enrichment.

const LINEAR_ISSUE_PATH_RE = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/.*)?$/;

/** Extract the issue identifier (e.g. "NAT-2061") from a Linear issue URL,
 *  tolerating a missing slug and trailing slashes/query strings. Returns null
 *  for anything that isn't a linear.app issue URL. */
export function parseLinearIssueUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.toLowerCase() !== "linear.app") return null;
  const m = parsed.pathname.match(LINEAR_ISSUE_PATH_RE);
  return m ? m[1]! : null;
}

export type LinearIssue = {
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  updatedAt: string;
};

const ISSUE_QUERY =
  "query($id: String!) { issue(id: $id) { identifier title description updatedAt state { name } } }";

type GraphQlIssueResponse = {
  data?: {
    issue?: {
      identifier: string;
      title: string;
      description: string | null;
      updatedAt: string;
      state: { name: string } | null;
    } | null;
  };
  errors?: unknown[];
};

/** Fetch a Linear issue by identifier (or UUID — Linear's `issue(id:)` resolves
 *  both). Never throws: returns null on a non-200, GraphQL errors, a missing
 *  issue, or a timeout (5s). `fetchImpl` is injectable for tests. */
export async function fetchLinearIssue(
  identifier: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearIssue | null> {
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
    if (!issue) return null;
    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      state: issue.state?.name ?? "unknown",
      updatedAt: issue.updatedAt,
    };
  } catch {
    return null; // network error, abort/timeout, bad JSON, ...
  } finally {
    clearTimeout(timeout);
  }
}
