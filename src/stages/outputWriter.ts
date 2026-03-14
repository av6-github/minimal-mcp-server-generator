import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { MCPToolSchema } from "./types.js";
import { generateServerFile, generatePackageJson, generateTsConfig, generateEnvExample, generateReadme } from "./codeGenerator.js";
import { generateTestFile } from "./testGenerator.js";

export function writeOutput(
    tools: MCPToolSchema[],
    totalApiCount: number,
    outputPath: string
): string {
    // Create directory structure
    mkdirSync(join(outputPath, "src", "tests"), { recursive: true });

    // Write main server file
    writeFileSync(
        join(outputPath, "src", "index.ts"),
        generateServerFile(tools)
    );

    // Write one test file per tool
    for (const tool of tools) {
        writeFileSync(
            join(outputPath, "src", "tests", `${tool.name}.test.ts`),
            generateTestFile(tool)
        );
    }

    // Write project config files
    writeFileSync(join(outputPath, "package.json"), generatePackageJson(tools.length));
    writeFileSync(join(outputPath, "tsconfig.json"), generateTsConfig());
    writeFileSync(join(outputPath, ".env.example"), generateEnvExample());
    writeFileSync(join(outputPath, "README.md"), generateReadme(tools, totalApiCount));

    return outputPath;
}