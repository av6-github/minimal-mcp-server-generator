import type { RCEndpoint, RCParameter } from "./types.js";
import { rcAdapter } from "./rcAdapter.js";
import BM25 from "wink-bm25-text-search";

// ─── SPEC LOADER (via platform adapter) ───────────────────────────────────────

async function loadAllSpecs(): Promise<Record<string, any>> {
    const allPaths: Record<string, any> = {};

    // Load specs via platform adapter
    const allSpecs = await rcAdapter.loadSpec();

    for (const { file, spec: parsed } of allSpecs) {
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


// ─── BM25 INDEX ───────────────────────────────────────────────────────────────
// Replaces keyword + synonym scoring with BM25F for relevance-ranked search



let _bm25: any = null;

function buildBM25Index(): any {
    const index = getIndex();
    const engine = BM25();

    engine.defineConfig({
        fldWeights: {
            operationId: 2,
            summary: 3,
            httpPath: 2,
            tags: 1,
        }
    });

    engine.definePrepTasks([
        (text: string) => text.toLowerCase(),
        (text: string) => text.replace(/[^a-z0-9\s]/g, " "),
        (text: string) => text.split(/\s+/),
    ]);

    for (const entry of Object.values(index) as any[]) {
        engine.addDoc({
            operationId: entry.operationId,
            summary: entry.summary || "",
            httpPath: entry.httpPath,
            tags: (entry.tags || []).join(" "),
        }, entry.operationId);
    }

    engine.consolidate();
    return engine;
}

function getBM25(): any {
    if (!_bm25) _bm25 = buildBM25Index();
    return _bm25;
}

export function findCandidateApis(requirement: string): {
    candidates: ReturnType<typeof listAllApis>;
    matchedKeywords: string[];
    coverage: number;
    tagGroups: Record<string, {
        endpoints: ReturnType<typeof listAllApis>;
        totalInTag: number;
    }>;
} {
    const index = getIndex();
    const allApis = listAllApis();
    const bm25 = getBM25();

    // BM25 search — returns [[operationId, score], ...]
    const results = bm25.search(requirement, 20);

    const candidates = results
        .map((r: any) => allApis.find(a => a.operationId === r[0]))
        .filter(Boolean) as ReturnType<typeof listAllApis>;

    // Platform-agnostic subsystem penalty — re-rank to demote specialist subsystems
    const totalCount = allApis.length;
    const sourceFileCounts: Record<string, number> = {};
    for (const api of allApis) {
        sourceFileCounts[api.sourceFile] = (sourceFileCounts[api.sourceFile] || 0) + 1;
    }

    const reqLower = requirement.toLowerCase();
    const penalized = candidates.filter(api => {
        const fileCount = sourceFileCounts[api.sourceFile] || 0;
        const isSpecialistSubsystem = (fileCount / totalCount) < 0.05;

        if (isSpecialistSubsystem) {
            const subsystemName = api.sourceFile
                .replace(".yaml", "")
                .replace(".json", "")
                .toLowerCase();
            return reqLower.includes(subsystemName);
        }
        return true;
    });

    // If penalty removed too many, keep original BM25 results
    const finalCandidates = penalized.length >= 3 ? penalized : candidates;

    // Extract matched keywords for coverage reporting
    const reqWords = requirement
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 3);

    const candidateText = finalCandidates
        .map(c => `${c.operationId} ${c.summary} ${c.sourceFile}`)
        .join(" ")
        .toLowerCase();

    const matchedKeywords = reqWords.filter(w => candidateText.includes(w));

    // Group candidates by tag for structured output
    const tagGroups: Record<string, {
        endpoints: typeof finalCandidates;
        totalInTag: number;
    }> = {};

    for (const candidate of finalCandidates) {
        const entry = (index as any)[candidate.operationId];
        const tags: string[] = entry?.tags?.length > 0
            ? entry.tags
            : [candidate.sourceFile.replace(".yaml", "")];

        for (const tag of tags) {
            if (!tagGroups[tag]) {
                const totalInTag = Object.values(index).filter((e: any) =>
                    (e.tags?.length > 0 ? e.tags : [e.sourceFile.replace(".yaml", "")])
                        .includes(tag)
                ).length;
                tagGroups[tag] = { endpoints: [], totalInTag };
            }
            if (!tagGroups[tag].endpoints.find(e => e.operationId === candidate.operationId)) {
                tagGroups[tag].endpoints.push(candidate);
            }
        }
    }

    return {
        candidates: finalCandidates,
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