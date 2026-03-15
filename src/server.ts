import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { listAllApis, resolveApis, findCandidateApis, initializeIndex, getTagDetail, getTagSummaries } from "./stages/specResolver.js";
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

function linkGeneratedServer(outputPath: string, linkedServerName: string): string {
    const settingsPath = `${homedir()}/.gemini/settings.json`;

    let settings: any = {};
    if (existsSync(settingsPath)) {
        try {
            settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        } catch {
            settings = {};
        }
    }

    if (!settings.mcpServers) settings.mcpServers = {};

    // Remove any existing entry pointing to the same output path
    for (const [existingName, existingConfig] of Object.entries(settings.mcpServers) as any) {
        if (existingConfig?.args?.[0]?.includes(outputPath)) {
            delete settings.mcpServers[existingName];
        }
    }

    settings.mcpServers[linkedServerName] = {
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

// Helper to build tag groups from a flat candidate list
// Used when fallback filtering bypasses findCandidateApis tag grouping
function buildTagGroupsFromCandidates(
    candidates: ReturnType<typeof listAllApis>
): Record<string, { endpoints: ReturnType<typeof listAllApis>; totalInTag: number }> {
    const groups: Record<string, { endpoints: ReturnType<typeof listAllApis>; totalInTag: number }> = {};
    for (const c of candidates) {
        const tag = c.sourceFile.replace(".yaml", "");
        if (!groups[tag]) groups[tag] = { endpoints: [], totalInTag: 0 };
        groups[tag].endpoints.push(c);
        groups[tag].totalInTag++;
    }
    return groups;
}

// ─── TOOL 1: List all available RC APIs ──────────────────────────────────────

server.tool(
    "list_rocketchat_apis",
    "List all available Rocket.Chat API endpoints. Filter by keyword or category. Available categories: messaging, rooms, user-management, authentication, omnichannel, integrations, notifications, settings, statistics, content-management, marketplace-apps, miscellaneous.",
    {
        filter: z.string().optional().describe(
            "Keyword to filter by name, description, or HTTP path"
        ),
        category: z.string().optional().describe(
            "Filter by category. Options: messaging, rooms, user-management, authentication, omnichannel, integrations, notifications, settings, statistics, content-management, marketplace-apps, miscellaneous"
        ),
    },
    async ({ filter, category }) => {
        const all = listAllApis();

        let filtered = all;

        // Apply category filter first
        if (category) {
            const cat = category.toLowerCase().replace(/\s+/g, "-");
            filtered = filtered.filter(a =>
                a.category.replace(/\s+/g, "-").includes(cat) ||
                a.sourceFile.toLowerCase().includes(cat)
            );
        }

        // Then apply keyword filter
        if (filter) {
            filtered = filtered.filter(a =>
                a.friendlyName.toLowerCase().includes(filter.toLowerCase()) ||
                a.summary.toLowerCase().includes(filter.toLowerCase()) ||
                a.httpPath.toLowerCase().includes(filter.toLowerCase())
            );
        }

        // Group by category
        const grouped: Record<string, typeof filtered> = {};
        for (const api of filtered) {
            const group = api.sourceFile.replace(".yaml", "");
            if (!grouped[group]) grouped[group] = [];
            grouped[group].push(api);
        }

        const lines: string[] = [
            `## Available Rocket.Chat APIs (${filtered.length} of ${all.length} total)\n`,
        ];

        if (category) lines.push(`**Category filter:** \`${category}\`\n`);
        if (filter) lines.push(`**Keyword filter:** \`${filter}\`\n`);

        for (const [group, apis] of Object.entries(grouped)) {
            lines.push(`### ${group}`);
            for (const api of apis) {
                lines.push(`- **${api.friendlyName}** — ${api.summary} (\`${api.httpMethod} ${api.httpPath}\`)`);
            }
            lines.push("");
        }

        // Show available categories if no filter applied
        if (!category && !filter) {
            const categories = [...new Set(all.map(a => a.sourceFile.replace(".yaml", "")))];
            lines.push(`\n**Available categories:** ${categories.map(c => `\`${c}\``).join(", ")}`);
        }

        lines.push(`\n💡 A full server with all ${all.length} APIs costs ~${all.length * 250} tokens in context.`);
        lines.push(`A minimal server with 5 APIs costs ~1,250 tokens — a ${Math.round(((all.length - 5) / all.length) * 100)}% reduction.`);

        return {
            content: [{ type: "text", text: lines.join("\n") }],
        };
    }
);

// ─── TOOL: Browse APIs by tag (progressive disclosure) ────────────────────────

server.tool(
    "browse_apis_by_tag",
    "Browse RC APIs using progressive disclosure. Call with no tag to see high-level tag summaries (cheap — just counts and names). Call with a specific tag to expand and see all endpoints in that tag. Use this before analyze_requirements when the user wants to explore available APIs.",
    {
        tag: z.string().optional().describe(
            "Tag name to expand. Omit to see all tag summaries. Examples: 'Chat', 'Channels', 'Users', 'Authentication'"
        ),
    },
    async ({ tag }) => {
        if (!tag) {
            // Phase 1 — Show tag summaries only (very cheap)
            const summaries = getTagSummaries();
            const allApis = listAllApis();

            const lines = [
                `## Rocket.Chat API Tags (${summaries.length} tags, ${allApis.length} total endpoints)\n`,
                `Browse by tag to see specific endpoints. Only the tags you expand cost tokens.\n`,
                `| Tag | Endpoints | Sample APIs |`,
                `|-----|-----------|-------------|`,
                ...summaries.map(s =>
                    `| **${s.tag}** | ${s.endpointCount} | ${s.sampleEndpoints.join(", ")} |`
                ),
                `\n💡 Call \`browse_apis_by_tag\` with a tag name to see its endpoints.`,
                `💡 Full server: ~${allApis.length * 250} tokens. A 5-tool server: ~1,250 tokens (99% reduction).`,
            ];

            return {
                content: [{ type: "text", text: lines.join("\n") }],
            };
        }

        // Phase 2 — Expand a specific tag (only pay tokens for what you asked for)
        const detail = getTagDetail(tag);

        if (!detail) {
            const summaries = getTagSummaries();
            const available = summaries.map(s => s.tag).join(", ");
            return {
                content: [{
                    type: "text",
                    text: `❌ Tag "${tag}" not found.\n\nAvailable tags: ${available}`,
                }],
                isError: true,
            };
        }

        const tokenCost = detail.endpoints.length * 15;
        const lines = [
            `## Tag: ${detail.tag} (${detail.endpoints.length} endpoints)\n`,
            ...detail.endpoints.map(e =>
                `- **${e.friendlyName}** — ${e.summary} (\`${e.httpMethod} ${e.httpPath}\`)`
            ),
            `\n**Token cost to load this tag's schemas:** ~${tokenCost} tokens`,
            `\n💡 Add any of these to your server with \`propose_mcp_server\` or \`/generate-mcp\`.`,
        ];

        return {
            content: [{ type: "text", text: lines.join("\n") }],
        };
    }
);

// ─── TOOL 2: Propose APIs and wait for confirmation ───────────────────────────

server.tool(
    "propose_mcp_server",
    "Show the user a proposed list of APIs for their minimal MCP server and ask them to confirm, modify, or add more before generating. Always use this before generate_mcp_server unless the user has already confirmed their API list.",
    {
        requirements: z.string().describe(
            "The user's original requirements or use case description"
        ),
        proposedApis: z.array(z.string()).describe(
            "The proposed list of API friendly names to include"
        ),
        reasoning: z.record(z.string(), z.string()).describe(
            "A map of API name to reason why it was selected"
        ),
    },
    async ({ requirements, proposedApis, reasoning }) => {
        const { resolved, notFound } = resolveApis(proposedApis);
        const allApis = listAllApis();

        const estimatedTokens = resolved.length * 250;
        const fullTokens = allApis.length * 250;
        const savings = Math.round(((fullTokens - estimatedTokens) / fullTokens) * 100);

        const toolLines = resolved.map(r => {
            const reason = reasoning[r.friendlyName] || reasoning[r.operationId] || "selected for your use case";
            return `  - \`${r.friendlyName}\` — ${r.summary} (\`${r.httpMethod} ${r.httpPath}\`)\n    _Reason: ${reason}_`;
        }).join("\n");

        const notFoundWarning = notFound.length > 0
            ? `\n⚠️  Not found (will be skipped): ${notFound.join(", ")}`
            : "";

        return {
            content: [{
                type: "text",
                text: `## 📋 Proposed Minimal MCP Server

**Your requirement:** ${requirements}

**Proposed tools (${resolved.length}):**
${toolLines}
${notFoundWarning}

**Estimated token cost:** ~${estimatedTokens} tokens (vs ~${fullTokens} for full RC server — **${savings}% savings**)

---
**What would you like to do?**
- ✅ Type **"confirm"** or **"generate"** to generate this server
- ➕ Type **"add <api name>"** to add more APIs
- ➖ Type **"remove <api name>"** to remove an API
- 🔍 Type **"show messaging apis"** (or any category) to browse more options

Waiting for your confirmation before generating...`,
            }],
        };
    }
);

// ─── TOOL: Ask for server name ────────────────────────────────────────────────

server.tool(
    "ask_server_name",
    "Ask the user to provide a name for their MCP server before generating. Call this after the user confirms the API list and before calling generate_mcp_server.",
    {
        suggestedName: z.string().describe(
            "A suggested name based on the use case e.g. 'messaging', 'channels', 'admin'"
        ),
        toolCount: z.number().describe(
            "Number of tools in the confirmed API list"
        ),
    },
    async ({ suggestedName, toolCount }) => {
        return {
            content: [{
                type: "text",
                text: `## 🏷️ Name Your MCP Server

Your ${toolCount}-tool server is ready to generate.

What would you like to name it? This will be its identifier in gemini-cli.

**Suggested name:** \`${suggestedName}\`

- Type the name to use (e.g. \`messaging\`, \`channels\`, \`admin\`)
- Or just type **"use suggested"** to go with \`${suggestedName}\`

The server will be accessible as \`rocketchat-<name>\` in gemini-cli.`,
            }],
        };
    }
);

// ─── TOOL 3: Generate the minimal MCP server ─────────────────────────────────

server.tool(
    "generate_mcp_server",
    "Generate a minimal production-ready MCP server for a specified subset of Rocket.Chat APIs. Output includes TypeScript source, tests, package.json, tsconfig, .env.example, and README.",
    {
        apis: z.array(z.string()).describe(
            "List of API names to include. Can use friendly names like 'postMessage', 'getChannels', or operationIds."
        ),
        outputPath: z.string().optional().describe(
            "Output directory path. Defaults to ./output/<serverName>"
        ),
        serverName: z.string().optional().describe(
            "A short memorable name e.g. 'messaging', 'channels', 'admin'. Used as the server identifier in gemini-cli."
        ),
    },
    async ({ apis, outputPath, serverName }) => {

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

        // Resolve server name — user-provided or auto-generated from tool names
        const resolvedServerName = serverName
            ? `rocketchat-${serverName.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()}`
            : `rocketchat-${tools.map(t => t.name).join("-").slice(0, 30)}`;

        const resolvedOutput = outputPath ||
            join(__dirname, `../output/${resolvedServerName}`);

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

        // Auto-link to gemini-cli settings
        const settingsPath = linkGeneratedServer(outputDir, resolvedServerName);

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
**Server name:** \`${resolvedServerName}\`

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

**Auto-linked to gemini-cli:**
Added to \`${settingsPath}\` as \`${resolvedServerName}\`.
⚠️  Restart gemini-cli to load the new server into your session.

**Next steps:**
\`\`\`bash
cd ${outputDir}
cp .env.example .env
npm install && npm run build && npm test
\`\`\`
${warnings}`,
            }],
        };
    }
);

// ─── TOOL 4: Analyze requirements and suggest APIs ────────────────────────────

server.tool(
    "analyze_requirements",
    "Pre-filter RC APIs from plain English requirement. Narrows 555 APIs to ~20 candidates deterministically.",
    {
        requirements: z.string().describe(
            "Plain English description of what the developer needs to build."
        ),
    },
    async ({ requirements }) => {
        const result = findCandidateApis(requirements);
        const { candidates, matchedKeywords, coverage } = result;
        const allApis = listAllApis();

        // Fallback to category-based filtering if keyword coverage is too low
        let finalCandidates = candidates;
        let fallbackUsed = false;

        if (coverage < 30 || candidates.length < 3) {
            const categoryKeywords: Record<string, string[]> = {
                "messaging": ["message", "chat", "send", "post", "reply", "thread", "mention", "pin", "star"],
                "rooms": ["channel", "room", "group", "create", "join", "leave", "archive", "rename", "topic"],
                "user-management": ["user", "profile", "account", "member", "role", "permission", "status"],
                "authentication": ["login", "auth", "authentication", "token", "oauth", "password", "session", "2fa", "credentials", "signin", "signup"],
                "omnichannel": ["livechat", "visitor", "agent", "omnichannel", "support", "ticket", "department"],
                "integrations": ["webhook", "integration", "trigger", "incoming", "outgoing"],
                "notifications": ["notification", "push", "alert", "subscribe", "email"],
                "settings": ["setting", "config", "workspace", "admin", "preference"],
            };

            const reqLower = requirements.toLowerCase();
            const matchedCategories: string[] = [];

            for (const [cat, keywords] of Object.entries(categoryKeywords)) {
                if (keywords.some(k => reqLower.includes(k))) {
                    matchedCategories.push(cat);
                }
            }

            if (matchedCategories.length > 0) {
                finalCandidates = allApis
                    .filter(a => matchedCategories.some(cat => a.sourceFile.includes(cat)))
                    .slice(0, 20);
                fallbackUsed = true;
            } else {
                finalCandidates = allApis
                    .filter(a => a.sourceFile.includes("messaging") || a.sourceFile.includes("rooms"))
                    .slice(0, 20);
                fallbackUsed = true;
            }
        }

        // Build tag groups — MUST come after finalCandidates is resolved
        const tagGroups = fallbackUsed
            ? buildTagGroupsFromCandidates(finalCandidates)
            : result.tagGroups;

        // Build tag-grouped catalogue
        const tagGroupedLines: string[] = [];

        if (Object.keys(tagGroups).length > 0) {
            for (const [tag, group] of Object.entries(tagGroups)) {
                const tagCandidates = group.endpoints.filter(e =>
                    finalCandidates.find(f => f.operationId === e.operationId)
                );
                if (tagCandidates.length === 0) continue;

                tagGroupedLines.push(
                    `\n### ${tag} (${tagCandidates.length} relevant of ${group.totalInTag} total)`
                );
                for (const api of tagCandidates) {
                    tagGroupedLines.push(
                        `${api.friendlyName} | ${api.summary} | ${api.httpMethod} ${api.httpPath}`
                    );
                }
            }
        } else {
            // Fallback — flat list if no tags available
            for (const a of finalCandidates) {
                tagGroupedLines.push(
                    `${a.friendlyName} | ${a.summary} | ${a.httpMethod} ${a.httpPath}`
                );
            }
        }

        const catalogue = tagGroupedLines.join("\n");

        const tokensBefore = allApis.length * 15;
        const tokensAfter = finalCandidates.length * 15;
        const tokensSaved = tokensBefore - tokensAfter;

        const filterMethod = fallbackUsed
            ? `category-based fallback (keyword coverage was ${coverage}%)`
            : `keyword matching (${coverage}% coverage)`;

        // Build pre-selected suggestion
        const ambiguousNames = new Set(["delete", "create", "list", "info", "update",
            "history", "close", "open", "join", "leave", "invite", "kick", "rename"]);

        const topCandidates = finalCandidates.slice(0, 5);

        const suggestedApiNames = topCandidates.map(a => {
            if (ambiguousNames.has(a.friendlyName)) {
                const pathSegment = a.httpPath.split("/api/v1/")[1] ||
                    a.httpPath.split("/api/")[1] ||
                    a.friendlyName;
                return `"${pathSegment}"`;
            }
            return `"${a.friendlyName}"`;
        });

        const suggestedReasoning = topCandidates.map(a => {
            const key = ambiguousNames.has(a.friendlyName)
                ? (a.httpPath.split("/api/v1/")[1] || a.friendlyName)
                : a.friendlyName;
            return `"${key}": "needed for ${requirements}"`;
        });

        return {
            content: [{
                type: "text",
                text: `## Requirements Analysis

        **Requirement:** ${requirements}

        **Pre-filtering result:**
        - Method: ${filterMethod}
        - Matched keywords: ${matchedKeywords.length > 0 ? matchedKeywords.join(", ") : "none — used category fallback"}
        - Narrowed from ${allApis.length} APIs → ${finalCandidates.length} candidates
        - Token savings: ~${tokensSaved} tokens

        **Relevant API candidates by tag:**
        ${catalogue}

        ---
        **⚡ Suggested selection — call \`propose_mcp_server\` with this directly:**
        \`\`\`
        proposedApis: [${suggestedApiNames.join(", ")}]
        reasoning: { ${suggestedReasoning.join(", ")} }
        \`\`\`

        **Rules:**
        - Use the suggested selection above as a starting point — adjust only if needed
        - Prefer \`postMessage\` over \`sendMessage\` for any message sending
        - For ambiguous names (delete, create, list etc.) always use path format: \`chat.delete\` not \`delete\`
        - ⚠️ Do NOT call \`list_rocketchat_apis\` to verify — paths above are authoritative
        - Call \`propose_mcp_server\` now with the selection above`,
            }],
        };
    }
);

// ─── Start server ─────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();

// Load specs from GitHub (or cache/local fallback)
const pat = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
console.error(`[startup] Loading RC API specs ${pat ? "(GitHub + PAT)" : "(GitHub, no PAT — rate limits apply)"}...`);
await initializeIndex();
console.error("[startup] Specs ready.");

await server.connect(transport);