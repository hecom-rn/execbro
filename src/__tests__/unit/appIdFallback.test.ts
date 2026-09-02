import { describe, it, expect } from "@jest/globals";

const { displayAppId } = await import("../../core/appDetection.js");

describe("displayAppId", () => {
    it("passes through a real app id", () => {
        expect(displayAppId("com.example.app")).toEqual({ appId: "com.example.app", fallback: false });
    });

    it("falls back to the device name for undefinedAppName@ blobs", () => {
        const r = displayAppId("undefinedAppName@2026-09-01T09:42:49.256Z", "emulator");
        expect(r).toEqual({ appId: "emulator", fallback: true });
    });

    it("handles a missing id", () => {
        expect(displayAppId(undefined, "Pixel")).toEqual({ appId: "Pixel", fallback: true });
        expect(displayAppId(undefined)).toEqual({ appId: "unknown", fallback: true });
    });
});
