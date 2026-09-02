import { describe, it, expect } from "@jest/globals";

const { buildHilogArgs, parseHilogLines } = await import("../../core/logSourceHarmony.js");

describe("hilog command builder", () => {
    it("scopes hilog to a target and dumps then exits", () => {
        expect(buildHilogArgs({ targetKey: "127.0.0.1:5555" })).toEqual([
            "-t", "127.0.0.1:5555", "shell", "hilog", "-x"
        ]);
        expect(buildHilogArgs({})).toEqual(["shell", "hilog", "-x"]);
    });
});

describe("parseHilogLines", () => {
    it("parses the standard hilog line format", () => {
        const out = [
            "09-01 17:42:10.123  1234  5678 I C01800/JsApp: window created",
            "09-01 17:42:11.456  1234  5678 E A0c0d0e/CRASH: NullPointerException",
            "garbage line",
            ""
        ].join("\n");
        const lines = parseHilogLines(out);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({
            level: "info",
            pid: 1234,
            tid: 5678,
            tag: "C01800/JsApp",
            message: "window created"
        });
        expect(lines[1]).toMatchObject({ level: "error", tag: "A0c0d0e/CRASH" });
        expect(lines[0].ts.getFullYear()).toBe(new Date().getFullYear());
    });

    it("maps levels W and F", () => {
        const lines = parseHilogLines(
            "09-01 17:42:10.123  1  2 W X0/Y: warn\n09-01 17:42:10.124  1  2 F X0/Y: fatal\n09-01 17:42:10.125  1  2 D X0/Y: dbg"
        );
        expect(lines.map((l: { level: string }) => l.level)).toEqual(["warn", "fatal", "debug"]);
    });
});
