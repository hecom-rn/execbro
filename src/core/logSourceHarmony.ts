/**
 * HarmonyOS native log source over `hilog`, fetched with hdc.
 *
 * Mirrors logSourceAndroid.ts: a pure command builder, a tolerant line parser
 * that emits RawLogLine, and thin fetch/resolver helpers the nativeLogs
 * pipeline can dispatch to. hilog's time-window flags vary across HarmonyOS
 * versions, so the dump uses `hilog -x` (print buffer, exit) and the time
 * filter is applied here against parsed timestamps — the shared native
 * watermark then dedupes exactly like the adb path.
 *
 * Line format (HarmonyOS NEXT): `MM-DD HH:MM:SS.mmm  Pid Tid L Domain/Tag: msg`
 * Flagged for on-device verification (spec V2).
 */

import { execFileAsync, quoteForDeviceShell, withCancelableTimeout } from "./exec.js";
import type { EventLevel, RawLogLine } from "./logEvents.js";
import { buildShellArgs } from "./harmony.js";
import type { HarmonyLayoutNode } from "./harmony.js";

const MAX_BUFFER = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

const LEVEL: Record<string, EventLevel> = {
    D: "debug",
    I: "info",
    W: "warn",
    E: "error",
    F: "fatal",
};

// "09-01 17:42:10.123  1234  5678 I C01800/JsApp: window created"
const LINE_RE = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:\s]+):\s?(.*)$/;

export function buildHilogArgs(opts: { targetKey?: string }): string[] {
    return [...buildShellArgs(opts.targetKey, ["hilog", "-x"])];
}

export function parseHilogLines(stdout: string): RawLogLine[] {
    const year = new Date().getFullYear();
    const out: RawLogLine[] = [];
    for (const raw of stdout.split("\n")) {
        if (!raw.trim()) continue;
        const m = raw.match(LINE_RE);
        if (!m) continue;
        const [, monthDay, clock, pid, tid, level, tag, message] = m;
        const [month, day] = monthDay.split("-").map(Number);
        const [hh, mm, rest] = clock.split(":").map(Number);
        const ms = Math.round((rest % 1) * 1000);
        out.push({
            ts: new Date(year, month - 1, day, hh, Math.floor(mm), Math.floor(rest), ms),
            level: LEVEL[level] ?? "log",
            pid: Number(pid),
            tid: Number(tid),
            tag: tag.trim(),
            message,
            raw,
        });
    }
    return out;
}

export async function fetchHarmonyLines(opts: {
    targetKey?: string;
    sinceTs?: Date;
    signal?: AbortSignal;
}): Promise<RawLogLine[]> {
    const args = buildHilogArgs(opts);
    const { stdout } = await withCancelableTimeout(
        (signal) => execFileAsync("hdc", args, { signal, maxBuffer: MAX_BUFFER }),
        FETCH_TIMEOUT_MS,
        `hilog (${opts.targetKey ?? "default target"})`
    );
    const lines = parseHilogLines(stdout);
    if (!opts.sinceTs) return lines;
    return lines.filter((l) => l.ts.getTime() >= opts.sinceTs!.getTime() - 1);
}

/**
 * The real bundle name of the foreground RN app, read off the dumpLayout
 * tree's bundleName attribute. Needed because Metro reports the app id as an
 * "undefinedAppName@<ts>" blob on RNOH, which pidof can never resolve.
 *
 * The dump contains every window, not just the app's: the system launcher
 * (com.ohos.sceneboard) appears alongside the RN app and which one traversal
 * meets first is not stable. A window node carries `focused` exactly when it
 * is foreground, so prefer the focused window's bundle name; fall back to the
 * first seen only when nothing reports focus.
 */
export function pickForegroundBundleName(root: HarmonyLayoutNode): string | undefined {
    let first: string | undefined;
    const stack = [root];
    while (stack.length) {
        const n = stack.pop()!;
        if (n.bundleName) {
            if (n.focused) return n.bundleName;
            first ??= n.bundleName;
        }
        // Reversed push keeps the DFS in document order so the `first`
        // fallback really is the first bundle name in the dump.
        stack.push(...[...n.children].reverse());
    }
    return first;
}

export async function resolveHarmonyBundleName(targetKey?: string): Promise<string | undefined> {
    const { harmonyDumpLayout } = await import("./harmony.js");
    const dump = await harmonyDumpLayout(targetKey);
    if (!dump.success || !dump.root) return undefined;
    return pickForegroundBundleName(dump.root);
}

/** Resolve the app's live pid by bundle name, or undefined when not running (verify V2). */
export async function resolveHarmonyPid(
    bundleName: string,
    targetKey?: string,
    signal?: AbortSignal
): Promise<number | undefined> {
    try {
        const { stdout } = await execFileAsync(
            "hdc",
            [...buildShellArgs(targetKey, [`pidof -s ${quoteForDeviceShell(bundleName)}`])],
            { signal }
        );
        const pid = Number(stdout.trim());
        return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}
