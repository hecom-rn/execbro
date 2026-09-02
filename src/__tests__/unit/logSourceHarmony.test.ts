import { describe, it, expect } from "@jest/globals";

const { buildHilogArgs, parseHilogLines, pickForegroundBundleName } = await import(
    "../../core/logSourceHarmony.js"
);

// Minimal HarmonyLayoutNode: the bundle-name picker only reads
// bundleName/focused/children.
type TestNode = { bundleName?: string; focused: boolean; children: TestNode[] };
function node(
    opts: { bundleName?: string; focused?: boolean } = {},
    children: TestNode[] = []
): TestNode {
    return { bundleName: opts.bundleName, focused: opts.focused === true, children };
}

describe("pickForegroundBundleName", () => {
    it("prefers the focused window over whichever window traversal meets first", () => {
        // dumpLayout contains every window; on the emulator the launcher
        // (com.ohos.sceneboard) appeared before the RN app's window.
        const root = node({}, [
            node({ bundleName: "com.ohos.sceneboard" }),
            node({ bundleName: "cn.hecom.cloud.har", focused: true }),
        ]);
        expect(pickForegroundBundleName(root as never)).toBe("cn.hecom.cloud.har");
    });

    it("falls back to the first bundle name when nothing reports focus", () => {
        const root = node({}, [
            node({ bundleName: "com.ohos.sceneboard" }),
            node({ bundleName: "cn.hecom.cloud.har" }),
        ]);
        expect(pickForegroundBundleName(root as never)).toBe("com.ohos.sceneboard");
    });

    it("returns undefined for a tree without any bundleName", () => {
        expect(pickForegroundBundleName(node() as never)).toBeUndefined();
    });
});

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
