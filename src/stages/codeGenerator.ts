import type { MCPToolSchema, RCParameter, GeneratedFile } from "./types.js";

// ─── ZOD SCHEMA GENERATOR ─────────────────────────────────────────────────────

function zodField(param: RCParameter): string {
  let field: string;
  switch (param.type) {
    case "number": field = "z.number()"; break;
    case "boolean": field = "z.boolean()"; break;
    case "array": field = "z.array(z.string())"; break;
    case "object": field = "z.record(z.string(), z.unknown())"; break;
    default: field = "z.string()";
  }
  if (!param.required) field += ".optional()";
  // Escape quotes in description
  const desc = param.description
    .replace(/\r?\n/g, " ")   // flatten newlines
    .replace(/"/g, '\\"')      // escape quotes
    .replace(/\s+/g, " ")      // collapse whitespace
    .trim()
    .slice(0, 120);             // cap length — descriptions don't need to be essays
  field += `.describe("${desc}")`;
  return field;
}

// ─── HTTP CALL GENERATOR ──────────────────────────────────────────────────────

function generateHttpCall(tool: MCPToolSchema): string {
  const queryParams = tool.parameters.filter(p => p.in === "query" || p.in === "path");
  const bodyParams = tool.parameters.filter(p => p.in === "body");
  const argNames = tool.parameters.map(p => p.name).join(", ");

  let urlLine: string;
  let queryBlock = "";
  let bodyLine = "";

  if (tool.httpMethod === "GET" && queryParams.length > 0) {
    queryBlock = `
    const _query = new URLSearchParams();
    ${queryParams.map(p => `if (${p.name} !== undefined) _query.append("${p.name}", String(${p.name}));`).join("\n    ")}
    const _qs = _query.toString() ? \`?\${_query.toString()}\` : "";`;
    urlLine = `\`\${process.env.RC_URL}${tool.httpPath}\${_qs}\``;
  } else {
    urlLine = `\`\${process.env.RC_URL}${tool.httpPath}\``;
  }

  if (tool.httpMethod === "POST" && bodyParams.length > 0) {
    // Group params by their bodyWrapper
    const wrappers: Record<string, string[]> = {};
    const flat: string[] = [];

    for (const p of bodyParams) {
      if (p.bodyWrapper) {
        if (!wrappers[p.bodyWrapper]) wrappers[p.bodyWrapper] = [];
        wrappers[p.bodyWrapper].push(p.name);
      } else {
        flat.push(p.name);
      }
    }

    const bodyParts: string[] = [];

    for (const name of flat) {
      bodyParts.push(`      ${name}`);
    }

    for (const [wrapper, fields] of Object.entries(wrappers)) {
      const fieldLines = fields.map(f => `        ${f}`).join(",\n");
      bodyParts.push(`      ${wrapper}: {\n${fieldLines}\n      }`);
    }

    bodyLine = `body: JSON.stringify({\n${bodyParts.join(",\n")}\n    }),`;
  }

  return `
  async ({ ${argNames} }) => {
    ${queryBlock}
    const _res = await fetch(
      ${urlLine},
      {
        method: "${tool.httpMethod}",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": process.env.RC_AUTH_TOKEN!,
          "X-User-Id": process.env.RC_USER_ID!,
        },
        ${bodyLine}
      }
    );
    const _data = await _res.json();
    if (!_res.ok) {
      return {
        content: [{ type: "text" as const, text: \`Error: \${_data.error || _data.message || "Unknown error"}\` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(_data, null, 2) }],
    };
  }`;
}
// ─── SINGLE TOOL BLOCK GENERATOR ─────────────────────────────────────────────

function generateToolBlock(tool: MCPToolSchema): string {
  const zodParams = tool.parameters
    .map(p => `    ${p.name}: ${zodField(p)}`)
    .join(",\n");

  const handler = generateHttpCall(tool);

  return `
// ── Tool: ${tool.name} ${"─".repeat(Math.max(0, 50 - tool.name.length))}
server.tool(
  "${tool.name}",
  "${tool.description.replace(/"/g, '\\"')}",
  {
${zodParams}
  },
${handler}
);`;
}

// ─── FULL SERVER FILE GENERATOR ───────────────────────────────────────────────

export function generateServerFile(tools: MCPToolSchema[]): string {
  const toolBlocks = tools.map(generateToolBlock).join("\n");

  return `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "rocketchat-minimal",
  version: "1.0.0",
});
${toolBlocks}

// ── Start server ──────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

// ─── PACKAGE.JSON GENERATOR ───────────────────────────────────────────────────

export function generatePackageJson(toolCount: number): string {
  return JSON.stringify({
    name: "rocketchat-minimal-mcp",
    version: "1.0.0",
    description: `Minimal Rocket.Chat MCP server with ${toolCount} tools`,
    type: "module",
    main: "dist/index.js",
    scripts: {
      start: "node dist/index.js",
      build: "tsc",
      test: "vitest run",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.0.0",
      zod: "^3.22.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
      vitest: "^1.0.0",
      "@types/node": "^20.0.0",
    },
  }, null, 2);
}

// ─── TSCONFIG GENERATOR ───────────────────────────────────────────────────────

export function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      outDir: "./dist",
      rootDir: "./src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src/**/*"],
    exclude: ["node_modules", "dist"],
  }, null, 2);
}

// ─── ENV EXAMPLE GENERATOR ───────────────────────────────────────────────────

export function generateEnvExample(): string {
  return `# Rocket.Chat instance URL (no trailing slash)
RC_URL=https://your.rocket.chat

# Authentication credentials
# Get these from: Profile > My Account > Personal Access Tokens
RC_AUTH_TOKEN=your_personal_access_token
RC_USER_ID=your_user_id
`;
}

// ─── README GENERATOR ─────────────────────────────────────────────────────────

export function generateReadme(tools: MCPToolSchema[], totalApiCount: number): string {

  // Calculate real token costs per tool
  const toolTokenCosts = tools.map(t => {
    const nameTokens = Math.ceil(t.name.length / 4);
    const descTokens = Math.ceil(t.description.length / 4);
    const schemaTokens = Object.keys(t.inputSchema.properties).length * 15;
    const propDescTokens = Object.values(t.inputSchema.properties)
      .reduce((sum, p) => sum + Math.ceil((p.description?.length || 0) / 4), 0);
    const total = nameTokens + descTokens + schemaTokens + propDescTokens + 20; // 20 for structure
    return { name: t.name, tokens: total };
  });

  const minimalTokens = toolTokenCosts.reduce((sum, t) => sum + t.tokens, 0);
  const avgTokensPerTool = Math.round(minimalTokens / tools.length);
  const fullTokens = Math.round((minimalTokens / tools.length) * totalApiCount);
  const savedTokens = fullTokens - minimalTokens;
  const savedPct = Math.round((savedTokens / fullTokens) * 100);

  // Cost calculations (Claude Sonnet pricing: $3/1M input tokens)
  const costPer1M = 3.0;
  const costPerRunMinimal = ((minimalTokens / 1_000_000) * costPer1M).toFixed(6);
  const costPerRunFull = ((fullTokens / 1_000_000) * costPer1M).toFixed(6);

  // Agentic loop costs (20 iterations is typical)
  const loopIterations = 20;
  const loopCostMinimal = ((minimalTokens * loopIterations / 1_000_000) * costPer1M).toFixed(4);
  const loopCostFull = ((fullTokens * loopIterations / 1_000_000) * costPer1M).toFixed(4);

  // Monthly costs (100 tasks/month)
  const tasksPerMonth = 100;
  const monthlyCostMinimal = ((minimalTokens * loopIterations * tasksPerMonth / 1_000_000) * costPer1M).toFixed(2);
  const monthlyCostFull = ((fullTokens * loopIterations * tasksPerMonth / 1_000_000) * costPer1M).toFixed(2);

  const toolBreakdown = toolTokenCosts
    .map(t => `| \`${t.name}\` | ~${t.tokens} tokens |`)
    .join("\n");

  const toolList = tools
    .map(t => `| \`${t.name}\` | ${t.description} | \`${t.httpMethod} ${t.httpPath}\` |`)
    .join("\n");

  return `# Rocket.Chat Minimal MCP Server

> Generated by [gemini-rocketchat-mcp-generator](https://github.com/your-repo)

## Exposed Tools (${tools.length} of ${totalApiCount} available)

| Tool | Description | Endpoint |
|------|-------------|----------|
${toolList}

## Token Analysis

### Per-tool token cost breakdown
| Tool | Token Cost |
|------|-----------|
${toolBreakdown}
| **Total (this server)** | **~${minimalTokens} tokens** |
| Full RC server (~${totalApiCount} tools) | ~${fullTokens} tokens |
| **Savings** | **~${savedTokens} tokens (${savedPct}%)** |

### Real cost impact (Claude Sonnet @ $3/1M tokens)

| Scenario | Minimal Server | Full Server | Savings |
|----------|---------------|-------------|---------|
| Single agent call | $${costPerRunMinimal} | $${costPerRunFull} | $${(parseFloat(costPerRunFull) - parseFloat(costPerRunMinimal)).toFixed(6)} |
| Agentic loop (${loopIterations} iterations) | $${loopCostMinimal} | $${loopCostFull} | $${(parseFloat(loopCostFull) - parseFloat(loopCostMinimal)).toFixed(4)} |
| Monthly (${tasksPerMonth} tasks × ${loopIterations} iterations) | $${monthlyCostMinimal} | $${monthlyCostFull} | $${(parseFloat(monthlyCostFull) - parseFloat(monthlyCostMinimal)).toFixed(2)} |

### Context window impact
- Available context window (Claude Sonnet): 200,000 tokens
- Full server overhead: **${((fullTokens / 200000) * 100).toFixed(1)}%** of context consumed by tool definitions alone
- Minimal server overhead: **${((minimalTokens / 200000) * 100).toFixed(1)}%** of context
- **Context freed up for actual work: ${((savedTokens / 200000) * 100).toFixed(1)}% of context window**
`;
}