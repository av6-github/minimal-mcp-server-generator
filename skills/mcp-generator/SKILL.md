---
name: mcp-generator
description: >
  Generate minimal MCP servers from Rocket.Chat API specs. Activate when
  user asks to generate an MCP server or reduce context bloat.
---

# MCP Generator — Strict Workflow

Follow these steps in order. Do not skip or combine steps.

1. Call `analyze_requirements` with the user's requirement
2. Call `propose_mcp_server` using EXACTLY the paths from analyze_requirements output — do NOT call `list_rocketchat_apis` to verify
3. Wait for user confirmation (add/remove/confirm)
4. Call `ask_server_name` and wait for user response
5. Call `generate_mcp_server` with confirmed APIs and server name

Rules:
- Prefer `postMessage` over `sendMessage` always
- Use full path format for ambiguous names: `chat.delete` not `delete`
- Never call `list_rocketchat_apis` during generation flow — `analyze_requirements` already pre-filters