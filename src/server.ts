import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { listAllApis, resolveApis } from "./stages/specResolver.js";
import { mapToMCPSchema } from "./stages/schemaMapper.js";
import { writeOutput } from "./stages/outputWriter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const server = new McpServer({
    name: "rocketchat-mcp-generator",
    version: "1.0.0",
});

// ─── TOOL 1: List all available RC APIs ──────────────────────────────────────

server.tool(
    "list_rocketchat_apis",
    "List all available Rocket.Chat API endpoints that can be included in a generated minimal MCP server. Use this to help the user discover what APIs exist before generating.",
    {
        filter: z.string().optional().describe("Optional keyword to filter APIs by name or description"),
    },
    async ({ filter }) => {
        const all = listAllApis();

        const filtered = filter
            ? all.filter(a =>
                a.friendlyName.toLowerCase().includes(filter.toLowerCase()) ||
                a.summary.toLowerCase().includes(filter.toLowerCase()) ||
                a.sourceFile.replace(".yaml", "").toLowerCase().includes(filter.toLowerCase())
            )
            : all;

        // Group by source file
        const grouped: Record<string, typeof filtered> = {};
        for (const api of filtered) {
            const group = api.sourceFile.replace(".yaml", "");
            if (!grouped[group]) grouped[group] = [];
            grouped[group].push(api);
        }

        const lines: string[] = [
            `## Available Rocket.Chat APIs (${filtered.length} of ${all.length} total)\n`,
        ];

        for (const [group, apis] of Object.entries(grouped)) {
            lines.push(`### ${group}`);
            for (const api of apis) {
                lines.push(`- **${api.friendlyName}** — ${api.summary} (\`${api.httpMethod} ${api.httpPath}\`)`);
            }
            lines.push("");
        }

        lines.push(`\n💡 Tip: A full server with all ${all.length} APIs would cost ~${all.length * 250} tokens in context.`);
        lines.push(`A minimal server with 5 APIs costs ~1,250 tokens — a ${Math.round(((all.length - 5) / all.length) * 100)}% reduction.`);

        return {
            content: [{ type: "text", text: lines.join("\n") }],
        };
    }
);

// ─── TOOL 2: Generate the minimal MCP server ─────────────────────────────────

server.tool(
    "generate_mcp_server",
    "Generate a minimal production-ready MCP server for a specified subset of Rocket.Chat APIs. Output includes TypeScript source, tests, package.json, tsconfig, .env.example, and README.",
    {
        apis: z.array(z.string()).describe(
            "List of API names to include. Can use friendly names like 'sendMessage', 'getChannels', or operationIds."
        ),
        outputPath: z.string().optional().describe(
            "Output directory path. Defaults to ./output/rocketchat-minimal-mcp"
        ),
    },
    async ({ apis, outputPath }) => {
        const resolvedOutput = outputPath || join(__dirname, "../output/rocketchat-minimal-mcp");

        // Stage 1: Resolve API names from spec
        const { resolved, notFound } = resolveApis(apis);

        if (resolved.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: `❌ No matching APIs found for: ${apis.join(", ")}\n\nUse \`list_rocketchat_apis\` to see all available APIs.`,
                }],
                isError: true,
            };
        }

        // Stage 2: Map to MCP schemas
        const tools = resolved.map(mapToMCPSchema);

        // Get total API count for token savings calculation
        const totalApiCount = listAllApis().length;

        // Stages 3+4+5: Generate code, tests, and write to disk
        const outputDir = writeOutput(tools, totalApiCount, resolvedOutput);

        // Build response summary
        const minTokens = tools.length * 250;
        const fullTokens = totalApiCount * 250;
        const savedTokens = fullTokens - minTokens;
        const savedPct = Math.round((savedTokens / fullTokens) * 100);

        const toolList = tools.map(t =>
            `  - \`${t.name}\`: ${t.description}`
        ).join("\n");

        const warnings = notFound.length > 0
            ? `\n\n⚠️  APIs not found (skipped): ${notFound.join(", ")}\nRun \`list_rocketchat_apis\` to see valid API names.`
            : "";

        return {
            content: [{
                type: "text",
                text: `## ✅ Minimal MCP Server Generated

**Output directory:** \`${outputDir}\`

**Tools included (${tools.length}):**
${toolList}

**Token savings:**
- Full RC MCP server (~${totalApiCount} APIs): ~${fullTokens.toLocaleString()} tokens
- Your minimal server (${tools.length} APIs): ~${minTokens.toLocaleString()} tokens
- **Saved: ~${savedTokens.toLocaleString()} tokens (${savedPct}% reduction)**

**Files generated:**
- \`src/index.ts\` — the MCP server
- \`src/tests/*.test.ts\` — ${tools.length} test file(s)
- \`package.json\`, \`tsconfig.json\`, \`.env.example\`, \`README.md\`

**Next steps:**
\`\`\`bash
cd ${outputDir}
cp .env.example .env
# Fill in your RC credentials
npm install
npm run build
npm test
\`\`\`
${warnings}`,
            }],
        };
    }
);

// ─── Start server ─────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);