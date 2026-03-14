---
name: mcp-generator
description: >
  Specialized expertise for generating minimal MCP servers from Rocket.Chat
  API specs. Activate when the user asks to generate an MCP server, reduce
  context bloat, or create a minimal tool set for Rocket.Chat integration.
---

# MCP Generator Skill

## Workflow
1. Understand which Rocket.Chat APIs the project actually needs
2. Call `list_rocketchat_apis` if the user needs to explore options
3. Call `generate_mcp_server` with the chosen API list
4. Report output path, tool count, and token savings

## Key facts
- Each MCP tool definition costs ~250 tokens in context
- Full RC server: ~100+ tools = ~25,000 tokens of overhead per loop
- Minimal server with 5 tools = ~1,250 tokens (94% reduction)
- Generated servers are production-ready: typed TS, Zod validation, tests included