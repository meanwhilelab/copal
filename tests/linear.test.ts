import { describe, expect, it } from "vitest";
import {
  canonicalLinearUrl,
  fetchLinearIssueTree,
  renderLinearIssueTree,
  LINEAR_MAX_NODES,
  parseLinearIssueUrl,
} from "../src/core/linear.js";

describe("parseLinearIssueUrl", () => {
  it("extracts the identifier from a URL with a slug", () => {
    expect(parseLinearIssueUrl("https://linear.app/meanwhile/issue/NAT-2061/ship-the-thing")).toBe("NAT-2061");
  });

  it("extracts the identifier from a URL without a slug", () => {
    expect(parseLinearIssueUrl("https://linear.app/meanwhile/issue/NAT-2061")).toBe("NAT-2061");
  });

  it("tolerates a trailing slash", () => {
    expect(parseLinearIssueUrl("https://linear.app/meanwhile/issue/NAT-2061/")).toBe("NAT-2061");
  });

  it("tolerates a query string", () => {
    expect(parseLinearIssueUrl("https://linear.app/meanwhile/issue/NAT-2061/slug?foo=bar")).toBe("NAT-2061");
  });

  it("is case-insensitive on the host", () => {
    expect(parseLinearIssueUrl("https://LINEAR.APP/meanwhile/issue/NAT-2061")).toBe("NAT-2061");
  });

  it("returns null for a non-linear URL", () => {
    expect(parseLinearIssueUrl("https://example.com/meanwhile/issue/NAT-2061")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseLinearIssueUrl("not a url")).toBeNull();
    expect(parseLinearIssueUrl("")).toBeNull();
  });

  it("returns null for a linear.app URL that isn't an issue link", () => {
    expect(parseLinearIssueUrl("https://linear.app/meanwhile/settings")).toBeNull();
  });
});

const gql = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, json: async () => payload })) as unknown as typeof fetch;

const node = (identifier: string, over: Record<string, unknown> = {}) => ({
  identifier,
  title: `Title ${identifier}`,
  description: null,
  updatedAt: "2026-07-10T12:00:00.000Z",
  state: { name: "Todo" },
  ...over,
});

describe("canonicalLinearUrl", () => {
  it("strips the slug, trailing slash and query string", () => {
    expect(canonicalLinearUrl("https://linear.app/meanwhile/issue/NAT-2061/ship-it?x=1")).toBe(
      "https://linear.app/meanwhile/issue/NAT-2061",
    );
    expect(canonicalLinearUrl("https://linear.app/meanwhile/issue/NAT-2061/")).toBe(
      "https://linear.app/meanwhile/issue/NAT-2061",
    );
  });

  it("preserves the org slug, which distinguishes issues across orgs", () => {
    expect(canonicalLinearUrl("https://linear.app/other-org/issue/NAT-2061")).toBe(
      "https://linear.app/other-org/issue/NAT-2061",
    );
  });

  it("returns null for anything that isn't a Linear issue URL", () => {
    expect(canonicalLinearUrl("https://example.com/x/issue/NAT-1")).toBeNull();
    expect(canonicalLinearUrl("https://linear.app/meanwhile/settings")).toBeNull();
    expect(canonicalLinearUrl("not a url")).toBeNull();
  });
});

describe("fetchLinearIssueTree", () => {
  it("returns the issue with an empty child list", async () => {
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.variables.id).toBe("NAT-2061");
      expect((init.headers as Record<string, string>).Authorization).toBe("test-key");
      return { ok: true, json: async () => ({ data: { issue: node("NAT-2061", { description: "Some details." }) } }) };
    }) as unknown as typeof fetch;

    expect(await fetchLinearIssueTree("NAT-2061", "test-key", fetchImpl)).toEqual({
      identifier: "NAT-2061",
      title: "Title NAT-2061",
      description: "Some details.",
      state: "Todo",
      updatedAt: "2026-07-10T12:00:00.000Z",
      children: [],
    });
  });

  it("requests three nested levels of children", async () => {
    let sent = "";
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body)).query;
      return { ok: true, json: async () => ({ data: { issue: node("NAT-1") } }) };
    }) as unknown as typeof fetch;

    await fetchLinearIssueTree("NAT-1", "k", fetchImpl);
    expect(sent.match(/children\(first: 25\)/g)).toHaveLength(3);
  });

  it("nests grandchildren, not just direct children", async () => {
    const fetchImpl = gql({
      data: {
        issue: node("NAT-1", {
          children: { nodes: [node("NAT-2", { children: { nodes: [node("NAT-3")] } })] },
        }),
      },
    });

    const tree = await fetchLinearIssueTree("NAT-1", "k", fetchImpl);
    expect(tree!.children[0]!.identifier).toBe("NAT-2");
    expect(tree!.children[0]!.children[0]!.identifier).toBe("NAT-3");
    expect(tree!.children[0]!.children[0]!.children).toEqual([]);
  });

  it("returns null on a non-200 response", async () => {
    expect(await fetchLinearIssueTree("NAT-1", "k", gql({}, false))).toBeNull();
  });

  it("returns null on GraphQL errors", async () => {
    expect(await fetchLinearIssueTree("NAT-1", "k", gql({ errors: [{ message: "nope" }] }))).toBeNull();
  });

  it("returns null when the issue is missing", async () => {
    expect(await fetchLinearIssueTree("NAT-1", "k", gql({ data: { issue: null } }))).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchLinearIssueTree("NAT-1", "k", fetchImpl)).toBeNull();
  });
});

describe("renderLinearIssueTree", () => {
  const tree = (children: unknown[] = []) =>
    ({
      identifier: "NAT-2061",
      title: "Rework dispatch retries",
      description: "Parent description.",
      state: "In Progress",
      updatedAt: "2026-08-01T00:00:00.000Z",
      children,
    }) as never;

  const child = (identifier: string, over: Record<string, unknown> = {}) => ({
    identifier,
    title: `Slice ${identifier}`,
    description: null,
    state: "Todo",
    updatedAt: "2026-08-10T00:00:00.000Z",
    children: [],
    ...over,
  });

  it("leads with the root description", () => {
    expect(renderLinearIssueTree(tree())).toBe("Parent description.");
  });

  it("says so when the root has no description", () => {
    expect(renderLinearIssueTree({ ...tree(), description: null } as never)).toBe("(no description)");
  });

  it("renders each descendant with identifier, title, state and date", () => {
    const out = renderLinearIssueTree(tree([child("NAT-2062", { state: "Done" })]));
    expect(out).toContain("└─ NAT-2062 — Slice NAT-2062 [Done] · updated 2026-08-10");
  });

  it("indents by depth", () => {
    const out = renderLinearIssueTree(tree([child("NAT-2062", { children: [child("NAT-2077")] })]));
    expect(out).toContain("\n└─ NAT-2062");
    expect(out).toContain("\n   └─ NAT-2077");
  });

  it("caps descendant descriptions shorter the deeper they sit", () => {
    const long = "x".repeat(3000);
    const out = renderLinearIssueTree(
      tree([child("NAT-2062", { description: long, children: [child("NAT-2077", { description: long })] })]),
    );
    expect(out).toContain(`└─ NAT-2062 — Slice NAT-2062 [Todo] · updated 2026-08-10\n   ${"x".repeat(800)}\n`);
    expect(out).toContain(`   └─ NAT-2077 — Slice NAT-2077 [Todo] · updated 2026-08-10\n      ${"x".repeat(400)}`);
    expect(out).not.toContain("x".repeat(801));
  });

  it("caps the root description at 2000 chars", () => {
    const out = renderLinearIssueTree({ ...tree(), description: "y".repeat(3000) } as never);
    expect(out).toBe("y".repeat(2000));
  });

  it("stops at the node cap and says how many were dropped", () => {
    const kids = Array.from({ length: 60 }, (_, i) => child(`NAT-${i}`));
    const out = renderLinearIssueTree(tree(kids));
    expect(out.match(/└─ /g)).toHaveLength(LINEAR_MAX_NODES - 1);
    expect(out).toContain(`… ${60 - (LINEAR_MAX_NODES - 1)} further sub-issues not shown`);
  });

  it("hard-caps the whole body and marks the truncation", () => {
    const kids = Array.from({ length: 40 }, (_, i) => child(`NAT-${i}`, { description: "z".repeat(800) }));
    const out = renderLinearIssueTree(tree(kids));
    expect(out.length).toBeLessThanOrEqual(12_000 + "\n… truncated".length);
    expect(out.endsWith("\n… truncated")).toBe(true);
  });
});
