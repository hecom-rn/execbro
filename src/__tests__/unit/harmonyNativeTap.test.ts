import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import WebSocket from "ws";
import type { ConnectedApp } from "../../core/types.js";

/**
 * A native coordinate tap (`native: true`) must dispatch `uitest uiInput
 * click` to the resolved hdc target, and every verification frame must name
 * that target too.
 *
 * The native path used to hard-refuse harmony entirely ("Native coordinate
 * taps on HarmonyOS are not supported yet") — a guard from before `hdc
 * uiInput` landed. hdc uiInput has since shipped and the auto-strategy paths
 * already drive it, so the guard only made `native: true` — the path agents
 * reach for when CDP is down — the one way harmony tap could not work.
 *
 * Assertions are on the hdc argv: `-t <key>` is what actually decides which
 * device gets the touch. Nothing here contacts a device — the exec layer is
 * stubbed (per CLAUDE.md, no test may drive a simulator or emulator).
 */

const TARGET = "127.0.0.1:5559";
const OTHER = "6HQ0226409005934";

const hdcCalls: string[][] = [];
const verifyCalls: Array<Record<string, unknown>> = [];

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (file: string, args: string[]) => {
        if (file === "hdc") hdcCalls.push(args);
        if (args?.[0] === "list" && args?.[1] === "targets") {
            // Two harmony targets attached, neither first by luck — with no
            // `-t`, hdc picks whichever answers first.
            return { stdout: `${OTHER}\n${TARGET}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
    },
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: async <T>(p: Promise<T>) => p
}));

jest.unstable_mockModule("../../core/deviceResolver.js", () => ({
    checkNativeBackendAvailable: () => null,
    resolveDeviceTarget: async () => ({
        ok: true,
        target: {
            platform: "harmony" as const,
            harmonyTargetKey: TARGET,
            deviceName: TARGET,
            source: "hdc-key" as const,
            nativeBinding: "hdc" as const
        }
    }),
    formatResolverError: (e: { message: string }) => e.message
}));

jest.unstable_mockModule("../../pro/verifyAction.js", () => ({
    captureScreenshot: async (platform: string, udid?: string, deviceId?: string, hdcKey?: string) => {
        verifyCalls.push({ fn: "captureScreenshot", platform, udid, deviceId, hdcKey });
        return { buffer: Buffer.from("jpeg"), width: 1260, height: 2720, scaleFactor: 1 };
    },
    verifyAndCapture: async (args: Record<string, unknown>) => {
        verifyCalls.push({ fn: "verifyAndCapture", ...args });
        return { screenshot: undefined, verification: undefined, afterWithMarkerBuffer: null };
    },
    burstCaptureAndVerify: async (args: Record<string, unknown>) => {
        verifyCalls.push({ fn: "burstCaptureAndVerify", ...args });
        return { screenshot: undefined, verification: undefined };
    },
    drawTapMarker: async (b: Buffer) => b,
    settleAndDiff: async () => null
}));

jest.unstable_mockModule("../../pro/overlayGuard.js", () => ({
    checkOverlayBlocking: async () => null
}));

const { tap } = await import("../../pro/tap.js");
const { connectedApps } = await import("../../core/state.js");

function connectHarmonyApp(): void {
    connectedApps.set("harmony-1", {
        ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
        deviceInfo: {
            id: "harmony-1",
            title: "Hermes React Native",
            description: "",
            appId: "com.test",
            type: "node",
            webSocketDebuggerUrl: "ws://localhost:8082/harmony-1",
            deviceName: "harmony"
        },
        port: 8082,
        platform: "harmony",
        harmonyTargetKey: TARGET
    } as ConnectedApp);
}

/** hdc invocations whose argv contains the given fragment. */
function hdcCallsMatching(fragment: string): string[][] {
    return hdcCalls.filter((args) => args.some((a) => a.includes(fragment)));
}

function targetsTheResolvedDevice(args: string[]): boolean {
    const i = args.indexOf("-t");
    return i !== -1 && args[i + 1] === TARGET;
}

describe("tap dispatches native coordinate taps to harmony via hdc", () => {
    beforeEach(() => {
        hdcCalls.length = 0;
        verifyCalls.length = 0;
        connectedApps.clear();
    });

    it("sends a native coordinate tap to the resolved hdc target", async () => {
        const result = await tap({ x: 300, y: 600, native: true, device: TARGET, screenshot: false, verify: false });

        expect(result.success).toBe(true);
        const clicks = hdcCallsMatching("uiInput");
        expect(clicks).toHaveLength(1);
        // hdc -t <target> shell uitest uiInput click 300 600
        expect(clicks[0]).toEqual(["-t", TARGET, "shell", "uitest", "uiInput", "click", "300", "600"]);
    });

    it("captures the verification frames from the resolved hdc target", async () => {
        await tap({ x: 300, y: 600, native: true, device: TARGET, screenshot: false });

        expect(verifyCalls.length).toBeGreaterThan(0);
        for (const call of verifyCalls) {
            expect(call.hdcKey).toBe(TARGET);
        }
    });

    it("routes the auto coordinate strategy through the same hdc tap", async () => {
        connectHarmonyApp();
        const result = await tap({ x: 300, y: 600, device: TARGET, screenshot: false, verify: false });

        expect(result.success).toBe(true);
        const clicks = hdcCallsMatching("uiInput");
        expect(clicks).toHaveLength(1);
        expect(targetsTheResolvedDevice(clicks[0])).toBe(true);
    });
});
