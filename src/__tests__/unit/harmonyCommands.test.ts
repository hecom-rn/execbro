import { describe, it, expect } from "@jest/globals";

const {
    buildHdcArgs,
    buildShellArgs,
    HARMONY_KEY_EVENTS,
    escapeHarmonyShellText,
    parseHdcTargets,
    parseBmDumpList,
    parseScreenSize,
    remoteSnapshotPath
} = await import("../../core/harmony.js");

describe("hdc command builders", () => {
    it("buildHdcArgs emits -t only when a target key is given", () => {
        expect(buildHdcArgs()).toEqual([]);
        expect(buildHdcArgs("127.0.0.1:5555")).toEqual(["-t", "127.0.0.1:5555"]);
    });

    it("buildShellArgs scopes uitest uiInput commands to a target", () => {
        expect(buildShellArgs("k1", ["uitest", "uiInput", "click", "100", "200"]))
            .toEqual(["-t", "k1", "shell", "uitest", "uiInput", "click", "100", "200"]);
        expect(buildShellArgs(undefined, ["echo", "hi"]))
            .toEqual(["shell", "echo", "hi"]);
    });

    it("key event map covers the android_key_event baseline", () => {
        for (const key of ["BACK", "HOME", "ENTER", "DEL", "ESC", "POWER", "VOLUME_UP", "VOLUME_DOWN"]) {
            expect(typeof HARMONY_KEY_EVENTS[key]).toBe("string");
        }
        expect(HARMONY_KEY_EVENTS.BACK).toBe("Back");
    });

    it("escapeHarmonyShellText single-quotes for the device shell", () => {
        expect(escapeHarmonyShellText("hello")).toBe("'hello'");
        expect(escapeHarmonyShellText("it's")).toBe(`'it'"'"'s'`);
        expect(escapeHarmonyShellText("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    });

    it("remoteSnapshotPath is unique per call and inside the shared tmp dir", () => {
        const a = remoteSnapshotPath(1);
        const b = remoteSnapshotPath(2);
        expect(a).toMatch(/^\/data\/local\/tmp\/execbro_\d+_\d+\.jpeg$/);
        expect(a).not.toBe(b);
    });
});

describe("hdc output parsers", () => {
    it("parses plain `hdc list targets` output", () => {
        const out = "127.0.0.1:5555\n\nANW0219C23001234\t(Disconnected)\n";
        expect(parseHdcTargets(out)).toEqual([
            { key: "127.0.0.1:5555", state: "connected", kind: "emulator" },
            { key: "ANW0219C23001234", state: "disconnected", kind: "real" }
        ]);
    });

    it("returns [] for the empty-marker output", () => {
        expect(parseHdcTargets("[Empty]\n")).toEqual([]);
    });

    it("parses `bm dump -a` bundle lists", () => {
        const out = "com.huawei.hmos.settings\ncom.example.myapp\n\n  com.third.pad  \n";
        expect(parseBmDumpList(out)).toEqual([
            "com.huawei.hmos.settings",
            "com.example.myapp",
            "com.third.pad"
        ]);
    });

    it("parses screen size from hidumper RenderService output", () => {
        const out = `----------------------screen:0----------------------
activeMode:1080x2424, refreshRate=60
renderSize:1080x2424`;
        expect(parseScreenSize(out)).toEqual({ width: 1080, height: 2424 });
    });

    it("parses screen size from a wm-size-style fallback", () => {
        expect(parseScreenSize("Physical size:720x1280")).toEqual({ width: 720, height: 1280 });
        expect(parseScreenSize("nothing here")).toBeNull();
    });
});
