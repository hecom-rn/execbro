import { jest, describe, it, expect } from "@jest/globals";
import { WebSocketServer, WebSocket } from "ws";

// scheduleAppDetection 的哨兵路径会 dynamic import harmony.js 做 hilog 归属；
// mock 掉 hdc 依赖，返回唯一 target。
jest.unstable_mockModule("../../core/harmony.js", () => ({
    detectRnohTarget: jest.fn(async () => "127.0.0.1:5555"),
    listHarmonyTargets: jest.fn(async () => [{ key: "127.0.0.1:5555", state: "connected" }]),
}));

const { detectApp, scheduleAppDetection, EVALUATE_UNSUPPORTED } = await import("../../core/appDetection.js");
const { connectedApps } = await import("../../core/state.js");

async function openPair(
    handler: (socket: WebSocket) => void
): Promise<{ ws: WebSocket; close: () => Promise<void> }> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const addr = wss.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    wss.on("connection", handler);
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    const close = () =>
        new Promise<void>((resolve) => {
            ws.close();
            wss.close(() => resolve());
        });
    return { ws, close };
}

describe("detectApp on an RNOH Bridgeless C++ proxy", () => {
    it("reports the evaluate-unsupported sentinel when Runtime.evaluate is refused with -32601", async () => {
        const { ws, close } = await openPair((socket) => {
            socket.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                socket.send(JSON.stringify({ id: msg.id, error: { message: "Runtime.evaluate", code: -32601 } }));
            });
        });

        const result = await detectApp(ws);
        expect(result).toBe(EVALUATE_UNSUPPORTED);
        await close();
    });

    it("returns the raw value on a normal evaluate reply", async () => {
        const { ws, close } = await openPair((socket) => {
            socket.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                socket.send(JSON.stringify({ id: msg.id, result: { result: { type: "object", value: { newArch: true } } } }));
            });
        });

        const result = await detectApp(ws);
        expect(result).toEqual({ newArch: true });
        await close();
    });
});

describe("scheduleAppDetection attributes harmony via the hilog marker when evaluate is unsupported", () => {
    it("upgrades the presumptive android platform to harmony and stores the hdc key", async () => {
        const { ws, close } = await openPair((socket) => {
            socket.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                socket.send(JSON.stringify({ id: msg.id, error: { message: "Runtime.evaluate", code: -32601 } }));
            });
        });

        const app = {
            ws,
            platform: "android",
            deviceInfo: { id: "d1", title: "emulator", description: "", appId: "undefinedAppName@x", type: "node", webSocketDebuggerUrl: "", deviceName: "emulator" },
        };
        scheduleAppDetection(app as never);
        // DETECTION_DELAY_MS (500ms) + probe + detectRnohTarget mock
        await new Promise((r) => setTimeout(r, 1200));

        expect(app.platform).toBe("harmony");
        expect((app as { harmonyTargetKey?: string }).harmonyTargetKey).toBe("127.0.0.1:5555");
        expect((app as { appDetection?: { appPlatform: string; detectionSource: string } }).appDetection?.appPlatform).toBe("harmony");
        await close();
    });
});
