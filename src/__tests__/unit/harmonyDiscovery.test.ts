import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const listHarmonyTargetsMock = jest.fn<() => Promise<unknown[]>>();
const isHdcAvailableMock = jest.fn<() => Promise<boolean>>();

jest.unstable_mockModule("../../core/harmony.js", () => ({
    listHarmonyTargets: listHarmonyTargetsMock,
    isHdcAvailable: isHdcAvailableMock
}));

const getConnectedAppsMock = jest.fn<() => Array<{ app: { platform: string; harmonyTargetKey?: string; deviceInfo: { deviceName: string } } }>>();
const findDisconnectedDeviceNameMock = jest.fn(() => null);
jest.unstable_mockModule("../../core/connection.js", () => ({
    getConnectedApps: getConnectedAppsMock,
    findDisconnectedDeviceName: findDisconnectedDeviceNameMock,
    createWebSocketWithOriginFallback: jest.fn(),
    getConnectedAppByDevice: jest.fn(),
    getConnectedAppBySimulatorUdid: jest.fn(),
    getConnectedAppByAndroidDeviceId: jest.fn(),
    getFirstConnectedApp: jest.fn(),
    connectToDevice: jest.fn(),
    clearReconnectionSuppression: jest.fn(),
    purgeStaleConnectionsForPorts: jest.fn()
}));
jest.unstable_mockModule("../../core/ios.js", () => ({
    listIOSSimulators: jest.fn(async () => ({ success: true, simulators: [] }))
}));
jest.unstable_mockModule("../../core/android.js", () => ({
    listAndroidDevices: jest.fn(async () => ({ success: true, devices: [] })),
    getAndroidEmulatorAvds: jest.fn(async () => []),
    getAdbIdForAvd: jest.fn(async () => null)
}));
jest.unstable_mockModule("../../core/projectMemory.js", () => ({
    recordDevice: jest.fn(),
    listDevices: jest.fn(() => []),
    recordScreenMetrics: jest.fn()
}));

const { listAllDevices } = await import("../../core/deviceDiscovery.js");
const { resolveDeviceTarget } = await import("../../core/deviceResolver.js");
const { resolveHarmonyTargetKey } = await import("../../tools/_deviceArg.js");

function noDevices() {
    return {
        ios: { available: true, simulators: [] },
        android: { available: true, emulators: [], physical: [] },
        summary: { booted: 0, total: 0 }
    };
}

function resetMocks() {
    listHarmonyTargetsMock.mockReset().mockResolvedValue([]);
    isHdcAvailableMock.mockReset().mockResolvedValue(false);
    getConnectedAppsMock.mockReset().mockReturnValue([]);
    findDisconnectedDeviceNameMock.mockReset().mockReturnValue(null);
}

describe("discoverHarmony in listAllDevices", () => {
    beforeEach(resetMocks);

    it("merges connected hdc targets into the inventory", async () => {
        isHdcAvailableMock.mockResolvedValue(true);
        listHarmonyTargetsMock.mockResolvedValue([
            { key: "127.0.0.1:5555", state: "connected", kind: "emulator" }
        ]);

        const inv = await listAllDevices({ refresh: true });
        expect(inv.harmony.available).toBe(true);
        expect(inv.harmony.targets).toHaveLength(1);
        expect(inv.harmony.targets[0].name).toBe("127.0.0.1:5555");
        expect(inv.summary.total).toBe(1);
        expect(inv.summary.booted).toBe(1);
    });

    it("reports available:false without throwing when hdc is absent", async () => {
        const inv = await listAllDevices({ refresh: true });
        expect(inv.harmony).toEqual({ available: false, targets: [] });
    });
});

describe("resolveDeviceTarget harmony addressing", () => {
    beforeEach(resetMocks);

    it("resolves an exact hdc target key", async () => {
        isHdcAvailableMock.mockResolvedValue(true);
        listHarmonyTargetsMock.mockResolvedValue([
            { key: "127.0.0.1:5555", state: "connected", kind: "emulator" }
        ]);

        const r = await resolveDeviceTarget("127.0.0.1:5555");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("harmony");
            expect(r.target.harmonyTargetKey).toBe("127.0.0.1:5555");
            expect(r.target.nativeBinding).toBe("hdc");
        }
    });

    it("defaults to the only connected hdc target when no hint is given", async () => {
        isHdcAvailableMock.mockResolvedValue(true);
        listHarmonyTargetsMock.mockResolvedValue([
            { key: "127.0.0.1:5555", state: "connected", kind: "emulator" }
        ]);

        const r = await resolveDeviceTarget(undefined);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.target.platform).toBe("harmony");
    });

    it("still reports binding 'none' for a registry harmony app with no linked target", async () => {
        getConnectedAppsMock.mockReturnValue([
            { app: { platform: "harmony", deviceInfo: { deviceName: "emulator" } } }
        ]);

        const r = await resolveDeviceTarget("emulator");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.target.nativeBinding).toBe("none");
    });
});

describe("resolveHarmonyTargetKey", () => {
    beforeEach(resetMocks);

    it("refuses to resolve a harmony hint to an unbound app", async () => {
        getConnectedAppsMock.mockReturnValue([
            { app: { platform: "harmony", deviceInfo: { deviceName: "emulator" } } }
        ]);
        const r = await resolveHarmonyTargetKey("emulator");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.response.content[0].text).toContain("not bound to any adb/simctl device");
    });

    it("passes through the hdc key for a bound harmony target", async () => {
        isHdcAvailableMock.mockResolvedValue(true);
        listHarmonyTargetsMock.mockResolvedValue([
            { key: "127.0.0.1:5555", state: "connected", kind: "emulator" }
        ]);

        const r = await resolveHarmonyTargetKey("127.0.0.1:5555");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.targetKey).toBe("127.0.0.1:5555");
    });
});
