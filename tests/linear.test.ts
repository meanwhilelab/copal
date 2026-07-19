import { describe, expect, it } from "vitest";
import { fetchLinearIssue, parseLinearIssueUrl } from "../src/core/linear.js";

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

describe("fetchLinearIssue", () => {
  it("returns the issue on a successful response", async () => {
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.variables.id).toBe("NAT-2061");
      expect((init.headers as Record<string, string>).Authorization).toBe("test-key");
      return {
        ok: true,
        json: async () => ({
          data: {
            issue: {
              identifier: "NAT-2061",
              title: "Ship the thing",
              description: "Some details.",
              updatedAt: "2026-07-10T12:00:00.000Z",
              state: { name: "In Progress" },
            },
          },
        }),
      };
    }) as unknown as typeof fetch;

    const issue = await fetchLinearIssue("NAT-2061", "test-key", fetchImpl);
    expect(issue).toEqual({
      identifier: "NAT-2061",
      title: "Ship the thing",
      description: "Some details.",
      state: "In Progress",
      updatedAt: "2026-07-10T12:00:00.000Z",
      children: [],
    });
  });

  it("returns sub-issues when the issue has children", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            identifier: "NAT-2061",
            title: "Epic",
            description: "Parent.",
            updatedAt: "2026-07-10T12:00:00.000Z",
            state: { name: "In Progress" },
            children: {
              nodes: [
                {
                  identifier: "NAT-2062",
                  title: "First slice",
                  description: null,
                  updatedAt: "2026-07-11T09:00:00.000Z",
                  state: { name: "Todo" },
                },
              ],
            },
          },
        },
      }),
    })) as unknown as typeof fetch;

    const issue = await fetchLinearIssue("NAT-2061", "test-key", fetchImpl);
    expect(issue?.children).toEqual([
      {
        identifier: "NAT-2062",
        title: "First slice",
        description: null,
        state: "Todo",
        updatedAt: "2026-07-11T09:00:00.000Z",
      },
    ]);
  });

  it("returns null on a non-200 response", async () => {
    const fetchImpl = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchLinearIssue("NAT-2061", "test-key", fetchImpl)).toBeNull();
  });

  it("returns null on GraphQL errors", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: "not found" }] }),
    })) as unknown as typeof fetch;
    expect(await fetchLinearIssue("NAT-2061", "test-key", fetchImpl)).toBeNull();
  });

  it("returns null when the issue is missing", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ data: { issue: null } }) })) as unknown as typeof fetch;
    expect(await fetchLinearIssue("NAT-2061", "test-key", fetchImpl)).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchLinearIssue("NAT-2061", "test-key", fetchImpl)).toBeNull();
  });
});
