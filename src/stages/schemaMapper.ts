import type { RCEndpoint, MCPToolSchema, RCParameter } from "./types.js";

function mapType(param: RCParameter): {
    type: string;
    description: string;
    items?: { type: string };
} {
    const base: any = {
        type: param.type === "number" ? "number"
            : param.type === "boolean" ? "boolean"
                : param.type === "array" ? "array"
                    : "string",
        description: param.description,
    };
    if (param.type === "array") {
        base.items = { type: "string" };
    }
    return base;
}

export function mapToMCPSchema(endpoint: RCEndpoint): MCPToolSchema {
    const properties: MCPToolSchema["inputSchema"]["properties"] = {};
    const required: string[] = [];

    for (const param of endpoint.parameters) {
        properties[param.name] = mapType(param);
        if (param.required) required.push(param.name);
    }

    return {
        name: endpoint.friendlyName,
        description: endpoint.summary,
        inputSchema: {
            type: "object",
            properties,
            required,
        },
        httpMethod: endpoint.httpMethod,
        httpPath: endpoint.httpPath,
        parameters: endpoint.parameters,
    };
}