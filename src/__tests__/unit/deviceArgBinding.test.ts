import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const resolveDeviceTargetMock = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("../../core/deviceResolver.js", () => ({
    resolveDeviceTarget: resolveDeviceTargetMock,
    formatResolverError: (e: { message: string }) => e.message,
    checkNativeBackendAvailable: (t: { nativeBinding?: string }) =>
        t.nativeBinding === "none"
            ? {
                  code: "NATIVE_BACKEND_UNAVAILABLE",
                  message: `App unbound`
              }
            : null
}));

const { resolveAndroidDeviceId, resolveIosUdid } = await import("../../tools/_deviceArg.js");

describe("native tool wrappers refuse unbound apps", () => {
    beforeEach(() => {
        resolveDeviceTargetMock.mockReset();
    });

    it("resolveAndroidDeviceId errors when the resolved app has no native binding", async () => {
        resolveDeviceTargetMock.mockResolvedValue({
            ok: true,
            target: {
                platform: "harmony",
                deviceName: "emulator",
                source: "registry",
                nativeBinding: "none"
            }
        });

        const r = await resolveAndroidDeviceId("emulator");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.response.content[0].text).toContain("unbound");
    });

    it("resolveAndroidDeviceId still returns undefined serial when NO hint was passed", async () => {
        // "Omit for first" is documented behaviour — the deliberate default
        // path, not an unbound-app fallthrough.
        resolveDeviceTargetMock.mockResolvedValue({ ok: false, error: { code: "X", message: "never called" } });

        const r = await resolveAndroidDeviceId(undefined);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.serial).toBeUndefined();
        expect(resolveDeviceTargetMock).not.toHaveBeenCalled();
    });

    it("resolveAndroidDeviceId passes through bound android targets", async () => {
        resolveDeviceTargetMock.mockResolvedValue({
            ok: true,
            target: {
                platform: "android",
                androidSerial: "emulator-5554",
                deviceName: "Pixel",
                source: "registry",
                nativeBinding: "adb"
            }
        });

        const r = await resolveAndroidDeviceId("Pixel");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.serial).toBe("emulator-5554");
    });

    it("resolveIosUdid errors when the resolved app has no native binding", async () => {
        resolveDeviceTargetMock.mockResolvedValue({
            ok: true,
            target: { platform: "harmony", deviceName: "emulator", source: "registry", nativeBinding: "none" }
        });

        const r = await resolveIosUdid("emulator");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.response.content[0].text).toContain("unbound");
    });
});
