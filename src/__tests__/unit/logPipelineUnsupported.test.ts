import { describe, it, expect } from "@jest/globals";
import { EventEmitter } from "node:events";

const { verifyLogPipeline } = await import("../../core/connection.js");

interface FakeWs {
    send: (s: string) => void;
    on: (e: string, f: (d: unknown) => void) => void;
    off: (e: string, f: (d: unknown) => void) => void;
    readyState: number;
}

function unsupportedEvaluateWs(): FakeWs {
    // 模拟 RNOH Bridgeless C++ 代理：任何 Runtime.evaluate 都回 -32601
    const bus = new EventEmitter();
    const ws: FakeWs = {
        readyState: 1,
        on: (e, f) => bus.on(e, f),
        off: (e, f) => bus.off(e, f),
        send: (s) => {
            const msg = JSON.parse(s);
            if (msg.method === "Runtime.evaluate") {
                setTimeout(() => bus.emit("message", JSON.stringify({
                    id: msg.id,
                    error: { message: msg.method, code: -32601 },
                })), 20);
            }
        },
    };
    return ws;
}

describe("verifyLogPipeline on a target that refuses Runtime.evaluate (-32601)", () => {
    it("reports ok without forcing a reconnect, explaining that passive capture stays on", async () => {
        const { getLogBuffer } = await import("../../core/state.js");
        getLogBuffer("rnoh-device"); // ensure the buffer exists, as the connect path does

        const app = {
            ws: unsupportedEvaluateWs(),
            deviceInfo: { deviceName: "rnoh-device", title: "emulator", id: "d1" },
            platform: "harmony",
            port: 8082,
        } as never;

        const t0 = Date.now();
        const result = await verifyLogPipeline(app);
        const dur = Date.now() - t0;

        // 主动验证不可用，但被动捕获不受影响：必须 ok，且不得走重连路径
        // （重连会先 ensureConnection 再等 settle，耗时长得多）
        expect(result.ok).toBe(true);
        expect(result.recovered).toBe(false);
        expect(result.message).toContain("Runtime.evaluate");
        expect(dur).toBeLessThan(4000);
    });
});
