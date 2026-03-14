import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import type { RCEndpoint, RCParameter } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(__dirname, "../specs");

// ─── LOAD AND PARSE ALL YAML SPEC FILES ──────────────────────────────────────

function loadAllSpecs(): Record<string, any> {
    const allPaths: Record<string, any> = {};

    const files = readdirSync(SPECS_DIR).filter(f => f.endsWith(".yaml"));

    for (const file of files) {
        const content = readFileSync(join(SPECS_DIR, file), "utf-8");
        const parsed = yaml.load(content) as any;

        if (!parsed?.paths) continue;

        for (const [path, methods] of Object.entries(parsed.paths) as any) {
            for (const [method, operation] of Object.entries(methods) as any) {
                if (!operation?.operationId) continue;

                // Resolve shared $ref parameters from components
                const resolvedParams = resolveParameters(
                    operation.parameters || [],
                    parsed.components?.parameters || {}
                );

                allPaths[operation.operationId] = {
                    operationId: operation.operationId,
                    summary: operation.summary || "",
                    httpMethod: method.toUpperCase(),
                    httpPath: path,
                    rawParameters: resolvedParams,
                    requestBody: operation.requestBody || null,
                    sourceFile: file,
                    components: parsed.components || {},
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
    const lower = requested.toLowerCase();

    // 1. Exact operationId match
    if (index[requested]) return index[requested];

    // 2. Friendly name match (e.g. "sendMessage")
    for (const entry of Object.values(index)) {
        if (deriveFriendlyName(entry.operationId).toLowerCase() === lower) {
            return entry;
        }
    }

    // 3. Partial operationId match (e.g. "chat.sendMessage")
    for (const entry of Object.values(index)) {
        if (entry.operationId.toLowerCase().includes(lower)) {
            return entry;
        }
    }

    // 4. Summary keyword match (e.g. "send message")
    for (const entry of Object.values(index)) {
        if (entry.summary.toLowerCase().includes(lower)) {
            return entry;
        }
    }

    return null;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

let _index: Record<string, any> | null = null;

function getIndex(): Record<string, any> {
    if (!_index) _index = loadAllSpecs();
    return _index;
}

export function listAllApis(): Array<{ operationId: string; friendlyName: string; summary: string; httpMethod: string; httpPath: string; sourceFile: string }> {
    const index = getIndex();
    return Object.values(index).map(entry => ({
        operationId: entry.operationId,
        friendlyName: deriveFriendlyName(entry.operationId),
        summary: entry.summary,
        httpMethod: entry.httpMethod,
        httpPath: entry.httpPath,
        sourceFile: entry.sourceFile,
    }));
}

export function resolveApis(requested: string[]): {
    resolved: RCEndpoint[];
    notFound: string[];
} {
    const index = getIndex();
    const resolved: RCEndpoint[] = [];
    const notFound: string[] = [];

    for (const name of requested) {
        const match = fuzzyMatch(name, index);
        if (!match) {
            notFound.push(name);
            continue;
        }

        const queryParams = extractQueryParameters(match.rawParameters);
        const bodyParams = extractBodyParameters(match.requestBody);
        const allParams = [...queryParams, ...bodyParams];

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