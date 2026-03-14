import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { listAllApis, resolveApis } from "./stages/specResolver.js";
import { mapToMCPSchema } from "./stages/schemaMapper.js";
import { writeOutput } from "./stages/outputWriter.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const server = new McpServer({
    name: "rocketchat-mcp-generator",
    version: "1.0.0",
});

// ─── AUTO-LINK HELPER ─────────────────────────────────────────────────────────

function linkGeneratedServer(outputPath: string, serverName: string): string {
    const settingsPath = `${homedir()}/.gemini/settings.json`;

    let settings: any = {};
    if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    }

    if (!settings.mcpServers) settings.mcpServers = {};

    settings.mcpServers[serverName] = {
        command: "node",
        args: [`${outputPath}/dist/index.js`],
        cwd: outputPath,
        env: {
            RC_URL: process.env.RC_URL || "",
            RC_AUTH_TOKEN: process.env.RC_AUTH_TOKEN || "",
            RC_USER_ID: process.env.RC_USER_ID || "",
        }
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
}

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
        // Auto-build the generated server
        try {
            execSync("npm install && npm run build", {
                cwd: outputDir,
                stdio: "pipe",
            });
        } catch (e: any) {
            console.error("Auto-build failed:", e);
        }
        const serverName = `rocketchat-${tools.map(t => t.name).join("-").slice(0, 40)}`;
        const settingsPath = linkGeneratedServer(outputDir, serverName);

        // Build response summary — real token analysis
        const toolTokenCosts = tools.map(t => {
            const tokens = Math.ceil(t.name.length / 4) +
                Math.ceil(t.description.length / 4) +
                Object.keys(t.inputSchema.properties).length * 15 +
                Object.values(t.inputSchema.properties)
                    .reduce((sum: number, p: any) => sum + Math.ceil((p.description?.length || 0) / 4), 0) + 20;
            return { name: t.name, tokens };
        });

        const minTokens = toolTokenCosts.reduce((sum, t) => sum + t.tokens, 0);
        const fullTokens = Math.round((minTokens / tools.length) * totalApiCount);
        const savedTokens = fullTokens - minTokens;
        const savedPct = Math.round((savedTokens / fullTokens) * 100);
        const costSavedPerLoop = (((savedTokens * 20) / 1_000_000) * 3.0).toFixed(4);
        const costSavedMonthly = (((savedTokens * 20 * 100) / 1_000_000) * 3.0).toFixed(2);

        const tokenBreakdown = toolTokenCosts
            .map(t => `  - \`${t.name}\`: ~${t.tokens} tokens`)
            .join("\n");

        const toolList = tools.map(t =>
            `  - \`${t.name}\`: ${t.description}`
        ).join("\n");

        const warnings = notFound.length > 0
            ? `\n\n⚠️  APIs not found (skipped): ${notFound.join(", ")}`
            : "";

        return {
            content: [{
                type: "text",
                text: `## ✅ Minimal MCP Server Generated

        **Output:** \`${outputDir}\`

        **Tools included (${tools.length}):**
        ${toolList}

        **Token analysis (per tool):**
        ${tokenBreakdown}

        **Total token cost:**
        | | Tokens | Cost/loop (20 iter) | Cost/month (100 tasks) |
        |---|---|---|---|
        | This server | ~${minTokens} | $${(((minTokens * 20) / 1_000_000) * 3.0).toFixed(4)} | $${(((minTokens * 20 * 100) / 1_000_000) * 3.0).toFixed(2)} |
        | Full RC server | ~${fullTokens} | $${(((fullTokens * 20) / 1_000_000) * 3.0).toFixed(4)} | $${(((fullTokens * 20 * 100) / 1_000_000) * 3.0).toFixed(2)} |
        | **Saved** | **~${savedTokens} (${savedPct}%)** | **$${costSavedPerLoop}** | **$${costSavedMonthly}** |

        **Files generated:**
        - \`src/index.ts\` — the MCP server
        - \`src/tests/*.test.ts\` — ${tools.length} test file(s)
        - \`package.json\`, \`tsconfig.json\`, \`.env.example\`, \`README.md\`

        **Next steps:**
        \`\`\`bash
        cd ${outputDir}
        cp .env.example .env
        npm install && npm run build && npm test

        **Auto-linked to gemini-cli:**
        The generated server has been added to \`${settingsPath}\` as \`${serverName}\`.
        Restart gemini-cli and you can use the tools directly — no scripting needed.

        \`\`\`
        ${warnings}`,
            }],
        };
    }
);

// ─── TOOL 3: Analyze requirements and suggest APIs ────────────────────────────

server.tool(
    "analyze_requirements",
    "Analyze a plain English description of what a developer needs to build with Rocket.Chat, and suggest the minimal set of RC APIs required. Use this before generate_mcp_server when the user describes their use case instead of listing specific APIs.",
    {
        requirements: z.string().describe(
            "Plain English description of what the developer needs to build. E.g. 'I need a bot that monitors channels and sends alerts'"
        ),
    },
    async ({ requirements }) => {
        const allApis = listAllApis();

        // Build a compact API catalogue for the LLM to reason over
        const catalogue = allApis
            .map(a => `${a.friendlyName} | ${a.summary} | ${a.httpMethod} ${a.httpPath}`)
            .join("\n");

        // Call the Anthropic/Gemini API to analyze requirements
        // In gemini-cli context, we use the model that's already running
        // We return a structured suggestion that gemini can act on
        const prompt = `You are an expert in Rocket.Chat APIs and MCP (Model Context Protocol).

A developer has described what they need to build:
"${requirements}"

Here is the complete list of available Rocket.Chat APIs:
${catalogue}

Your task:
1. Identify the MINIMAL set of APIs needed to fulfill the requirements
2. Explain why each API is needed
3. Estimate token savings vs using the full API set

Respond in this exact JSON format:
{
  "selectedApis": ["friendlyName1", "friendlyName2"],
  "reasoning": {
    "friendlyName1": "why this API is needed",
    "friendlyName2": "why this API is needed"
  },
  "excluded": "brief explanation of what was intentionally left out"
}`;

        // Return the prompt and catalogue so gemini-cli's own LLM can reason over it
        // This is more efficient than making a separate API call
        return {
            content: [{
                type: "text",
                text: `## Requirements Analysis

**Developer's requirement:** ${requirements}

**Task for you (the LLM):** Based on the requirement above and the API catalogue below, select the minimal set of APIs needed and then immediately call \`generate_mcp_server\` with those APIs.

**Available APIs:**
${allApis.map(a => `- \`${a.friendlyName}\`: ${a.summary}`).join("\n")}

**Instructions:**
1. Select only APIs that are directly needed
2. Err on the side of fewer APIs — the whole point is minimalism
3. Call \`generate_mcp_server\` with your selected API names
4. Report your reasoning for each selection`
            }]
        };
    }
);

// ─── Start server ─────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);