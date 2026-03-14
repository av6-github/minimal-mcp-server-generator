// The internal representation of a single RC API endpoint
// after parsing from OpenAPI spec and before code generation
export interface RCParameter {
    name: string;
    type: "string" | "number" | "boolean" | "array" | "object";
    required: boolean;
    description: string;
    in: "query" | "body" | "path";
    bodyWrapper?: string; // e.g. "message" for chat.sendMessage

}

export interface RCEndpoint {
    operationId: string;       // e.g. "post-api-v1-chat.sendMessage"
    friendlyName: string;      // e.g. "sendMessage"  
    summary: string;           // e.g. "Send a message to a room"
    httpMethod: string;        // "GET" | "POST"
    httpPath: string;          // "/api/v1/chat.sendMessage"
    parameters: RCParameter[];
    sourceFile: string;        // which yaml file it came from
}

export interface MCPToolSchema {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, {
            type: string;
            description: string;
            items?: { type: string };
        }>;
        required: string[];
    };
    httpMethod: string;
    httpPath: string;
    parameters: RCParameter[];
}

export interface GeneratedFile {
    path: string;
    content: string;
}