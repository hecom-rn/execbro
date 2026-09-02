/**
 * HarmonyOS (OpenHarmony / HarmonyOS NEXT) device backend over `hdc`.
 *
 * Function-for-function this mirrors the shape of `android.ts`: every call
 * takes an optional target key, an availability cache gates on a single
 * probe, and the command assembly is in small exported pure functions so the
 * argv can be unit-tested without a device. hdc command semantics were taken
 * from the awesome-hdc collection and the OpenHarmony arkxtest docs and are
 * flagged for on-device verification (spec §6, V1) — when a command turns out
 * to differ, fix it inside this file only.
 *
 * hdc, like adb, hands `shell <command>` to a device-side shell, so every
 * interpolated value is quoted with `quoteForDeviceShell` even though the
 * host-side invocation is argv-form.
 */

import { existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import os from "os";
import { execFileAsync, quoteForDeviceShell } from "./exec.js";

const HDC_TIMEOUT = 30_000;

// Availability cache — same contract as isAdbAvailable in android.ts.
let hdcAvailableCache: boolean | null = null;

export interface HdcResult {
    success: boolean;
    result?: string;
    error?: string;
    data?: Buffer;
    // Screenshot metadata, mirroring AdbResult.
    scaleFactor?: number;
    originalWidth?: number;
    originalHeight?: number;
}

export interface HarmonyTarget {
    key: string;
    state: "connected" | "disconnected";
    /** loopback host:port keys are emulator port forwards; anything else is a real device. */
    kind: "emulator" | "real";
}

export function resetHdcAvailabilityCache(): void {
    hdcAvailableCache = null;
}

export function hdcBinaryName(): string {
    return process.platform === "win32" ? "hdc.exe" : "hdc";
}

async function resolveHdcBinary(): Promise<string | null> {
    // hdc ships with DevEco Studio / the OpenHarmony SDK. Check PATH first,
    // then the usual macOS/Windows install locations, mirroring the adb
    // recovery path for GUI-spawned processes.
    try {
        await execFileAsync(hdcBinaryName(), ["version"], { timeout: 5_000 });
        return hdcBinaryName();
    } catch {
        // fall through to well-known locations
    }
    const candidates: string[] = [];
    const env = process.env;
    if (env.HDC_HOME) candidates.push(env.HDC_HOME);
    if (env.OHOS_SDK_HOME) candidates.push(path.join(env.OHOS_SDK_HOME, "toolchains"));
    if (env.HOS_SDK_HOME) candidates.push(path.join(env.HOS_SDK_HOME, "toolchains"));
    if (env.DEVECO_SDK_HOME) candidates.push(path.join(env.DEVECO_SDK_HOME, "..", "toolchains"));
    if (process.platform === "darwin") {
        candidates.push("/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains");
    } else if (process.platform === "win32") {
        if (env.LOCALAPPDATA) {
            candidates.push(path.join(env.LOCALAPPDATA, "Huawei", "Sdk", "openharmony", "10", "toolchains"));
        }
    } else {
        candidates.push(path.join(os.homedir(), "OpenHarmony", "Sdk", "toolchains"));
    }
    for (const dir of candidates) {
        const binary = path.join(dir, hdcBinaryName());
        if (!existsSync(binary)) continue;
        try {
            await execFileAsync(binary, ["version"], { timeout: 5_000 });
            // Same trick as android.ts: make the bare name work for later calls.
            process.env.PATH = `${dir}:${process.env.PATH}`;
            return hdcBinaryName();
        } catch {
            // try next candidate
        }
    }
    return null;
}

export async function isHdcAvailable(): Promise<boolean> {
    if (hdcAvailableCache !== null) return hdcAvailableCache;
    hdcAvailableCache = (await resolveHdcBinary()) !== null;
    return hdcAvailableCache;
}

/** Returns an error result when hdc is unreachable, or null when it is usable. */
export async function requireHdc(): Promise<HdcResult | null> {
    if (await isHdcAvailable()) return null;
    return {
        success: false,
        error: "hdc (HarmonyOS Device Connector) is not installed or not on PATH. " +
            "Install DevEco Studio or the OpenHarmony SDK toolchains, then retry."
    };
}

// --- Pure command builders (unit-tested without a device) ---

export function buildHdcArgs(targetKey?: string): string[] {
    return targetKey ? ["-t", targetKey] : [];
}

export function buildShellArgs(targetKey: string | undefined, command: string[]): string[] {
    return [...buildHdcArgs(targetKey), "shell", ...command];
}

/** Physical/virtual key names accepted by `uitest uiInput keyEvent` (verify on device, V1). */
export const HARMONY_KEY_EVENTS: Record<string, string> = {
    BACK: "Back",
    HOME: "Home",
    ENTER: "Enter",
    DEL: "Del",
    ESC: "Esc",
    POWER: "Power",
    VOLUME_UP: "VolumeUp",
    VOLUME_DOWN: "VolumeDown"
};

export function escapeHarmonyShellText(value: string): string {
    return quoteForDeviceShell(value);
}

let snapshotCounter = 0;
export function remoteSnapshotPath(pid: number): string {
    snapshotCounter += 1;
    return `/data/local/tmp/execbro_${pid}_${snapshotCounter}.jpeg`;
}

function num(n: number): string {
    return String(Math.round(n));
}

// --- Output parsers (fixture-tested) ---

export function parseHdcTargets(stdout: string): HarmonyTarget[] {
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("["))
        .map((line) => {
            const disconnected = /\(Disconnected\)\s*$/i.test(line);
            const key = line.replace(/\(Disconnected\)\s*$/i, "").split(/\s+/)[0];
            return {
                key,
                state: disconnected ? ("disconnected" as const) : ("connected" as const),
                kind: /^127\.0\.0\.1:\d+$/.test(key) ? ("emulator" as const) : ("real" as const)
            };
        });
}

export function parseBmDumpList(stdout: string): string[] {
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        // bm dump -a prints one bundle name per line; keep the last whitespace
        // token so any prefixed column (verify format on device, V1) still yields names.
        .map((line) => line.split(/\s+/).pop() as string)
        .filter((name) => /^[A-Za-z][A-Za-z0-9._]*$/.test(name));
}

/** Accepts hidumper RenderService `activeMode:WxH` / `Physical size:WxH` shapes. */
export function parseScreenSize(stdout: string): { width: number; height: number } | null {
    const patterns = [/activeMode:\s*(\d+)x(\d+)/, /renderSize:\s*(\d+)x(\d+)/, /Physical size:\s*(\d+)x(\d+)/];
    for (const re of patterns) {
        const m = stdout.match(re);
        if (m) return { width: Number(m[1]), height: Number(m[2]) };
    }
    return null;
}

// --- Accessibility tree (uitest dumpLayout) ---

export interface HarmonyLayoutNode {
    /** RN testID when the node came from React (`key` in the dump). */
    key: string;
    text: string;
    type: string;
    /** Device-pixel [x, y, width, height]. */
    bounds: [number, number, number, number];
    clickable: boolean;
    focused: boolean;
    bundleName?: string;
    children: HarmonyLayoutNode[];
}

function parseLayoutNode(raw: any): HarmonyLayoutNode | null {
    if (!raw || typeof raw !== "object") return null;
    const b = String(raw.attributes?.bounds ?? "");
    const m = b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const bounds: [number, number, number, number] = m
        ? [Number(m[1]), Number(m[2]), Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])]
        : [0, 0, 0, 0];
    return {
        key: String(raw.attributes?.key ?? ""),
        text: String(raw.attributes?.text ?? ""),
        type: String(raw.attributes?.type ?? ""),
        bounds,
        clickable: String(raw.attributes?.clickable ?? "") === "true",
        focused: String(raw.attributes?.focused ?? "") === "true",
        bundleName: raw.attributes?.bundleName ? String(raw.attributes.bundleName) : undefined,
        children: Array.isArray(raw.children)
            ? raw.children.map(parseLayoutNode).filter(Boolean)
            : [],
    };
}

/** Parse a `uitest dumpLayout -p <file>` document (JSON, device-pixel bounds). */
export function parseDumpLayout(jsonText: string): HarmonyLayoutNode | null {
    try {
        return parseLayoutNode(JSON.parse(jsonText));
    } catch {
        return null;
    }
}

/** All nodes matching a testID or a text substring, depth-first. */
export function findLayoutNodes(
    root: HarmonyLayoutNode,
    opts: { testID?: string; text?: string }
): HarmonyLayoutNode[] {
    const wantKey = opts.testID ? String(opts.testID) : "";
    const wantText = opts.text ? String(opts.text).trim() : "";
    const out: HarmonyLayoutNode[] = [];
    const stack = [root];
    while (stack.length) {
        const n = stack.pop() as HarmonyLayoutNode;
        if (wantKey && n.key === wantKey) out.push(n);
        else if (!wantKey && wantText && n.text.trim() && n.text.trim().includes(wantText)) out.push(n);
        stack.push(...n.children);
    }
    return out;
}

/** Depth-first search for a node matching a testID or an exact text. */
export function findLayoutNode(
    root: HarmonyLayoutNode,
    opts: { testID?: string; text?: string }
): HarmonyLayoutNode | null {
    const wantKey = opts.testID ? String(opts.testID) : "";
    const wantText = opts.text ? String(opts.text).trim() : "";
    const stack = [root];
    while (stack.length) {
        const n = stack.pop() as HarmonyLayoutNode;
        if (wantKey && n.key === wantKey) return n;
        if (!wantKey && wantText && n.text.trim() && n.text.trim().includes(wantText)) return n;
        stack.push(...n.children);
    }
    return null;
}

export async function harmonyDumpLayout(
    targetKey?: string
): Promise<{ success: boolean; root?: HarmonyLayoutNode; error?: string }> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    const { mkdtemp, readFile, unlink } = await import("fs/promises");
    const remote = `/data/local/tmp/execbro_layout_${process.pid}.json`;
    const localDir = await mkdtemp(path.join(tmpdir(), "execbro-harmony-"));
    try {
        await runHdc(buildShellArgs(device, ["uitest", "dumpLayout", "-p", remote]), 20_000);
        const local = path.join(localDir, "layout.json");
        await runHdc([...buildHdcArgs(device), "file", "recv", remote, local]);
        const root = parseDumpLayout((await readFile(local)).toString("utf8"));
        if (!root) return { success: false, error: "uitest dumpLayout produced no parseable tree" };
        return { success: true, root };
    } catch (e) {
        return errFrom(e, "dumpLayout");
    } finally {
        await runHdc(buildShellArgs(device, ["rm", "-f", remote]), 10_000).catch(() => undefined);
        await unlink(path.join(localDir, "layout.json")).catch(() => undefined);
        await unlink(localDir).catch(() => undefined);
    }
}

// --- Execution layer ---

async function runHdc(args: string[], timeoutMs = HDC_TIMEOUT): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(hdcBinaryName(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
}

function errFrom(e: unknown, context: string): HdcResult {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: `hdc ${context} failed: ${message}` };
}

/**
 * Find the hdc target that is actually running an RNOH app, by scanning each
 * connected target's hilog for the RNOH runtime marker. This is the fallback
 * platform signal when `PlatformConstants` is unreachable from JS (verified on
 * RNOH 0.77.1: `nativeModuleProxy.PlatformConstants` is an empty object and
 * `require('react-native')` is undefined through CDP). Returns the single
 * RNOH-bearing target, or null when none or several qualify.
 */
export async function detectRnohTarget(): Promise<string | null> {
    const targets = (await listHarmonyTargets()).filter((t) => t.state === "connected");
    const withMarker: string[] = [];
    for (const t of targets) {
        try {
            const { stdout } = await runHdc(
                buildShellArgs(t.key, ["hilog -x | grep -m1 -iE 'rnoh|reactnative'"]),
                15_000
            );
            if (stdout.trim()) withMarker.push(t.key);
        } catch {
            // unreachable target — skip
        }
    }
    return withMarker.length === 1 ? withMarker[0] : null;
}

/** First connected target, or null. Same role as getDefaultAndroidDevice. */
export async function getDefaultHarmonyTarget(): Promise<string | null> {
    const targets = await listHarmonyTargets();
    return targets.find((t) => t.state === "connected")?.key ?? null;
}

export async function listHarmonyTargets(): Promise<HarmonyTarget[]> {
    if (!(await isHdcAvailable())) return [];
    try {
        const { stdout } = await runHdc(["list", "targets"], 10_000);
        return parseHdcTargets(stdout).filter((t) => t.state === "connected");
    } catch {
        return [];
    }
}

export async function harmonyScreenshot(
    outputPath?: string,
    targetKey?: string,
    signal?: AbortSignal
): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;

    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) {
        return { success: false, error: "No HarmonyOS device connected (hdc list targets is empty)." };
    }

    const { mkdtemp, readFile, unlink, writeFile } = await import("fs/promises");
    const localDir = await mkdtemp(path.join(tmpdir(), "execbro-harmony-"));
    const remote = remoteSnapshotPath(process.pid);
    try {
        await runHdc(buildShellArgs(device, ["snapshot_display", "-f", remote]), HDC_TIMEOUT);
        const local = path.join(localDir, "screen.jpeg");
        await runHdc([...buildHdcArgs(device), "file", "recv", remote, local]);
        // Best-effort remote cleanup — a leftover file in /data/local/tmp is
        // harmless next to failing the capture outright.
        await runHdc(buildShellArgs(device, ["rm", "-f", remote]), 10_000).catch(() => undefined);

        const data = await readFile(local);
        const sharp = (await import("sharp")).default;
        const meta = await sharp(data).metadata();
        if (outputPath) {
            await writeFile(outputPath, data);
        }
        await unlink(local).catch(() => undefined);
        return {
            success: true,
            data,
            result: outputPath,
            originalWidth: meta.width,
            originalHeight: meta.height,
            // Delivered-pixel scale is decided by the shared downscale logic at
            // read time; 1 keeps harmony captures in device pixels for now.
            scaleFactor: 1,
        };
    } catch (e) {
        return errFrom(e, "snapshot_display/recv");
    } finally {
        if (localDir) await unlink(localDir).catch(() => undefined);
    }
}

export async function harmonyTap(x: number, y: number, targetKey?: string): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    try {
        const { stdout } = await runHdc(
            buildShellArgs(device, ["uitest", "uiInput", "click", num(x), num(y)])
        );
        return { success: true, result: stdout.trim() };
    } catch (e) {
        return errFrom(e, "uiInput click");
    }
}

export async function harmonyLongPress(
    x: number,
    y: number,
    _durationMs: number,
    targetKey?: string
): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    try {
        // uiInput longClick has no duration parameter; the hold length is the
        // system's long-press threshold.
        const { stdout } = await runHdc(
            buildShellArgs(device, ["uitest", "uiInput", "longClick", num(x), num(y)])
        );
        return { success: true, result: stdout.trim() };
    } catch (e) {
        return errFrom(e, "uiInput longClick");
    }
}

export async function harmonySwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    speed?: number,
    targetKey?: string
): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    try {
        const args = ["uitest", "uiInput", "swipe", num(x1), num(y1), num(x2), num(y2)];
        if (speed && speed > 0) args.push(num(speed));
        const { stdout } = await runHdc(buildShellArgs(device, args));
        return { success: true, result: stdout.trim() };
    } catch (e) {
        return errFrom(e, "uiInput swipe");
    }
}

export async function harmonyKeyEvent(key: string, targetKey?: string): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    const keyName = HARMONY_KEY_EVENTS[key.toUpperCase()] ?? key;
    try {
        const { stdout } = await runHdc(buildShellArgs(device, ["uitest", "uiInput", "keyEvent", keyName]));
        return { success: true, result: stdout.trim() };
    } catch (e) {
        return errFrom(e, `uiInput keyEvent ${keyName}`);
    }
}

export async function harmonyInputText(
    x: number,
    y: number,
    text: string,
    targetKey?: string
): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    try {
        const { stdout } = await runHdc(
            buildShellArgs(device, [
                "uitest",
                "uiInput",
                "inputText",
                num(x),
                num(y),
                escapeHarmonyShellText(text)
            ])
        );
        return { success: true, result: stdout.trim() };
    } catch (e) {
        return errFrom(e, "uiInput inputText");
    }
}

/**
 * Types into whatever field currently has focus via `uitest uiInput text` —
 * no coordinates needed. Verify the focused-variant behaviour on device (V2);
 * the coordinate form (harmonyInputText) is the fallback.
 */
export async function harmonyInputFocusedText(text: string, targetKey?: string): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    try {
        const { stdout } = await runHdc(
            buildShellArgs(device, ["uitest", "uiInput", "text", escapeHarmonyShellText(text)])
        );
        return { success: true, result: stdout.trim() };
    } catch (e) {
        return errFrom(e, "uiInput text");
    }
}

export async function harmonyLaunchApp(
    bundleName: string,
    abilityName?: string,
    targetKey?: string
): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    const ability = abilityName || "EntryAbility";
    try {
        const { stdout } = await runHdc(
            buildShellArgs(device, [
                "aa",
                "start",
                "-b",
                escapeHarmonyShellText(bundleName),
                "-a",
                escapeHarmonyShellText(ability)
            ])
        );
        return { success: true, result: stdout.trim() };
    } catch (e) {
        return errFrom(e, `aa start ${bundleName}`);
    }
}

export async function harmonyTerminateApp(bundleName: string, targetKey?: string): Promise<HdcResult> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    try {
        const { stdout } = await runHdc(
            buildShellArgs(device, ["aa", "force-stop", escapeHarmonyShellText(bundleName)])
        );
        return { success: true, result: stdout.trim() };
    } catch (e) {
        return errFrom(e, `aa force-stop ${bundleName}`);
    }
}

export async function harmonyListPackages(targetKey?: string): Promise<HdcResult & { packages?: string[] }> {
    const missing = await requireHdc();
    if (missing) return missing;
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return { success: false, error: "No HarmonyOS device connected." };
    try {
        const { stdout } = await runHdc(buildShellArgs(device, ["bm", "dump", "-a"]));
        return { success: true, packages: parseBmDumpList(stdout), result: stdout };
    } catch (e) {
        return errFrom(e, "bm dump -a");
    }
}

export async function harmonyGetScreenSize(
    targetKey?: string
): Promise<{ width: number; height: number } | null> {
    const device = targetKey ?? (await getDefaultHarmonyTarget());
    if (!device) return null;
    try {
        const { stdout } = await runHdc(
            buildShellArgs(device, ["hidumper", "-s", "RenderService", "-a", "screen"]),
            15_000
        );
        const parsed = parseScreenSize(stdout);
        if (parsed) return parsed;
        // Fallback: infer device pixels from an actual capture.
        const shot = await harmonyScreenshot(undefined, device);
        if (shot.success && shot.originalWidth && shot.originalHeight) {
            return { width: shot.originalWidth, height: shot.originalHeight };
        }
        return null;
    } catch {
        return null;
    }
}
