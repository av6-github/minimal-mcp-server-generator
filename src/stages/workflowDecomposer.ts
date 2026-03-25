import { findCandidateApis } from "./specResolver.js";
import type { RCEndpoint } from "./types.js";

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface WorkflowStep {
    stepNumber: number;
    description: string;
    apiName: string;
    purpose: string;
    iterateOver?: string;   // e.g. "members" — iterate over array from previous step
    filterBy?: string;      // e.g. "keyword" — input name to filter by
    filterField?: string;   // e.g. "username" — field on each item to match against
}

export interface WorkflowTool {
    name: string;
    description: string;
    inputs: Array<{
        name: string;
        type: string;
        required: boolean;
        description: string;
    }>;
    steps: WorkflowStep[];
    resolvedApis: RCEndpoint[];
}

export interface WorkflowDefinition {
    tools: WorkflowTool[];
    source: "template" | "llm";
    templateName?: string;
}

// ─── KNOWN WORKFLOW TEMPLATES ────────────────────────────────────────────────
// Only keep genuinely universal workflows
// Moderation/iteration workflows are handled by LLM decomposition

const WORKFLOW_TEMPLATES: Record<string, WorkflowDefinition> = {
    "onboard": {
        source: "template",
        templateName: "onboard",
        tools: [{
            name: "onboardMember",
            description: "Onboard a new team member — looks up the user, creates or finds the channel, invites them, and sends a welcome message",
            inputs: [
                { name: "username", type: "string", required: true, description: "The username of the new member to onboard" },
                { name: "channelName", type: "string", required: true, description: "The channel to add them to" },
                { name: "welcomeMessage", type: "string", required: false, description: "Optional welcome message. Defaults to a standard welcome." },
            ],
            steps: [
                { stepNumber: 1, description: "Look up user by username", apiName: "users.info", purpose: "Get userId needed for channel invite" },
                { stepNumber: 2, description: "Create channel if it does not exist", apiName: "channels.create", purpose: "Ensure the target channel exists" },
                { stepNumber: 3, description: "Invite user to channel", apiName: "channels.invite", purpose: "Add the user as a channel member" },
                { stepNumber: 4, description: "Send welcome message", apiName: "chat.postMessage", purpose: "Greet the new member in the channel" },
            ],
            resolvedApis: [],
        }],
    },

    "archive": {
        source: "template",
        templateName: "archive",
        tools: [{
            name: "archiveInactiveChannel",
            description: "Archive an inactive channel — checks channel info, notifies members, then archives it",
            inputs: [
                { name: "channelName", type: "string", required: true, description: "The name of the channel to archive" },
                { name: "notifyMessage", type: "string", required: false, description: "Optional message to send before archiving" },
            ],
            steps: [
                { stepNumber: 1, description: "Get channel information", apiName: "channels.info", purpose: "Verify channel exists and get its ID" },
                { stepNumber: 2, description: "Notify channel members", apiName: "chat.postMessage", purpose: "Inform members the channel is being archived" },
                { stepNumber: 3, description: "Archive the channel", apiName: "channels.archive", purpose: "Mark channel as archived" },
            ],
            resolvedApis: [],
        }],
    },

    "broadcast": {
        source: "template",
        templateName: "broadcast",
        tools: [{
            name: "broadcastMessage",
            description: "Broadcast a message to multiple channels at once",
            inputs: [
                { name: "channels", type: "array", required: true, description: "List of channel names to broadcast to" },
                { name: "message", type: "string", required: true, description: "The message to broadcast" },
            ],
            steps: [
                { stepNumber: 1, description: "Send message to each channel", apiName: "chat.postMessage", purpose: "Post the message to all specified channels" },
            ],
            resolvedApis: [],
        }],
    },

    "notify": {
        source: "template",
        templateName: "notify",
        tools: [{
            name: "notifyUser",
            description: "Send a direct message notification to a user",
            inputs: [
                { name: "username", type: "string", required: true, description: "The username to notify" },
                { name: "message", type: "string", required: true, description: "The notification message" },
            ],
            steps: [
                { stepNumber: 1, description: "Open or create DM with user", apiName: "dm.create", purpose: "Get the DM room ID for the user" },
                { stepNumber: 2, description: "Send the notification message", apiName: "chat.postMessage", purpose: "Deliver the notification" },
            ],
            resolvedApis: [],
        }],
    },

    "cleanup": {
        source: "template",
        templateName: "cleanup",
        tools: [{
            name: "cleanupChannel",
            description: "Clean up a channel — delete old messages",
            inputs: [
                { name: "channelName", type: "string", required: true, description: "The channel to clean up" },
                { name: "daysOld", type: "number", required: false, description: "Delete messages older than this many days" },
            ],
            steps: [
                { stepNumber: 1, description: "Get channel info", apiName: "channels.info", purpose: "Get channel ID" },
                { stepNumber: 2, description: "Get channel message history", apiName: "channels.history", purpose: "Find old messages to delete" },
                {
                    stepNumber: 3,
                    description: "Delete old messages",
                    apiName: "chat.delete",
                    purpose: "Remove messages older than threshold",
                    iterateOver: "messages",
                    filterBy: "daysOld",
                    filterField: "_id",
                },
            ],
            resolvedApis: [],
        }],
    },

    "escalate": {
        source: "template",
        templateName: "escalate",
        tools: [{
            name: "escalateMessage",
            description: "Escalate a message to moderators — fetches the original message and forwards it to a moderation channel",
            inputs: [
                { name: "messageId", type: "string", required: true, description: "The ID of the message to escalate" },
                { name: "moderationChannel", type: "string", required: true, description: "The channel to send the escalation to" },
                { name: "reason", type: "string", required: false, description: "Reason for escalation" },
            ],
            steps: [
                { stepNumber: 1, description: "Get original message details", apiName: "chat.getMessage", purpose: "Fetch the content of the problematic message" },
                { stepNumber: 2, description: "Forward to moderation channel", apiName: "chat.postMessage", purpose: "Alert the moderators" },
            ],
            resolvedApis: [],
        }],
    },

    "promote": {
        source: "template",
        templateName: "promote",
        tools: [{
            name: "promoteToModerator",
            description: "Promote a user to channel moderator",
            inputs: [
                { name: "username", type: "string", required: true, description: "The user to promote" },
                { name: "channelName", type: "string", required: true, description: "The channel to promote them in" },
            ],
            steps: [
                { stepNumber: 1, description: "Get user info", apiName: "users.info", purpose: "Get user ID" },
                { stepNumber: 2, description: "Get channel info", apiName: "channels.info", purpose: "Get channel ID" },
                { stepNumber: 3, description: "Assign moderator role", apiName: "channels.addModerator", purpose: "Grant the user moderator privileges in the channel" },
                { stepNumber: 4, description: "Announce promotion", apiName: "chat.postMessage", purpose: "Notify the channel of the new moderator" },
            ],
            resolvedApis: [],
        }],
    },

    "createPrivateTeam": {
        source: "template",
        templateName: "createPrivateTeam",
        tools: [{
            name: "createPrivateTeam",
            description: "Create a private group and invite a lead user",
            inputs: [
                { name: "groupName", type: "string", required: true, description: "Name of the new private group" },
                { name: "leadUsername", type: "string", required: true, description: "Username to invite as lead" },
                { name: "welcomeMessage", type: "string", required: false, description: "Message to send to the group" },
            ],
            steps: [
                { stepNumber: 1, description: "Create private group", apiName: "groups.create", purpose: "Spin up the closed space" },
                { stepNumber: 2, description: "Get user ID", apiName: "users.info", purpose: "Get ID of the lead to invite" },
                { stepNumber: 3, description: "Invite to group", apiName: "groups.invite", purpose: "Add the lead to the private group" },
                { stepNumber: 4, description: "Send welcome", apiName: "chat.postMessage", purpose: "Initialize the group chat" },
            ],
            resolvedApis: [],
        }],
    },

    "rename": {
        source: "template",
        templateName: "rename",
        tools: [{
            name: "renameChannel",
            description: "Rename a channel and announce the change",
            inputs: [
                { name: "channelName", type: "string", required: true, description: "The current channel name" },
                { name: "newName", type: "string", required: true, description: "The new name for the channel" },
            ],
            steps: [
                { stepNumber: 1, description: "Get channel info", apiName: "channels.info", purpose: "Get channel ID" },
                { stepNumber: 2, description: "Rename channel", apiName: "channels.rename", purpose: "Apply the new name" },
                { stepNumber: 3, description: "Announce rename", apiName: "chat.postMessage", purpose: "Notify users that the channel name has changed" },
            ],
            resolvedApis: [],
        }],
    },

    "kick": {
        source: "template",
        templateName: "kick",
        tools: [{
            name: "kickUser",
            description: "Kick a user from a channel and optionally notify the channel",
            inputs: [
                { name: "username", type: "string", required: true, description: "The user to remove" },
                { name: "channelName", type: "string", required: true, description: "The channel to remove them from" },
                { name: "reason", type: "string", required: false, description: "Reason for removal" },
            ],
            steps: [
                { stepNumber: 1, description: "Get user ID", apiName: "users.info", purpose: "Get the target user ID" },
                { stepNumber: 2, description: "Get channel ID", apiName: "channels.info", purpose: "Get the target channel ID" },
                { stepNumber: 3, description: "Kick user", apiName: "channels.kick", purpose: "Remove the user" },
                { stepNumber: 4, description: "Post removal note", apiName: "chat.postMessage", purpose: "Log the removal in the channel" },
            ],
            resolvedApis: [],
        }],
    },
};

// ─── KEYWORD MATCHER ──────────────────────────────────────────────────────────

const TEMPLATE_KEYWORDS: Record<string, string[]> = {
    "onboard": ["onboard", "welcome", "new member", "add member", "join team", "new user", "invite member"],
    "archive": ["archive", "inactive", "close channel", "deactivate", "shut down channel"],
    "broadcast": ["broadcast", "announce", "mass message", "all channels", "multiple channels", "notify all"],
    "notify": ["notify user", "dm user", "direct message", "alert user", "message user", "ping user"],
    "cleanup": ["cleanup", "clean up", "delete old", "purge", "housekeeping", "remove messages"],
    "escalate": ["escalate", "report message", "moderation", "flag message", "forward to admin"],
    "promote": ["promote", "make moderator", "add moderator", "grant moderator", "elevate user"],
    "createPrivateTeam": ["private team", "secret group", "create private", "closed group", "private channel"],
    "rename": ["rename", "change channel name", "update channel name"],
    "kick": ["kick", "remove user", "kick user", "eject", "banish"],
};

function matchTemplate(requirement: string): WorkflowDefinition | null {
    const lower = requirement.toLowerCase();
    for (const [templateKey, keywords] of Object.entries(TEMPLATE_KEYWORDS)) {
        if (keywords.some(k => lower.includes(k))) {
            return WORKFLOW_TEMPLATES[templateKey];
        }
    }
    return null;
}

// ─── LLM DECOMPOSITION ────────────────────────────────────────────────────────

export async function decomposeWorkflow(requirement: string): Promise<{
    definition: WorkflowDefinition;
    tokenCost: number;
}> {
    const templateMatch = matchTemplate(requirement);
    if (templateMatch) {
        return { definition: templateMatch, tokenCost: 0 };
    }

    const { candidates } = findCandidateApis(requirement);
    const estimatedTokenCost = 200 + candidates.length * 15 + 300;

    return {
        definition: { source: "llm", tools: [] },
        tokenCost: estimatedTokenCost,
    };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function matchStepToApi(step: WorkflowStep, resolvedApis: RCEndpoint[]): RCEndpoint | undefined {
    const apiLower = step.apiName.toLowerCase();
    return resolvedApis.find(r =>
        r.httpPath.endsWith(step.apiName) ||
        r.httpPath.includes(`/${step.apiName}`) ||
        r.operationId.toLowerCase().endsWith(apiLower) ||
        r.operationId.toLowerCase().includes(apiLower)
    );
}
// ─── WORKFLOW CODE GENERATOR ──────────────────────────────────────────────────
export function generateWorkflowToolCode(tool: WorkflowTool): string {
    console.error(`[codegen] Generating ${tool.name} — resolved APIs: ${tool.resolvedApis.map(a => a.operationId).join(", ") || "NONE — steps will not resolve"}`);
    const zodParams = tool.inputs
        .map(i => {
            let field = i.type === "number" ? "z.number()"
                : i.type === "boolean" ? "z.boolean()"
                    : i.type === "array" ? "z.array(z.string())"
                        : "z.string()";
            field += `.describe("${i.description.replace(/"/g, '\\"')}")`;
            if (!i.required) field += ".optional()";
            return `    ${i.name}: ${field}`;
        })
        .join(",\n");

    const argsList = tool.inputs.map(i => i.name).join(", ");

    // Build api parameter name lists for each step — used by buildParams at runtime
    const stepApiParams = tool.steps.map(step => {
        const api = matchStepToApi(step, tool.resolvedApis);
        if (!api) return `[]`;
        const paramNames = api.parameters
            .filter(p => p.in === "body" || p.in === "query")
            .map(p => `"${p.name}"`)
            .join(", ");
        return `[${paramNames}]`;
    });

    const stepImplementations = tool.steps.map((step, index) => {
        const api = matchStepToApi(step, tool.resolvedApis);

        if (!api) {
            return `    // Step ${step.stepNumber}: ${step.description} (${step.apiName} — not resolved)`;
        }

        // ── Iterative step ────────────────────────────────────────────────────
        if (step.iterateOver) {
            const prevStep = step.stepNumber - 1;
            const arrayField = step.iterateOver;
            const filterInput = step.filterBy || "keyword";
            const filterField = step.filterField || "_id";

            return `
    // Step ${step.stepNumber}: ${step.description}
    const _${arrayField} = _results[${prevStep}]?.${arrayField} || [];
    const _matching = _${arrayField}.filter((item: any) => {
        const val = item.${filterField};
        if (typeof val !== "string") return false;
        return val.toLowerCase().includes(String(_inputs.${filterInput} ?? "").toLowerCase());
    });

    if (_matching.length === 0) {
        return {
            content: [{ type: "text" as const, text: JSON.stringify({
                success: true,
                message: \`No items found matching "\${_inputs.${filterInput}}"\`,
                checked: _${arrayField}.length,
            }, null, 2) }],
        };
    }

    const _succeeded: string[] = [];
    const _failed: string[] = [];

    for (const _item of _matching) {
        const _iterResult = await _rc("${api.httpPath}", "${api.httpMethod}",
            buildParams(_results, ${step.stepNumber}, _stepApiParams[${index}], _inputs, _item)
        );
        if (_iterResult.success !== false && !_iterResult.error) {
            _succeeded.push(_item.${filterField});
        } else {
            _failed.push(_item.${filterField});
        }
    }

    _results[${step.stepNumber}] = {
        success: true,
        checked: _${arrayField}.length,
        matched: _matching.length,
        succeeded: _succeeded,
        failed: _failed,
    };`;
        }

        // ── Standard step ─────────────────────────────────────────────────────
        const isCreateStep = api.httpPath.includes(".create") || step.apiName.includes(".create");
        const errorHandling = isCreateStep
            ? `
    if (_results[${step.stepNumber}].error && _results[${step.stepNumber}].errorType !== "error-duplicate-channel-name") {
        return { content: [{ type: "text" as const, text: \`Step ${step.stepNumber} failed: \${_results[${step.stepNumber}].error}\` }], isError: true };
    }
    if (_results[${step.stepNumber}].errorType === "error-duplicate-channel-name") {
        const _roomNameInput = Object.entries(_inputs).find(([k]) =>
            k.toLowerCase().includes("channel") ||
            k.toLowerCase().includes("room") ||
            k.toLowerCase().includes("group")
        );
        if (_roomNameInput) {
            _results[${step.stepNumber}] = await _rc("/api/v1/channels.info", "GET", { roomName: _roomNameInput[1] });
            if (_results[${step.stepNumber}].error) {
                return { content: [{ type: "text" as const, text: \`Step ${step.stepNumber} failed: could not find or create channel — \${_results[${step.stepNumber}].error}\` }], isError: true };
            }
        }
    }`
            : `
    if (_results[${step.stepNumber}].error) {
        return { content: [{ type: "text" as const, text: \`Step ${step.stepNumber} failed: \${_results[${step.stepNumber}].error}\` }], isError: true };
    }`;

        return `
    // Step ${step.stepNumber}: ${step.description}
    // Purpose: ${step.purpose}
    _results[${step.stepNumber}] = await _rc(
        "${api.httpPath}",
        "${api.httpMethod}",
        buildParams(_results, ${step.stepNumber}, _stepApiParams[${index}], _inputs)
    );${errorHandling}`;

    }).join("\n");

    const inputsObj = tool.inputs
        .map(i => {
            if (!i.required && i.type === "string") {
                return `        ${i.name}: ${i.name} ?? ""`;
            }
            return `        ${i.name}: ${i.name}`;
        })
        .join(",\n");

    const stepApiParamsArray = `[${stepApiParams.join(", ")}]`;
    const lastStep = tool.steps[tool.steps.length - 1];

    return `
// ── Workflow Tool: ${tool.name} ${"─".repeat(Math.max(0, 45 - tool.name.length))}
server.tool(
  "${tool.name}",
  "${tool.description.replace(/"/g, '\\"')}",
  {
${zodParams}
  },
  async ({ ${argsList} }) => {
    const _results: Record<number, any> = {};

    const _inputs: Record<string, any> = {
${inputsObj}
    };

    const _stepApiParams: string[][] = ${stepApiParamsArray};

    function buildParams(
        results: Record<number, any>,
        currentStep: number,
        apiParams: string[],
        inputs: Record<string, any>,
        iterItem?: any
    ): Record<string, any> {
        const p: Record<string, any> = {};

        // Search from most recent step backwards to handle multi-room workflows
        const allResults = Object.values(results).reverse();

        const roomResult = allResults.find((r: any) => 
            r?.channel?._id || r?.group?._id || r?.room?._id || r?.room?.rid
        );
        const resolvedRoomId = 
            roomResult?.channel?._id || 
            roomResult?.group?._id || 
            roomResult?.room?._id || 
            roomResult?.room?.rid;

        const resolvedUserId =
            allResults.find((r: any) => r?.user?._id)?.user?._id;

        const resolvedMessageId =
            allResults.find((r: any) => r?.message?._id)?.message?._id;

        for (const paramName of apiParams) {
            const n = paramName.toLowerCase();

            if (iterItem) {
                if (n === "mid" || n === "messageid" || n === "message_id") {
                    p[paramName] = iterItem._id;
                    continue;
                }
                if (n === "userid" || n === "user_id") {
                    p[paramName] = iterItem.u?._id || iterItem._id;
                    continue;
                }
            }

            if (n === "roomid" || n === "rid" || n === "room_id") {
                if (resolvedRoomId) {
                    p[paramName] = resolvedRoomId;
                } else {
                    const roomInput = Object.entries(inputs).find(([k]) =>
                        (k.toLowerCase().includes("room") ||
                        k.toLowerCase().includes("channel") ||
                        k.toLowerCase().includes("group")) &&
                        (k.toLowerCase().includes("id") || k.toLowerCase() === "rid")
                    );
                    if (roomInput) p[paramName] = roomInput[1];
                }
                continue;
            }

            if (n === "roomname" || n === "room_name") {
                const nameInput = Object.entries(inputs).find(([k]) =>
                    k.toLowerCase().includes("room") ||
                    k.toLowerCase().includes("channel") ||
                    k.toLowerCase().includes("group")
                );
                if (nameInput) p[paramName] = nameInput[1];
                continue;
            }

            if (n === "userid" || n === "user_id") {
                if (resolvedUserId && currentStep > 1) {
                    p[paramName] = resolvedUserId;
                } else if (!resolvedUserId) {
                    // No userId resolved yet — pass username as alternative identifier
                    // Many RC APIs (users.info, users.getPresence) accept username OR userId
                    const usernameInput = Object.entries(inputs).find(([k]) =>
                        k.toLowerCase() === "username" ||
                        k.toLowerCase().includes("user")
                    );
                    if (usernameInput) {
                        p["username"] = usernameInput[1];
                    }
                }
                continue;
            }

            if (n === "username") {
                const usernameInput = Object.entries(inputs).find(([k]) =>
                    k.toLowerCase() === "username" ||
                    k.toLowerCase().includes("user")
                );
                if (usernameInput) {
                    p[paramName] = usernameInput[1];
                }
                continue;
            }

            if (n === "mid" || n === "messageid" || n === "message_id") {
                if (resolvedMessageId) {
                    p[paramName] = resolvedMessageId;
                } else {
                    const msgInput = Object.entries(inputs).find(([k]) =>
                        k.toLowerCase().includes("messageid") ||
                        k.toLowerCase().includes("mid") ||
                        k.toLowerCase().includes("message_id")
                    );
                    if (msgInput) p[paramName] = msgInput[1];
                }
                continue;
            }

            if (n === "text" || n === "msg" || n === "message" || n === "body") {
                const textInput = Object.entries(inputs).find(([k]) =>
                    k.toLowerCase().includes("message") ||
                    k.toLowerCase().includes("text") ||
                    k.toLowerCase().includes("content") ||
                    k.toLowerCase().includes("body") ||
                    k.toLowerCase().includes("reason") ||
                    k.toLowerCase().includes("explanation")
                );
                if (textInput && textInput[1]) {
                    p[paramName] = textInput[1];
                } else {
                    // Auto-generate a contextual default from available inputs
                    const userInput = Object.entries(inputs).find(([k]) =>
                        k.toLowerCase().includes("user")
                    );
                    const channelInput = Object.entries(inputs).find(([k]) =>
                        k.toLowerCase().includes("channel") ||
                        k.toLowerCase().includes("room")
                    );
                    const parts: string[] = [];
                    if (userInput?.[1]) parts.push("@" + userInput[1]);
                    if (channelInput?.[1]) parts.push("in #" + channelInput[1]);
                    p[paramName] = parts.length > 0
                        ? "Welcome " + parts.join(" ") + "!"
                        : "Hello!";
                }
                continue;
            }

            if (n === "name") {
                const nameInput = Object.entries(inputs).find(([k]) =>
                    k.toLowerCase().includes("name") &&
                    !k.toLowerCase().includes("user")
                );
                if (nameInput) p[paramName] = nameInput[1];
                continue;
            }

            const directMatch = Object.entries(inputs).find(([k]) =>
                k.toLowerCase() === n
            );
            if (directMatch) {
                p[paramName] = directMatch[1];
            }
        }

        return p;
    }

    ${stepImplementations}

    return {
        content: [{ type: "text" as const, text: JSON.stringify({
            success: true,
            workflow: "${tool.name}",
            steps: ${tool.steps.length},
            result: _results[${lastStep?.stepNumber || 1}],
        }, null, 2) }],
    };
  }
);`;
}

// ─── RC CLIENT TEMPLATE ───────────────────────────────────────────────────────

export const RC_CLIENT_TEMPLATE = `
const RC_URL = process.env.RC_URL!;
const RC_AUTH_TOKEN = process.env.RC_AUTH_TOKEN!;
const RC_USER_ID = process.env.RC_USER_ID!;

export async function _rc(
  path: string,
  method: string,
  params: Record<string, any> = {}
): Promise<any> {
  const isGet = method === "GET";

  // Substitute path parameters like {rid}, {roomId}, {_id} before building URL
  let resolvedPath = path;
  const remainingParams = { ...params };
  for (const [key, value] of Object.entries(params)) {
    if (resolvedPath.includes(\`{\${key}}\`)) {
      resolvedPath = resolvedPath.replace(\`{\${key}}\`, String(value));
      delete remainingParams[key];
    }
  }

  const url = isGet
    ? \`\${RC_URL}\${resolvedPath}?\${new URLSearchParams(remainingParams).toString()}\`
    : \`\${RC_URL}\${resolvedPath}\`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": RC_AUTH_TOKEN,
      "X-User-Id": RC_USER_ID,
    },
    ...(isGet ? {} : { body: JSON.stringify(remainingParams) }),
  });

  return res.json();
}
`;