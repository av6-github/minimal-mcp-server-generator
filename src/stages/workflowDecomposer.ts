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

// ─── SMART PARAMETER MAPPING ──────────────────────────────────────────────────

function buildStepParams(
    step: WorkflowStep,
    inputs: WorkflowTool["inputs"],
    api: RCEndpoint
): string {
    const inputNames = new Set(inputs.map(i => i.name));
    const params: Array<[string, string]> = [];

    for (const param of api.parameters) {
        if (param.in !== "body" && param.in !== "query") continue;

        const n = param.name.toLowerCase();

        // Direct name match — use variable directly
        if (inputNames.has(param.name)) {
            params.push([param.name, param.name]);
            continue;
        }

        // userId
        if (n === "userid" || n === "user_id") {
            if (step.stepNumber > 1) {
                params.push([param.name, "_step1Result.user?._id"]);
            } else if (inputNames.has("username")) {
                params.push([param.name, "username"]);
            }
            continue;
        }

        if (n === "username") {
            if (inputNames.has("username")) params.push([param.name, "username"]);
            continue;
        }

        // messageId
        if (n === "messageid" || n === "msgid") {
            if (inputNames.has("messageId")) params.push([param.name, "messageId"]);
            continue;
        }

        // roomId — use extracted variable after step 1
        if (n === "roomid" || n === "room_id" || n === "rid") {
            if (step.stepNumber > 1) {
                params.push([param.name, "roomId"]);
            } else if (inputNames.has("channelName")) {
                params.push([param.name, "channelName"]);
            } else if (inputNames.has("roomName")) {
                params.push([param.name, "roomName"]);
            }
            continue;
        }

        // roomName — ONLY on step 1, never after
        if (n === "roomname" || n === "room_name") {
            if (step.stepNumber === 1) {
                if (inputNames.has("channelName")) {
                    params.push([param.name, "channelName"]);
                } else if (inputNames.has("roomName")) {
                    params.push([param.name, "roomName"]);
                }
            }
            continue;
        }

        if (n === "name") {
            if (inputNames.has("newName")) {
                params.push([param.name, "newName"]);
            } else if (inputNames.has("groupName")) {
                params.push([param.name, "groupName"]);
            } else if (inputNames.has("channelName")) {
                params.push([param.name, "channelName"]);
            } else if (inputNames.has("roomName")) {
                params.push([param.name, "roomName"]);
            }
            continue;
        }

        if (n === "text" || n === "msg" || n === "message") {
            if (inputNames.has("welcomeMessage")) {
                params.push([param.name, `welcomeMessage ?? "Welcome to the team!"`]);
            } else if (inputNames.has("notifyMessage")) {
                params.push([param.name, `notifyMessage ?? "This channel is being archived."`]);
            } else if (inputNames.has("message")) {
                params.push([param.name, "message"]);
            } else if (inputNames.has("text")) {
                params.push([param.name, "text"]);
            }
            continue;
        }

        if (n === "channel") {
            if (inputNames.has("channelName")) {
                params.push([param.name, "`#${channelName}`"]);
            } else if (inputNames.has("roomName")) {
                params.push([param.name, "`#${roomName}`"]);
            }
            continue;
        }

        if (n === "keyword" && inputNames.has("keyword")) {
            params.push([param.name, "keyword"]);
            continue;
        }

        if (param.required) {
            params.push([param.name, `"" /* TODO: provide ${param.name} */`]);
        }
    }

    if (params.length === 0) return "{}";
    const lines = params.map(([k, v]) => `      ${k}: ${v}`).join(",\n");
    return `{\n${lines}\n    }`;
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

function needsRoomIdExtraction(tool: WorkflowTool): boolean {
    return tool.steps.some(s => {
        if (s.stepNumber <= 1) return false;
        const api = matchStepToApi(s, tool.resolvedApis);
        if (!api) return false;
        return api.parameters.some(p =>
            p.name.toLowerCase() === "roomid" ||
            p.name.toLowerCase() === "rid" ||
            p.name.toLowerCase() === "room_id"
        );
    });
}

// ─── WORKFLOW CODE GENERATOR ──────────────────────────────────────────────────

export function generateWorkflowToolCode(tool: WorkflowTool): string {
    const zodParams = tool.inputs
        .map(i => {
            let field = i.type === "number" ? "z.number()"
                : i.type === "boolean" ? "z.boolean()"
                    : i.type === "array" ? "z.array(z.string())"
                        : "z.string()";
            if (!i.required) field += ".optional()";
            field += `.describe("${i.description.replace(/"/g, '\\"')}")`;
            return `    ${i.name}: ${field}`;
        })
        .join(",\n");

    const argsList = tool.inputs.map(i => i.name).join(", ");
    const extractRoomId = needsRoomIdExtraction(tool);
    const generatedStepNums: number[] = [];

    const stepImplementations = tool.steps.map((step) => {
        const api = matchStepToApi(step, tool.resolvedApis);

        if (!api) {
            return `    // Step ${step.stepNumber}: ${step.description} (${step.apiName} — not resolved)`;
        }

        generatedStepNums.push(step.stepNumber);

        const roomIdLine = (step.stepNumber === 1 && extractRoomId)
            ? `\n    const roomId = _step1Result.channel?._id;`
            : "";

        // ── Iterative step — filter + loop ────────────────────────────────────
        if (step.iterateOver) {
            const prevStep = step.stepNumber - 1;
            const arrayField = step.iterateOver;
            const filterInput = step.filterBy || "keyword";
            const filterField = step.filterField || "username";

            return `
    // Step ${step.stepNumber}: ${step.description}
    // Purpose: ${step.purpose}
    const _${arrayField} = _step${prevStep}Result.${arrayField} || [];
    const _matching = _${arrayField}.filter((item: any) =>
      item.${filterField}?.toLowerCase().includes(${filterInput}.toLowerCase())
    );

    if (_matching.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          success: true,
          message: \`No items found matching "\${${filterInput}}"\`,
          checked: _${arrayField}.length,
          processed: [],
        }, null, 2) }],
      };
    }

    const _succeeded: string[] = [];
    const _failed: string[] = [];

    for (const _item of _matching) {
      const _iterResult = await _rc("${api.httpPath}", "${api.httpMethod}", {
        roomId: roomId,
        userId: _item._id,
      });
      if (_iterResult.success) {
        _succeeded.push(_item.${filterField});
      } else {
        _failed.push(_item.${filterField});
      }
    }

    const _step${step.stepNumber}Result = {
      success: true,
      checked: _${arrayField}.length,
      matched: _matching.length,
      succeeded: _succeeded,
      failed: _failed,
    };`;
        }

        // ── Standard step — single API call ──────────────────────────────────
        const params = buildStepParams(step, tool.inputs, api);

        return `
    // Step ${step.stepNumber}: ${step.description}
    // Purpose: ${step.purpose}
    const _step${step.stepNumber}Result = await _rc("${api.httpPath}", "${api.httpMethod}", ${params});
    if (!_step${step.stepNumber}Result.success) {
      return { content: [{ type: "text" as const, text: \`Step ${step.stepNumber} failed: \${_step${step.stepNumber}Result.error || JSON.stringify(_step${step.stepNumber}Result)}\` }], isError: true };
    }${roomIdLine}`;

    }).join("\n");

    const lastGenerated = generatedStepNums.length > 0
        ? generatedStepNums[generatedStepNums.length - 1]
        : null;

    const resultLine = lastGenerated
        ? `result: _step${lastGenerated}Result,`
        : `result: { note: "No steps resolved — check API names" },`;

    return `
// ── Workflow Tool: ${tool.name} ${"─".repeat(Math.max(0, 45 - tool.name.length))}
server.tool(
  "${tool.name}",
  "${tool.description.replace(/"/g, '\\"')}",
  {
${zodParams}
  },
  async ({ ${argsList} }) => {
    ${stepImplementations}

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        success: true,
        workflow: "${tool.name}",
        steps: ${generatedStepNums.length},
        ${resultLine}
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
  const url = isGet
    ? \`\${RC_URL}\${path}?\${new URLSearchParams(params).toString()}\`
    : \`\${RC_URL}\${path}\`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": RC_AUTH_TOKEN,
      "X-User-Id": RC_USER_ID,
    },
    ...(isGet ? {} : { body: JSON.stringify(params) }),
  });

  return res.json();
}
`;