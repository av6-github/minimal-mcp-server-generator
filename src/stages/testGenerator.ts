import type { MCPToolSchema, RCParameter } from "./types.js";

function sampleValidValue(param: RCParameter): string {
  switch (param.type) {
    case "number": return "10";
    case "boolean": return "false";
    case "array": return '["test-item"]';
    case "object": return '{"key": "value"}';
    default: return `"test-${param.name}"`;
  }
}

function sampleInvalidValue(param: RCParameter): string {
  switch (param.type) {
    case "number": return '"not-a-number"';
    case "boolean": return '"not-a-bool"';
    case "array": return '"not-an-array"';
    case "object": return '"not-an-object"';
    default: return "12345";
  }
}

export function generateTestFileImports(): string {
  return `import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/server/inMemory.js";
import { server } from "../index.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

let client: Client;
let serverTransport: InMemoryTransport;
let clientTransport: InMemoryTransport;

beforeAll(async () => {
  // Set up in-memory MCP transport for testing
  [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RC_URL = "https://test.rocket.chat";
  process.env.RC_AUTH_TOKEN = "test-auth-token";
  process.env.RC_USER_ID = "test-user-id";
});
`;
}

export function generateTestFile(tool: MCPToolSchema): string {
  const requiredArgs = tool.parameters.filter(p => p.required);
  const optionalArgs = tool.parameters.filter(p => !p.required);

  const validArgsObj = tool.parameters
    .map(p => `      ${p.name}: ${sampleValidValue(p)}`)
    .join(",\n");

  const validArgsWithoutOptionalsObj = requiredArgs
    .map(p => `      ${p.name}: ${sampleValidValue(p)}`)
    .join(",\n");

  const expectedUrl = tool.httpMethod === "GET"
    ? `expect.stringContaining("${tool.httpPath}")`
    : `\`https://test.rocket.chat${tool.httpPath}\``;

  let zodTests = "";
  if (requiredArgs.length > 0) {
    const missingField = requiredArgs[0].name;
    zodTests += `
  it("fails Zod validation when missing required field '${missingField}'", async () => {
    const invalidArgs = {
${requiredArgs.filter(p => p.name !== missingField).map(p => `      ${p.name}: ${sampleValidValue(p)}`).join(",\n")}
    };
    
    // The MCP Client throws an error if the server returns a JSON-RPC error
    await expect(
      client.callTool({ name: "${tool.name}", arguments: invalidArgs })
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
`;
  }

  if (tool.parameters.length > 0) {
    const typeField = tool.parameters[0];
    zodTests += `
  it("fails Zod validation when passing wrong type for '${typeField.name}'", async () => {
    const invalidArgs = {
${tool.parameters.map(p => p.name === typeField.name ? `      ${p.name}: ${sampleInvalidValue(p)}` : `      ${p.name}: ${sampleValidValue(p)}`).join(",\n")}
    };

    await expect(
      client.callTool({ name: "${tool.name}", arguments: invalidArgs })
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
`;
  }

  if (optionalArgs.length > 0) {
    zodTests += `
  it("handles optional fields gracefully when omitted", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: "mock-response" }),
    });

    const result = await client.callTool({
      name: "${tool.name}",
      arguments: {
${validArgsWithoutOptionalsObj}
      }
    });

    expect(result.content[0].type).toBe("text");
    expect(result.isError).toBeFalsy();
    expect(mockFetch).toHaveBeenCalled();
  });
`;
  }

  return generateTestFileImports() + `
describe("Tool: ${tool.name}", () => {

  // --- Category: HTTP Call Structure ---
  it("produces correct HTTP call (method, URL, headers, and params/body)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: "mock-response" }),
    });

    const result = await client.callTool({
      name: "${tool.name}",
      arguments: {
${validArgsObj}
      }
    });

    // The fetch call must match exactly what the spec describes
    expect(mockFetch).toHaveBeenCalledWith(
      ${expectedUrl},
      expect.objectContaining({
        method: "${tool.httpMethod}",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Auth-Token": "test-auth-token",
          "X-User-Id": "test-user-id",
        }),
      })
    );

    // Assert MCP protocol response formatting
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("mock-response");
    expect(result.isError).toBeFalsy();
  });

  // --- Category: MCP Protocol Compliance ---
  it("returns protocol-compliant error flag on API error responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ success: false, error: "Unauthorized" }),
    });

    const result = await client.callTool({
      name: "${tool.name}",
      arguments: {
${validArgsObj}
      }
    });

    // The SDK wraps errors matching the MCP protocol requirements
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Unauthorized");
    expect(result.isError).toBe(true);
  });

  // --- Category: Zod Schema Correctness ---
${zodTests}
});
`;
}