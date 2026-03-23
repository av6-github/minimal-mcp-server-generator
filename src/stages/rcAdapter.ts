import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { PlatformAdapter } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CACHE_DIR = join(__dirname, "../specs-cache");
const SPEC_FILES = [
    "messaging.yaml",
    "rooms.yaml",
    "user-management.yaml",
    "omnichannel.yaml",
    "integrations.yaml",
    "notifications.yaml",
    "settings.yaml",
    "statistics.yaml",
    "authentication.yaml",
    "content-management.yaml",
    "marketplace-apps.yaml",
    "miscellaneous.yaml",
];
const GITHUB_BASE = "https://raw.githubusercontent.com/RocketChat/Rocket.Chat/develop/packages/rest-typings/src/v1";

export class RCAdapter implements PlatformAdapter {

    async loadSpec(): Promise<any> {
        if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

        const allSpecs: any[] = [];

        for (const file of SPEC_FILES) {
            const cachePath = join(CACHE_DIR, file);
            const etagPath = join(CACHE_DIR, `${file}.etag`);

            let content: string | null = null;

            // Tier 1 — GitHub with ETag validation
            try {
                const headers: Record<string, string> = {};
                if (existsSync(etagPath)) {
                    headers["If-None-Match"] = readFileSync(etagPath, "utf-8").trim();
                }

                const res = await fetch(`${GITHUB_BASE}/${file}`, { headers });

                if (res.status === 304) {
                    // ETag match — use cache
                    if (existsSync(cachePath)) {
                        content = readFileSync(cachePath, "utf-8");
                    }
                } else if (res.ok) {
                    content = await res.text();
                    writeFileSync(cachePath, content);
                    const etag = res.headers.get("etag");
                    if (etag) writeFileSync(etagPath, etag);
                }
            } catch {
                // GitHub unreachable — fall through to cache
            }

            // Tier 2 — Local cache
            if (!content && existsSync(cachePath)) {
                content = readFileSync(cachePath, "utf-8");
            }

            if (!content) {
                console.error(`[rcAdapter] Could not load spec file: ${file}`);
                continue;
            }

            try {
                const rawParsed = yaml.load(content) as any;
                const parsed = await SwaggerParser.dereference(rawParsed as any);
                allSpecs.push({ file, spec: parsed });
            } catch (e) {
                console.error(`[rcAdapter] Failed to parse/dereference ${file}:`, e);
                continue;
            }
        }

        return allSpecs;
    }

    getAuthTemplate(): string {
        return `
const RC_URL = process.env.RC_URL!;
const RC_AUTH_TOKEN = process.env.RC_AUTH_TOKEN!;
const RC_USER_ID = process.env.RC_USER_ID!;
`;
    }

    getEnvVarTemplate(): string {
        return `# Rocket.Chat instance URL (no trailing slash)
RC_URL=https://your.rocket.chat

# Authentication credentials
# Get these from: Profile > My Account > Personal Access Tokens
RC_AUTH_TOKEN=your_personal_access_token
RC_USER_ID=your_user_id
`;
    }
}

export const rcAdapter = new RCAdapter();
