import { resolveApis } from "./dist/stages/specResolver.js";
import { mapToMCPSchema } from "./dist/stages/schemaMapper.js";
import { writeOutput } from "./dist/stages/outputWriter.js";

// Test: resolve 3 real APIs from the actual spec
const { resolved, notFound } = resolveApis([
  "sendMessage",
  "getMessage", 
  "deleteMessage"
]);

console.log(`\n✅ Resolved: ${resolved.length} APIs`);
console.log(`❌ Not found: ${notFound.join(", ") || "none"}`);

for (const r of resolved) {
  console.log(`\n  → ${r.friendlyName}`);
  console.log(`     ${r.httpMethod} ${r.httpPath}`);
  console.log(`     Parameters: ${r.parameters.map(p => p.name).join(", ")}`);
}

// Map to MCP schemas
const tools = resolved.map(mapToMCPSchema);

// Write output
const outputDir = writeOutput(tools, 100, "./output/test-server");

console.log(`\n📁 Generated: ${outputDir}`);
console.log(`\nFiles:`);

import { readdirSync } from "fs";
const files = [
  "src/index.ts",
  "package.json", 
  "tsconfig.json",
  ".env.example",
  "README.md",
  ...resolved.map(r => `src/tests/${r.friendlyName}.test.ts`)
];
for (const f of files) {
  console.log(`  - ${f}`);
}
