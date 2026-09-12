import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { TouchPoint } from "../../core/emulatorGrpc.js";

/**
 * HarmonyOS pinch over `hdc shell uinput -T`.
 *
 * `uitest uiInput` has no multi-finger form; `uinput -T -m` does — with the
 * two fingers' start and end coordinates in ONE command, which presses both
 * contacts, smooth-moves them together, and lifts them. That single-command
 * form is the only one that works across uinput builds: on the silent
 * DevEco emulator image verified 2026-09-11, separate `-d`/`-m`/`-u`
 * invocations do NOT share touch state (the gesture never forms), while a
 * bare dual-finger `-m` drives real zooms.
 *
 * Assertions are on the hdc argv and the -m echo, per CLAUDE.md — nothing
 * here contacts a device.
 */

const TARGET = "127.0.0.1:5555";

const hdcCalls: string[][] = [];
/** Controls what the next -m echo prints: a full echo, nothing at all, or a wrong count. */
let moveEcho: "ok" | "silent" | "wrong" = "ok";

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: async (_file: string, args: string[]) => {
        hdcCalls.push(args);
        if (args?.[0] === "list" && args?.[1] === "targets") {
            return { stdout: `${TARGET}\n`, stderr: "" };
        }
        if (args?.includes("hidumper")) {
            return { stdout: "activeMode:1320x2856, refreshRate=60\n", stderr: "" };
        }
        if (args?.includes("-m")) {
            if (moveEcho === "silent") {
                // The DevEco emulator image verified 2026-09-11 prints NOTHING
                // for uinput — no fingerCount, no trailing hint line.
                return { stdout: "", stderr: "" };
            }
            if (moveEcho === "wrong") {
                return {
                    stdout: "startX:260, startY:1428, endX:560, endY:1428\nfingerCount:1\n",
                    stderr: ""
                };
            }
            return {
                stdout: "startX:260, startY:1428, endX:560, endY:1428\nfingerCount:2\nkeepTimeMs:0\nsmoothTimeMs:1000\n",
                stderr: ""
            };
        }
        if (args?.includes("-d")) return { stdout: "touch down 260 1428\n", stderr: "" };
        if (args?.includes("-u")) return { stdout: "touch up 560 1428\n", stderr: "" };
        return { stdout: "", stderr: "" };
    },
    execAsync: async () => ({ stdout: "", stderr: "" }),
    quoteForDeviceShell: (v: string) => v,
    withCancelableTimeout: async <T,>(p: Promise<T>) => p
}));

const { buildHarmonyPinchCommands, parseFingerCount, harmonyPinch } =
    await import("../../core/harmony.js");
const { planPinch } = await import("../../core/pinchGeometry.js");
const { EDGE_GUARD_PX } = await import("../../core/pinchThresholds.js");

/** The plan the driver must produce for the mocked 1320x2856 screen. */
function expectedPlan() {
    return planPinch({
        focalX: 660,
        focalY: 1428,
        direction: "in",
        scale: 3,
        angleDeg: 0,
        durationMs: 300,
        screenWidth: 1320,
        screenHeight: 2856,
        guards: EDGE_GUARD_PX
    });
}

function moveArgv(frames: TouchPoint[][]): string[] {
    const [c1Start, c2Start] = frames[0];
    const [c1End, c2End] = frames[frames.length - 1];
    return [
        "uinput", "-T", "-m",
        String(Math.round(c1Start.x)), String(Math.round(c1Start.y)),
        String(Math.round(c1End.x)), String(Math.round(c1End.y)),
        String(Math.round(c2Start.x)), String(Math.round(c2Start.y)),
        String(Math.round(c2End.x)), String(Math.round(c2End.y))
    ];
}

/** Hand-built single-segment plan: finger contacts at the doc's measured geometry. */
function oneGesture(
    c1: [number, number],
    c2: [number, number],
    c1End: [number, number],
    c2End: [number, number]
): TouchPoint[][][] {
    const contact = ([x, y]: [number, number], identifier: number, pressure: number): TouchPoint => ({
        x, y, identifier, pressure
    });
    return [[
        [contact(c1, 0, 1024), contact(c2, 1, 1024)],
        [contact(c1End, 0, 0), contact(c2End, 1, 0)]
    ]];
}

describe("buildHarmonyPinchCommands", () => {
    it("emits one self-contained dual-finger -m per sub-gesture — no separate press/lift", () => {
        const commands = buildHarmonyPinchCommands(
            oneGesture([260, 1428], [1060, 1428], [560, 1428], [760, 1428])
        );
        // Finger 1: (260,1428)→(560,1428); finger 2: (1060,1428)→(760,1428) —
        // the exact command shape from the device-verified reference sequence.
        expect(commands).toEqual([
            ["uinput", "-T", "-m",
                "260", "1428", "560", "1428",
                "1060", "1428", "760", "1428"]
        ]);
    });

    it("rounds coordinates to integers", () => {
        const commands = buildHarmonyPinchCommands(
            oneGesture([260.6, 1428.4], [1060, 1428], [560.2, 1428.7], [760, 1428])
        );
        expect(commands[0]).toEqual([
            "uinput", "-T", "-m",
            "261", "1428", "560", "1429",
            "1060", "1428", "760", "1428"
        ]);
    });

    it("emits one command per chained sub-gesture, each starting at its own contacts", () => {
        const gestures = [
            ...oneGesture([260, 1428], [1060, 1428], [560, 1428], [760, 1428]),
            ...oneGesture([560, 1428], [760, 1428], [660, 1428], [660, 1428])
        ];
        const commands = buildHarmonyPinchCommands(gestures);
        expect(commands).toHaveLength(2);
        expect(commands[0]?.slice(3)).toEqual([
            "260", "1428", "560", "1428", "1060", "1428", "760", "1428"
        ]);
        expect(commands[1]?.slice(3)).toEqual([
            "560", "1428", "660", "1428", "760", "1428", "660", "1428"
        ]);
    });
});

describe("parseFingerCount", () => {
    it("extracts the finger count from the uinput -m echo", () => {
        const echo = "startX:260, startY:1428, endX:560, endY:1428\n" +
            "startX:1060, startY:1428, endX:760, endY:1428\n" +
            "fingerCount:2\nkeepTimeMs:0\nsmoothTimeMs:1000\n";
        expect(parseFingerCount(echo)).toBe(2);
    });

    it("returns null when the echo carries no finger count", () => {
        expect(parseFingerCount("touch down 260 1428\n")).toBeNull();
        expect(parseFingerCount("")).toBeNull();
    });
});

describe("harmonyPinch driver", () => {
    beforeEach(() => {
        hdcCalls.length = 0;
        moveEcho = "ok";
    });

    it("sends one self-contained -m per gesture, scoped to the resolved target", async () => {
        const result = await harmonyPinch({
            focalX: 660,
            focalY: 1428,
            direction: "in",
            scale: 3,
            angleDeg: 0,
            durationMs: 300
        });
        expect(result.success).toBe(true);

        const plan = expectedPlan();
        const uinput = hdcCalls.filter((args) => args.includes("uinput"));
        expect(uinput).toHaveLength(1);
        expect(uinput[0]?.slice(0, 3)).toEqual(["-t", TARGET, "shell"]);
        expect(uinput[0]?.slice(3)).toEqual(moveArgv(plan.gestures[0]));
        expect(result.gestureCount).toBe(1);
    });

    it("succeeds when the -m echo is silent — exit code decides when the uinput build prints nothing", async () => {
        moveEcho = "silent";

        const result = await harmonyPinch({
            focalX: 660,
            focalY: 1428,
            direction: "in",
            scale: 3,
            angleDeg: 0,
            durationMs: 300
        });
        expect(result.success).toBe(true);
        expect(hdcCalls.filter((args) => args.includes("uinput"))).toHaveLength(1);
    });

    it("fails when the -m echo reports the wrong finger count", async () => {
        moveEcho = "wrong";

        const result = await harmonyPinch({
            focalX: 660,
            focalY: 1428,
            direction: "in",
            scale: 3,
            angleDeg: 0,
            durationMs: 300
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/fingerCount/i);
        // The command is self-contained — no contacts can be left down, so
        // nothing is sent after the failed -m.
        expect(hdcCalls.filter((args) => args.includes("uinput"))).toHaveLength(1);
    });

    it("rejects a plan that cannot place two contacts instead of sending uinput", async () => {
        const result = await harmonyPinch({
            focalX: 660,
            focalY: 1428,
            direction: "in",
            scale: 1,
            angleDeg: 0,
            durationMs: 300
        });
        expect(result.success).toBe(false);
        expect(hdcCalls.filter((args) => args.includes("uinput"))).toHaveLength(0);
    });
});
