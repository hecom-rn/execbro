import { describe, it, expect } from "@jest/globals";

const { platformFromRawOs, parseDetectionResult } = await import("../../core/appDetection.js");

describe("platformFromRawOs", () => {
    it("maps harmony-ish raw os values to harmony", () => {
        expect(platformFromRawOs("harmony")).toBe("harmony");
        expect(platformFromRawOs("HarmonyOS")).toBe("harmony");
        expect(platformFromRawOs("openharmony")).toBe("harmony");
        expect(platformFromRawOs("ohos")).toBe("harmony");
    });

    it("maps known platforms and leaves unknown values alone", () => {
        expect(platformFromRawOs("ios")).toBe("ios");
        expect(platformFromRawOs("android")).toBe("android");
        expect(platformFromRawOs("windows")).toBeNull();
        expect(platformFromRawOs(undefined)).toBeNull();
    });
});

describe("parseDetectionResult", () => {
    const base = { newArch: true, hermes: true };

    it("upgrades appPlatform to harmony when PlatformConstants.os says so", () => {
        const r = parseDetectionResult({ ...base, os: "harmony", rnVersion: { major: 0, minor: 77, patch: 1 } }, "android");
        expect(r?.appPlatform).toBe("harmony");
    });

    it("keeps the connect-time platform when raw os is absent or unrecognised", () => {
        const a = parseDetectionResult({ ...base, rnVersion: { major: 0, minor: 77, patch: 1 } }, "android");
        expect(a?.appPlatform).toBe("android");
        const b = parseDetectionResult({ ...base, os: "weirdos", rnVersion: { major: 0, minor: 77, patch: 1 } }, "ios");
        expect(b?.appPlatform).toBe("ios");
    });
});
