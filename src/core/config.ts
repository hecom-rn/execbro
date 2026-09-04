import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./paths.js";

const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
    projectMemory?: { enabled?: boolean };
}

function loadConfig(): Config {
    if (!existsSync(CONFIG_FILE)) return {};
    try {
        const raw = readFileSync(CONFIG_FILE, "utf-8");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

const config = loadConfig();

/** Local project-memory store is on unless config.json sets it to exactly false. */
export function isProjectMemoryEnabled(): boolean {
    return config.projectMemory?.enabled !== false;
}
