import { describe, it, expect, jest, beforeEach } from "@jest/globals";

type RegistryEntry = {
    app: {
        platform: "ios" | "android" | "harmony";
        simulatorUdid?: string;
        adbSerial?: string;
        deviceInfo: { deviceName: string };
    };
};

const getConnectedAppsMock = jest.fn<() => RegistryEntry[]>();
const listAllDevicesMock = jest.fn<() => Promise<unknown>>();
const findDisconnectedDeviceNameMock =
    jest.fn<(device: string) => { name: string; lastSeenAt: number } | null>(() => null);

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
jest.unstable_mockModule("../../core/deviceDiscovery.js", () => ({
    listAllDevices: listAllDevicesMock,
    resetDeviceDiscoveryCache: jest.fn()
}));

const recordDeviceMock = jest.fn();
jest.unstable_mockModule("../../core/projectMemory.js", () => ({
    recordDevice: recordDeviceMock,
    listDevices: jest.fn<() => Array<never>>(() => []),
    recordScreenMetrics: jest.fn()
}));

const { resolveDeviceTarget } = await import("../../core/deviceResolver.js");

function emptyDiscovery() {
    return {
        ios: { available: true, simulators: [] },
        android: { available: true, emulators: [], physical: [] },
        summary: { booted: 0, total: 0 }
    };
}

function harmonyApp(deviceName = "emulator"): RegistryEntry {
    return {
        app: {
            platform: "harmony",
            deviceInfo: { deviceName }
        }
    };
}

describe("native binding computation in resolveDeviceTarget", () => {
    beforeEach(() => {
        getConnectedAppsMock.mockReset();
        listAllDevicesMock.mockReset();
        getConnectedAppsMock.mockReturnValue([]);
        listAllDevicesMock.mockResolvedValue(emptyDiscovery());
        recordDeviceMock.mockReset();
    });

    it("reports nativeBinding 'none' for a registry app bound to no managed device", async () => {
        getConnectedAppsMock.mockReturnValue([harmonyApp()]);

        const r = await resolveDeviceTarget("emulator");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("harmony");
            expect(r.target.nativeBinding).toBe("none");
            expect(r.target.androidSerial).toBeUndefined();
        }
    });

    it("reports nativeBinding 'adb' for a registry app with an adb serial", async () => {
        getConnectedAppsMock.mockReturnValue([
            {
                app: {
                    platform: "android",
                    adbSerial: "emulator-5554",
                    deviceInfo: { deviceName: "Pixel_10_Pro_XL" }
                }
            }
        ]);

        const r = await resolveDeviceTarget("Pixel");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.target.nativeBinding).toBe("adb");
    });

    it("reports nativeBinding 'simctl' for a registry app with a simulator udid", async () => {
        getConnectedAppsMock.mockReturnValue([
            {
                app: {
                    platform: "ios",
                    simulatorUdid: "12345678-1234-1234-1234-123456789012",
                    deviceInfo: { deviceName: "iPhone 17 Pro" }
                }
            }
        ]);

        const r = await resolveDeviceTarget("iPhone");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.target.nativeBinding).toBe("simctl");
    });

    it("prefers an exact normalized name match over a substring match", async () => {
        getConnectedAppsMock.mockReturnValue([
            harmonyApp("emulator"),
            {
                app: {
                    platform: "android",
                    adbSerial: "emulator-5554",
                    deviceInfo: { deviceName: "emulator-5554" }
                }
            }
        ]);

        const r = await resolveDeviceTarget("emulator");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.target.platform).toBe("harmony");
            expect(r.target.nativeBinding).toBe("none");
        }
    });

    it("warns when the match came from a substring hit", async () => {
        getConnectedAppsMock.mockReturnValue([
            {
                app: {
                    platform: "android",
                    adbSerial: "P2228K000422",
                    deviceInfo: { deviceName: "Pixel 10 Pro XL - API 35" }
                }
            }
        ]);

        const r = await resolveDeviceTarget("pixel");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.note).toBeTruthy();
            expect(r.note).toMatch(/substring/i);
        }
    });

    it("still errors when only substring matches and several registry apps hit", async () => {
        getConnectedAppsMock.mockReturnValue([harmonyApp("emulator-pro"), harmonyApp("emulator-max")]);

        const r = await resolveDeviceTarget("emulator");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("MULTIPLE_DEVICES_MATCH");
    });

    it("keeps resolving unbound apps so CDP-only tools can address them", async () => {
        // The resolver itself must not fail for an unbound app — execute_in_app
        // and other CDP tools address the app by device name through this path.
        getConnectedAppsMock.mockReturnValue([harmonyApp()]);
        const r = await resolveDeviceTarget("emulator");
        expect(r.ok).toBe(true);
    });
});
