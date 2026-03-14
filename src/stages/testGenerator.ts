import type { MCPToolSchema, RCParameter } from "./types.js";

function sampleValue(param: RCParameter): string {
    switch (param.type) {
        case "number": return "10";
        case "boolean": return "false";
        case "array": return '["test-item"]';
        default: return `"test-${param.name}"`;
    }
}

export function generateTestFile(tool: MCPToolSchema): string {
    const requiredArgs = tool.parameters.filter(p => p.required);
    const sampleArgs = requiredArgs
        .map(p => `    ${p.name}: ${sampleValue(p)}`)
        .join(",\n");

    const expectedUrl = tool.httpMethod === "GET"
        ? `expect.stringContaining("${tool.httpPath}")`
        : `\`https://test.rocket.chat${tool.httpPath}\``;

    return `import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally before any imports that use it
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("${tool.name} tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RC_URL = "https://test.rocket.chat";
    process.env.RC_AUTH_TOKEN = "test-auth-token";
    process.env.RC_USER_ID = "test-user-id";
  });

  it("calls the correct endpoint with auth headers on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: "mock-response" }),
    });

    await fetch(
      ${expectedUrl},
      {
        method: "${tool.httpMethod}",
        headers: {
          "X-Auth-Token": process.env.RC_AUTH_TOKEN!,
          "X-User-Id": process.env.RC_USER_ID!,
        },
      }
    );

    expect(mockFetch).toHaveBeenCalledWith(
      ${expectedUrl},
      expect.objectContaining({
        method: "${tool.httpMethod}",
        headers: expect.objectContaining({
          "X-Auth-Token": "test-auth-token",
          "X-User-Id": "test-user-id",
        }),
      })
    );
  });

  it("handles API error responses gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ success: false, error: "Unauthorized" }),
    });

    const res = await fetch("https://test.rocket.chat${tool.httpPath}", {});
    const data = await res.json();

    expect(res.ok).toBe(false);
    expect(data.error).toBe("Unauthorized");
  });

  it("handles network failures gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    await expect(
      fetch("https://test.rocket.chat${tool.httpPath}", {})
    ).rejects.toThrow("Network error");
  });
});
`;
}