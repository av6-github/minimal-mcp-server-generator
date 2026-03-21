import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import type { RCEndpoint, RCParameter } from "./types.js";
import SwaggerParser from "@apidevtools/swagger-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(__dirname, "../specs");

const RC_OPENAPI_REPO = "https://raw.githubusercontent.com/RocketChat/Rocket.Chat-Open-API/main";

const CACHE_DIR = join(__dirname, "../specs-cache");
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const SPEC_FILES = [
    "authentication.yaml",
    "content-management.yaml",
    "integrations.yaml",
    "marketplace-apps.yaml",
    "messaging.yaml",
    "miscellaneous.yaml",
    "notifications.yaml",
    "omnichannel.yaml",
    "rooms.yaml",
    "settings.yaml",
    "statistics.yaml",
    "user-management.yaml",
];

// ─── LOAD AND PARSE ALL YAML SPEC FILES ──────────────────────────────────────

// ─── CACHE HELPERS ────────────────────────────────────────────────────────────

function getCachePath(filename: string): string {
    return join(CACHE_DIR, filename);
}

function isCacheValid(filename: string): boolean {
    const cachePath = getCachePath(filename);
    if (!existsSync(cachePath)) return false;
    try {
        const stats = require("fs").statSync(cachePath);
        return (Date.now() - stats.mtimeMs) < CACHE_MAX_AGE_MS;
    } catch {
        return false;
    }
}

function readFromCache(filename: string): string {
    return readFileSync(getCachePath(filename), "utf-8");
}

function writeToCache(filename: string, content: string): void {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(getCachePath(filename), content, "utf-8");
    } catch {
        // Cache write failure is non-fatal
    }
}

// ─── GITHUB FETCHER ───────────────────────────────────────────────────────────

async function fetchSpecFromGitHub(filename: string): Promise<string> {
    const url = `${RC_OPENAPI_REPO}/${filename}`;

    const headers: Record<string, string> = {
        "Accept": "application/vnd.github.raw+json",
        "User-Agent": "gemini-rocketchat-mcp-generator",
    };

    // Use PAT if provided — avoids rate limits (60 req/hr unauthenticated vs 5000/hr with PAT)
    const pat = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
    if (pat) {
        headers["Authorization"] = `Bearer ${pat}`;
    }

    const response = await fetch(url, { headers });

    if (response.status === 403) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        const reset = response.headers.get("x-ratelimit-reset");
        const resetTime = reset
            ? new Date(parseInt(reset) * 1000).toLocaleTimeString()
            : "unknown";
        throw new Error(
            `GitHub rate limit hit. Remaining: ${remaining ?? "0"}. ` +
            `Resets at: ${resetTime}. ` +
            `Set GITHUB_PAT env var to avoid rate limits.`
        );
    }

    if (response.status === 401) {
        throw new Error("GitHub PAT is invalid or expired. Check your GITHUB_PAT env var.");
    }

    if (!response.ok) {
        throw new Error(`GitHub fetch failed for ${filename}: HTTP ${response.status}`);
    }

    return response.text();
}

// ─── SPEC LOADER ──────────────────────────────────────────────────────────────

async function loadSpecContent(filename: string): Promise<string> {
    const forceLocal = process.env.FORCE_LOCAL_SPECS === "true";

    // 1. Force local mode
    if (forceLocal) {
        return readFileSync(join(SPECS_DIR, filename), "utf-8");
    }

    // 2. Valid cache exists — use it
    if (isCacheValid(filename)) {
        return readFromCache(filename);
    }

    // 3. Try GitHub (with PAT if available)
    try {
        const content = await fetchSpecFromGitHub(filename);
        writeToCache(filename, content); // cache for next time
        return content;
    } catch (githubError: any) {
        const isRateLimit = githubError.message?.includes("rate limit");

        // 4. Rate limited — try stale cache before falling back to bundled
        if (isRateLimit && existsSync(getCachePath(filename))) {
            console.error(`[specs] Rate limited — using stale cache for ${filename}`);
            return readFromCache(filename);
        }

        // 5. Any other error — fall back to bundled local spec
        console.error(`[specs] GitHub fetch failed for ${filename}, using local: ${githubError.message}`);
        return readFileSync(join(SPECS_DIR, filename), "utf-8");
    }
}

async function loadAllSpecs(): Promise<Record<string, any>> {
    const allPaths: Record<string, any> = {};

    // Load all spec files in parallel for speed
    const results = await Promise.allSettled(
        SPEC_FILES.map(async (file) => {
            const content = await loadSpecContent(file);
            return { file, content };
        })
    );

    for (const result of results) {
        if (result.status === "rejected") {
            console.error(`[specs] Failed to load a spec file:`, result.reason);
            continue;
        }

        const { file, content } = result.value;

        let parsed: any;
        try {
            // First parse the YAML
            const rawParsed = yaml.load(content) as any;

            // Then fully dereference all $refs — this resolves nested schema
            // references, shared component definitions, and complex allOf/oneOf/anyOf
            // that our manual resolver missed
            parsed = await SwaggerParser.dereference(rawParsed as any);
        } catch (e) {
            console.error(`[specs] Failed to parse/dereference ${file}:`, e);
            continue;
        }

        if (!parsed?.paths) continue;

        for (const [path, methods] of Object.entries(parsed.paths) as any) {
            for (const [method, operation] of Object.entries(methods) as any) {
                if (!operation?.operationId) continue;

                allPaths[operation.operationId] = {
                    // Lightweight summary — always loaded
                    operationId: operation.operationId,
                    summary: operation.summary || "",
                    httpMethod: method.toUpperCase(),
                    httpPath: path,
                    sourceFile: file,
                    tags: operation.tags || [],

                    // Heavy data — deferred until resolveApis is called
                    _rawParameters: operation.parameters || [],
                    _rawRequestBody: operation.requestBody || null,
                    _components: parsed.components?.parameters || {},
                };
            }
        }
    }

    return allPaths;
}

// ─── RESOLVE $REF PARAMETERS ─────────────────────────────────────────────────
// Auth headers (X-Auth-Token, X-User-Id) are filtered out —
// they are always injected from env vars, never exposed as MCP tool inputs

const AUTH_PARAMS = new Set(["X-Auth-Token", "X-User-Id"]);

function resolveParameters(params: any[], componentParams: Record<string, any>): any[] {
    return params
        .map(p => {
            if (p.$ref) {
                const refName = p.$ref.split("/").pop();
                return componentParams[refName] || null;
            }
            return p;
        })
        .filter(p => p !== null)
        .filter(p => !AUTH_PARAMS.has(p.name)); // strip auth headers
}

// ─── EXTRACT PARAMETERS FROM REQUEST BODY ────────────────────────────────────

function extractBodyParameters(requestBody: any): RCParameter[] {
    if (!requestBody?.content?.["application/json"]?.schema) return [];

    const schema = requestBody.content["application/json"].schema;

    // Handle oneOf schemas (e.g. chat.postMessage, dm.create)
    // We take the first variant as the primary schema
    const activeSchema = schema.oneOf ? schema.oneOf[0] : schema;

    if (!activeSchema?.properties) return [];

    const required: string[] = activeSchema.required || [];
    const params: RCParameter[] = [];

    for (const [name, prop] of Object.entries(activeSchema.properties) as any) {
        // Skip nested objects that are wrappers (like the "message" wrapper in chat.sendMessage)
        // Instead, flatten their children
        if (prop.type === "object" && prop.properties && required.includes(name)) {
            const nestedRequired: string[] = prop.required || [];
            for (const [nestedName, nestedProp] of Object.entries(prop.properties) as any) {
                params.push({
                    name: nestedName,
                    type: inferType(nestedProp),
                    required: nestedRequired.includes(nestedName),
                    description: nestedProp.description || `${nestedName} field`,
                    in: "body",
                });
            }
        } else {
            params.push({
                name,
                type: inferType(prop),
                required: required.includes(name),
                description: prop.description || `${name} field`,
                in: "body",
            });
        }
    }

    return params;
}

// ─── EXTRACT QUERY/PATH PARAMETERS ───────────────────────────────────────────

function extractQueryParameters(params: any[]): RCParameter[] {
    return params
        .filter(p => p.in === "query" || p.in === "path")
        .map(p => ({
            name: p.name,
            type: inferType(p.schema || {}),
            required: p.required === true,
            description: p.description || `${p.name} parameter`,
            in: p.in as "query" | "path",
        }));
}

// ─── TYPE INFERENCE ───────────────────────────────────────────────────────────

function inferType(schema: any): "string" | "number" | "boolean" | "array" | "object" {
    if (!schema?.type) return "string";
    switch (schema.type) {
        case "integer":
        case "number": return "number";
        case "boolean": return "boolean";
        case "array": return "array";
        case "object": return "object";
        default: return "string";
    }
}

// ─── FRIENDLY NAME DERIVATION ─────────────────────────────────────────────────
// "post-api-v1-chat.sendMessage" → "sendMessage"
// "get-api-v1-chat.getMessage"  → "getMessage"

function deriveFriendlyName(operationId: string): string {
    const parts = operationId.split(".");
    if (parts.length >= 2) {
        return parts[parts.length - 1];
    }
    // fallback: strip method prefix and path
    return operationId.replace(/^(get|post|put|delete|patch)-api-v\d+-/, "");
}

// ─── FUZZY MATCH ──────────────────────────────────────────────────────────────
// Allows "sendMessage", "chat.sendMessage", or "post-api-v1-chat.sendMessage"
// to all resolve to the same endpoint

function fuzzyMatch(requested: string, index: Record<string, any>): any | null {
    const lower = requested.toLowerCase().trim();

    // 0. Direct httpPath match — most reliable for dot-notation names
    // "channels.invite" → "/api/v1/channels.invite"
    for (const entry of Object.values(index)) {
        if (entry.httpPath === `/api/v1/${lower}`) {
            return entry;
        }
    }

    // 1. Exact operationId match
    if (index[requested]) return index[requested];

    // 2. Exact friendly name match
    for (const entry of Object.values(index)) {
        if (deriveFriendlyName(entry.operationId).toLowerCase() === lower) {
            return entry;
        }
    }

    // 3. Partial operationId match
    for (const entry of Object.values(index)) {
        if (entry.operationId.toLowerCase().includes(lower)) {
            return entry;
        }
    }

    // 4. Summary keyword match
    for (const entry of Object.values(index)) {
        if (entry.summary.toLowerCase().includes(lower)) {
            return entry;
        }
    }

    // 5. HTTP path segment match
    // "deleteMessage" → matches "/api/v1/chat.delete" because path contains "delete"
    // "channelHistory" → matches "/api/v1/channels.history"
    const pathKeyword = lower
        .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → "delete Message"
        .toLowerCase()
        .split(" ")
        .filter(w => w.length > 3); // ignore short words like "get", "the"

    for (const entry of Object.values(index)) {
        const pathLower = entry.httpPath.toLowerCase();
        if (pathKeyword.every((word: string) => pathLower.includes(word))) {
            return entry;
        }
    }

    // 6. Dot-notation path match
    // "chat.delete" → matches operationId "post-api-v1-chat.delete"
    if (lower.includes(".")) {
        for (const entry of Object.values(index)) {
            if (entry.operationId.toLowerCase().includes(lower)) {
                return entry;
            }
            // Also match against HTTP path: "chat.delete" → "/api/v1/chat.delete"
            if (entry.httpPath.toLowerCase().includes(lower.replace(".", "."))) {
                return entry;
            }
        }
    }

    return null;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

let _index: Record<string, any> | null = null;
let _loading = false;

export async function initializeIndex(): Promise<void> {
    if (_index) return;
    if (_loading) {
        while (_loading) await new Promise(r => setTimeout(r, 50));
        return;
    }
    _loading = true;
    try {
        _index = await loadAllSpecs();
    } finally {
        _loading = false;
    }
}

function getIndex(): Record<string, any> {
    if (!_index) throw new Error("Spec index not initialized. Call initializeIndex() first.");
    return _index;
}


// ─── KEYWORD INDEX ────────────────────────────────────────────────────────────
// Built once at startup, used to narrow candidates before LLM reasoning

interface KeywordIndex {
    keywords: Record<string, string[]>; // keyword → list of operationIds
    categories: Record<string, string[]>; // category → list of operationIds
}

let _keywordIndex: KeywordIndex | null = null;

function buildKeywordIndex(): KeywordIndex {
    const index = getIndex();
    const keywords: Record<string, string[]> = {};
    const categories: Record<string, string[]> = {};

    for (const entry of Object.values(index) as any) {
        const category = entry.sourceFile.replace(".yaml", "").replace(/-/g, " ");
        const tagsText = (entry.tags || []).join(" ");
        const descSnippet = (entry.description || "").slice(0, 200); // first 200 chars
        const text = `${entry.summary} ${entry.description ? descSnippet : ""} ${entry.httpPath} ${entry.operationId} ${category} ${tagsText}`.toLowerCase();

        // Extract meaningful words (ignore short/common words)
        const stopWords = new Set(["the", "a", "an", "to", "of", "in", "for",
            "and", "or", "by", "get", "set", "api", "v1", "with", "from"]);

        const words = text
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 3 && !stopWords.has(w));

        for (const word of words) {
            if (!keywords[word]) keywords[word] = [];
            if (!keywords[word].includes(entry.operationId)) {
                keywords[word].push(entry.operationId);
            }
        }

        // Index by category
        const cat = entry.sourceFile.replace(".yaml", "");
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(entry.operationId);
    }

    return { keywords, categories };
}

function getKeywordIndex(): KeywordIndex {
    if (!_keywordIndex) _keywordIndex = buildKeywordIndex();
    return _keywordIndex;
}

// ─── SYNONYM MAP ──────────────────────────────────────────────────────────────
// Ensures conceptually equivalent terms always cross-match

const SYNONYMS: Record<string, string[]> = {
    "auth": ["authentication", "login", "logout", "token", "oauth", "sso", "session", "2fa", "totp"],
    "authentication": ["auth", "login", "logout", "token", "oauth", "sso", "session"],
    "login": ["auth", "authentication", "signin", "sign"],
    "logout": ["auth", "authentication", "signout"],
    "message": ["messaging", "chat", "send", "post", "reply"],
    "messaging": ["message", "chat", "send", "post", "reply"],
    "channel": ["room", "group"],
    "room": ["channel", "group"],
    "user": ["member", "profile", "account"],
    "notification": ["push", "alert", "subscribe"],
    "integration": ["webhook", "trigger"],
    "livechat": ["omnichannel", "visitor", "agent"],
    "omnichannel": ["livechat", "visitor", "agent"],
    "setting": ["config", "preference", "workspace"],
    "statistic": ["statistics", "stats", "metrics"],
    "statistics": ["statistic", "stats", "metrics"],
};

export function findCandidateApis(requirement: string): {
    candidates: ReturnType<typeof listAllApis>;
    matchedKeywords: string[];
    coverage: number;
    tagGroups: Record<string, {
        endpoints: ReturnType<typeof listAllApis>;
        totalInTag: number;
    }>;
} {
    const kwIndex = getKeywordIndex();
    const index = getIndex();

    // Extract keywords from the requirement itself
    const stopWords = new Set(["the", "a", "an", "to", "of", "in", "for",
        "and", "or", "by", "i", "we", "my", "want", "need", "build",
        "create", "make", "that", "this", "with", "from", "can", "will",
        "should", "when", "then", "also", "just", "some", "have"]);

    const reqWords = requirement
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));

    // Expand with synonyms so e.g. "authentication" also searches "login", "token", etc.
    const expandedWords = new Set(reqWords);
    for (const word of reqWords) {
        if (SYNONYMS[word]) {
            for (const syn of SYNONYMS[word]) expandedWords.add(syn);
        }
        // Also check if any synonym key is a substring match
        for (const [key, syns] of Object.entries(SYNONYMS)) {
            if (word.includes(key) || key.includes(word)) {
                for (const syn of syns) expandedWords.add(syn);
                expandedWords.add(key);
            }
        }
    }

    // Score each API by how many requirement keywords it matches
    const scores: Record<string, number> = {};

    for (const word of expandedWords) {
        // Exact keyword match
        if (kwIndex.keywords[word]) {
            for (const opId of kwIndex.keywords[word]) {
                scores[opId] = (scores[opId] || 0) + 2; // exact match = 2 points
            }
        }

        // Partial keyword match
        for (const [indexed, opIds] of Object.entries(kwIndex.keywords)) {
            if (indexed.includes(word) || word.includes(indexed)) {
                for (const opId of opIds) {
                    scores[opId] = (scores[opId] || 0) + 1; // partial = 1 point
                }
            }
        }
    }

    // Sort by score, take top 20
    const topIds = Object.entries(scores)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([id]) => id);

    const allApis = listAllApis();
    const candidates = allApis.filter(a => topIds.includes(a.operationId));

    // Calculate what % of requirement keywords found matches
    const matchedKeywords = [...expandedWords].filter(w =>
        kwIndex.keywords[w] || Object.keys(kwIndex.keywords).some(k => k.includes(w))
    );

    // Group candidates by tag for structured output
    const tagGroups: Record<string, {
        endpoints: typeof candidates;
        totalInTag: number;
    }> = {};

    for (const candidate of candidates) {
        const entry = (index as any)[candidate.operationId];
        const tags: string[] = entry?.tags?.length > 0
            ? entry.tags
            : [candidate.sourceFile.replace(".yaml", "")];

        for (const tag of tags) {
            if (!tagGroups[tag]) {
                // Count total endpoints in this tag across the full index
                const totalInTag = Object.values(index).filter((e: any) =>
                    (e.tags?.length > 0 ? e.tags : [e.sourceFile.replace(".yaml", "")])
                        .includes(tag)
                ).length;

                tagGroups[tag] = { endpoints: [], totalInTag };
            }
            // Avoid duplicates within a tag group
            if (!tagGroups[tag].endpoints.find(e => e.operationId === candidate.operationId)) {
                tagGroups[tag].endpoints.push(candidate);
            }
        }
    }

    return {
        candidates,
        matchedKeywords,
        coverage: reqWords.length > 0
            ? Math.round((matchedKeywords.length / reqWords.length) * 100)
            : 0,
        tagGroups,
    };
}



export function listAllApis(): Array<{ operationId: string; friendlyName: string; summary: string; httpMethod: string; httpPath: string; sourceFile: string; category: string }> {
    const index = getIndex();
    return Object.values(index).map(entry => ({
        operationId: entry.operationId,
        friendlyName: deriveFriendlyName(entry.operationId),
        summary: entry.summary,
        httpMethod: entry.httpMethod,
        httpPath: entry.httpPath,
        sourceFile: entry.sourceFile,
        category: entry.sourceFile
            .replace(".yaml", "")
            .replace(/-/g, " ")
            .toLowerCase(),
    }));
}

export function resolveApis(requested: string[]): {
    resolved: RCEndpoint[];
    notFound: string[];
} {
    const index = getIndex();
    const resolved: RCEndpoint[] = [];
    const notFound: string[] = [];

    // Apply API preferences before resolving
    const API_PREFERENCES: Record<string, string> = {
        "sendMessage": "postMessage",
        "chat.sendMessage": "postMessage",
        "post-api-v1-chat.sendMessage": "postMessage",
    };

    for (const name of requested) {
        const preferredName = API_PREFERENCES[name] || name;
        const match = fuzzyMatch(preferredName, index);
        if (!match) {
            notFound.push(name);
            continue;
        }

        // ── Lazy extraction — only runs for selected endpoints ──────────────
        const resolvedParams = resolveParameters(
            match._rawParameters || [],
            match._components || {}
        );
        const queryParams = extractQueryParameters(resolvedParams);
        const bodyParams = extractBodyParameters(match._rawRequestBody);
        const allParams = [...queryParams, ...bodyParams];
        // ────────────────────────────────────────────────────────────────────

        resolved.push({
            operationId: match.operationId,
            friendlyName: deriveFriendlyName(match.operationId),
            summary: match.summary,
            httpMethod: match.httpMethod,
            httpPath: match.httpPath,
            parameters: allParams,
            sourceFile: match.sourceFile,
        });
    }

    return { resolved, notFound };
}

// ─── TAG-BASED BROWSING ───────────────────────────────────────────────────────

export interface TagSummary {
    tag: string;
    sourceFile: string;
    endpointCount: number;
    description: string;
    sampleEndpoints: string[]; // first 3 endpoint summaries
}

export interface TagDetail {
    tag: string;
    endpoints: Array<{
        operationId: string;
        friendlyName: string;
        summary: string;
        httpMethod: string;
        httpPath: string;
    }>;
}

export function getTagSummaries(): TagSummary[] {
    const index = getIndex();
    const tagMap: Record<string, {
        sourceFile: string;
        endpoints: any[];
    }> = {};

    for (const entry of Object.values(index) as any) {
        const tags: string[] = entry.tags || [entry.sourceFile.replace(".yaml", "")];
        for (const tag of tags) {
            if (!tagMap[tag]) {
                tagMap[tag] = { sourceFile: entry.sourceFile, endpoints: [] };
            }
            tagMap[tag].endpoints.push(entry);
        }
    }

    return Object.entries(tagMap)
        .map(([tag, data]) => ({
            tag,
            sourceFile: data.sourceFile,
            endpointCount: data.endpoints.length,
            description: `${data.endpoints.length} endpoints in ${data.sourceFile.replace(".yaml", "")}`,
            sampleEndpoints: data.endpoints
                .slice(0, 3)
                .map((e: any) => e.summary),
        }))
        .sort((a, b) => b.endpointCount - a.endpointCount);
}

export function getTagDetail(tagName: string): TagDetail | null {
    const index = getIndex();
    const endpoints: TagDetail["endpoints"] = [];

    for (const entry of Object.values(index) as any) {
        const tags: string[] = entry.tags ||
            [entry.sourceFile.replace(".yaml", "")];

        const matches = tags.some(t =>
            t.toLowerCase() === tagName.toLowerCase() ||
            t.toLowerCase().includes(tagName.toLowerCase())
        );

        if (matches) {
            endpoints.push({
                operationId: entry.operationId,
                friendlyName: deriveFriendlyName(entry.operationId),
                summary: entry.summary,
                httpMethod: entry.httpMethod,
                httpPath: entry.httpPath,
            });
        }
    }

    if (endpoints.length === 0) return null;

    return { tag: tagName, endpoints };
}