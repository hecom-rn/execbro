import { findDisconnectedDeviceName, getConnectedApps } from "./connection.js";
import { listAllDevices, resetDeviceDiscoveryCache } from "./deviceDiscovery.js";
import { listDevices, recordDevice } from "./projectMemory.js";
import type { DevicePlatform } from "./types.js";

export type DeviceTargetSource =
    | "registry"
    | "udid"
    | "adb-serial"
    | "name-match"
    | "default";

/** Which native backend can actually reach the resolved device, if any. */
export type NativeBinding = "adb" | "simctl" | "hdc" | "none";

export interface DeviceTarget {
    platform: DevicePlatform;
    iosUdid?: string;
    androidSerial?: string;
    deviceName: string;
    source: DeviceTargetSource;
    /** hdc target key when the resolved device is a HarmonyOS target. */
    harmonyTargetKey?: string;
    /**
     * Proves the resolved device is reachable by a native backend. "none"
     * means the app is only connected through Metro (both adbSerial and
     * simulatorUdid empty) — native tools must refuse it rather than let adb
     * fall through to its own default device, which on a multi-device setup
     * is a different physical screen (verified 2026-09-01: a harmony app
     * matching "emulator" by substring drove the attached Android emulator).
     * CDP-only tools ignore this field; they never touch a native backend.
     */
    nativeBinding?: NativeBinding;
}

export type DeviceResolverErrorCode =
    | "MULTIPLE_DEVICES_MATCH"
    | "NO_DEVICES_FOUND"
    | "DEVICE_NOT_FOUND"
    | "SIMULATOR_NOT_BOOTED"
    | "CONFLICTING_IDENTIFIERS"
    | "NATIVE_BACKEND_UNAVAILABLE";

/** Resolution failures that a stale device inventory could plausibly explain. */
const STALE_INVENTORY_RETRY_CODES = new Set<DeviceResolverErrorCode>([
    "NO_DEVICES_FOUND",
    "DEVICE_NOT_FOUND",
    "SIMULATOR_NOT_BOOTED"
]);

export interface DeviceResolverError {
    code: DeviceResolverErrorCode;
    message: string;
    candidates?: Array<{ name: string; platform: DevicePlatform; identifier: string }>;
}

export type ResolveResult =
    | { ok: true; target: DeviceTarget; note?: string }
    | { ok: false; error: DeviceResolverError };

export interface ResolveDeviceOptions {
    /**
     * Accept a simulator that is present in the inventory but not booted.
     * Opt-in, and used by exactly one caller: `ios_boot_simulator`, whose whole
     * job is booting a shut-down simulator. Without it, step 1 answered that
     * tool's own UDID with "not booted — boot it with ios_boot_simulator({...})",
     * i.e. the tool was told to call itself: 10 of 11 calls failed on that one
     * circular error in the 7d telemetry (2026-08-22). Every other tool needs a
     * device it can actually talk to, so the booted gate stays on by default.
     */
    allowShutdown?: boolean;
}

const UDID_REGEX = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ADB_SERIAL_REGEX = /^emulator-\d+$/;

/**
 * Lowercase and strip separators (whitespace, `_`, `-`) so substring matches
 * survive punctuation drift between caller input and the device's reported
 * name (e.g. "SM_A356N" vs "SM-A356N - 15 - API 35").
 */
function normalizeName(value: string | null | undefined): string {
    if (!value) return "";
    return value.toLowerCase().replace(/[\s_\-]+/g, "");
}

function err(
    code: DeviceResolverErrorCode,
    message: string,
    candidates?: DeviceResolverError["candidates"]
): ResolveResult {
    return { ok: false, error: { code, message, candidates } };
}

function ok(target: DeviceTarget, note?: string): ResolveResult {
    return note ? { ok: true, target, note } : { ok: true, target };
}

function nativeBindingOf(app: { simulatorUdid?: string; adbSerial?: string }): NativeBinding {
    if (app.simulatorUdid) return "simctl";
    if (app.adbSerial) return "adb";
    return "none";
}

/**
 * The error a NATIVE tool must return when its device hint resolved to an app
 * that no native backend can reach. Not part of STALE_INVENTORY_RETRY_CODES:
 * a fresh inventory will not change the app's binding.
 */
export function nativeBindingUnavailableError(target: DeviceTarget): DeviceResolverError {
    return {
        code: "NATIVE_BACKEND_UNAVAILABLE",
        message: `App "${target.deviceName}" is only connected through Metro and is not bound to any adb/simctl device, so native tools (screenshot, touch, keys, packages) cannot reach it. ` +
            "Use CDP-level tools instead (logs, network, get_screen_state, inspect_*, execute_in_app), or run the app on a managed device."
    };
}

/**
 * Guard for native tool paths: refuses a resolved target that no native
 * backend can reach. Call at every point that is about to shell out to
 * adb/simctl/hdc — a missing serial there would fall through to the backend's
 * own default device, which is not the device the caller asked about.
 */
export function checkNativeBackendAvailable(target: DeviceTarget): DeviceResolverError | null {
    return target.nativeBinding === "none" ? nativeBindingUnavailableError(target) : null;
}

/**
 * Render a DeviceResolverError as a single string suitable for tool responses.
 * Appends the candidates list when present so the agent can disambiguate
 * without an extra list_devices call.
 */
export function formatResolverError(error: DeviceResolverError): string {
    if (!error.candidates || error.candidates.length === 0) return error.message;
    const lines = error.candidates.map(
        (c) => `  - ${c.name} (${c.platform}) → device="${c.identifier}"`
    );
    return `${error.message}\nCandidates:\n${lines.join("\n")}`;
}

/**
 * Resolve a single `device` string (UDID, adb serial, RN-registry deviceName,
 * sim/emu name, or undefined) into a structured DeviceTarget.
 *
 * Resolution order:
 *   1. UDID format → iOS simulator lookup (errors if shutdown, unless `allowShutdown`).
 *   2. Exact adb serial match against attached emulators and physical devices.
 *   3. Substring match against the RN-connected registry.
 *   4. Substring match against booted iOS sims and online Android devices.
 *   5. No `device` argument → pick the single running device, or error.
 */
async function resolveDeviceTargetInner(
    device?: string,
    options: ResolveDeviceOptions = {}
): Promise<ResolveResult> {
    const trimmed = device?.trim();

    // Step 1: UDID match.
    if (trimmed && UDID_REGEX.test(trimmed)) {
        const inv = await listAllDevices();
        const sim = inv.ios.simulators.find((s) => s.udid.toLowerCase() === trimmed.toLowerCase());
        if (!sim) {
            return err(
                "DEVICE_NOT_FOUND",
                `No iOS simulator with UDID "${trimmed}". Call list_devices to see available identifiers.`
            );
        }
        if (sim.state !== "booted" && !options.allowShutdown) {
            return err(
                "SIMULATOR_NOT_BOOTED",
                `Simulator "${sim.name}" (${sim.udid}) is not booted. Boot it with ios_boot_simulator({ udid: "${sim.udid}" }).`
            );
        }
        return ok({
            platform: "ios",
            iosUdid: sim.udid,
            deviceName: sim.name,
            source: "udid",
            nativeBinding: "simctl"
        });
    }

    // Step 2: exact adb serial match.
    //
    // This step used to be gated on ADB_SERIAL_REGEX (`/^emulator-\d+$/`), which
    // only ever matches emulators. Real physical serials ("P2228K000422",
    // "29091FDH30061X") never reached serial resolution at all: they fell
    // through to step-3 substring matching against device *names* and died with
    // `"P2228K000422" did not match any connected RN app, booted simulator, or
    // attached Android device` — so the physical branch below was unreachable
    // for exactly the devices it was written for. 3 failures/wk in the 7d
    // telemetry, but a complete dead end for anyone on a physical Android
    // device (2026-08-22).
    //
    // The shape test is gone; what identifies a serial is that the inventory
    // actually reports it, so we probe for an exact match and fall through when
    // there is none. The extra probe is cheap: `listAllDevices` is cached with a
    // 30s TTL, and step 4 queries the same inventory anyway.
    if (trimmed) {
        const inv = await listAllDevices();
        const emu = inv.android.emulators.find((e) => e.serial === trimmed);
        if (emu) {
            // Prefer the RN registry's deviceName when an app is connected on
            // this serial — the registry name (e.g. "sdk_gphone16k_arm64 - 16 -
            // API 36") matches what every other code path emits; the AVD
            // identifier ("Pixel_9_-_16kb") is confusing as a response label.
            // OB2 (2026-05-20).
            const registryApp = getConnectedApps().find(
                (e) => e.app.platform === "android" && e.app.adbSerial === trimmed
            );
            return ok({
                platform: "android",
                androidSerial: trimmed,
                deviceName: registryApp?.app.deviceInfo.deviceName || emu.name,
                source: "adb-serial",
                nativeBinding: "adb"
            });
        }
        const phys = inv.android.physical.find((p) => p.serial === trimmed);
        if (phys) {
            const registryApp = getConnectedApps().find(
                (e) => e.app.platform === "android" && e.app.adbSerial === trimmed
            );
            return ok({
                platform: "android",
                androidSerial: trimmed,
                deviceName: registryApp?.app.deviceInfo.deviceName || phys.model,
                source: "adb-serial",
                nativeBinding: "adb"
            });
        }
        // No exact serial match. An `emulator-NNNN` argument is unambiguously a
        // serial and nothing else, so it keeps its precise error instead of
        // falling through to name matching and reporting a generic miss.
        if (ADB_SERIAL_REGEX.test(trimmed)) {
            return err(
                "DEVICE_NOT_FOUND",
                `No Android device with serial "${trimmed}". Call list_devices to see attached devices.`
            );
        }
    }

    // Step 3: Registry match (normalized-name equality first, substring as
    // fallback). A substring hit is accepted when unique but flagged — an
    // agent passing "emulator" while a device literally named "emulator" and
    // an "emulator-5554" are both connected must land on the exact one.
    if (trimmed) {
        const apps = getConnectedApps();
        const needle = normalizeName(trimmed);
        const hits = apps
            .map((entry) => ({ entry, name: normalizeName(entry.app.deviceInfo.deviceName) }))
            .filter(({ name }) => name.includes(needle));
        const exactHits = hits.filter(({ name }) => name === needle);
        const matches = exactHits.length > 0 ? exactHits : hits;
        if (matches.length === 1) {
            const m = matches[0].entry.app;
            let note: string | undefined;
            if (exactHits.length === 0) {
                note = `Matched device "${m.deviceInfo.deviceName}" by substring. Pass the full device name to rule out ambiguity.`;
            }
            // When the iOS app's UDID hasn't been backfilled yet (the
            // findSimulatorByName race during connection), look it up on
            // demand. Without this, downstream callers default to whichever
            // simulator simctl reports as active — which on a multi-sim
            // setup can be the OTHER device. Bug #5 (2026-05-20).
            let iosUdid = m.simulatorUdid;
            if (m.platform === "ios" && !iosUdid && m.deviceInfo.deviceName) {
                try {
                    const inv = await listAllDevices();
                    const sim = inv.ios.simulators.find(
                        (s) => s.state === "booted" && s.name === m.deviceInfo.deviceName
                    );
                    if (sim) iosUdid = sim.udid;
                } catch {
                    // best-effort; fall through with undefined udid
                }
            }
            return ok(
                {
                    platform: m.platform,
                    iosUdid,
                    androidSerial: m.adbSerial,
                    deviceName: m.deviceInfo.deviceName,
                    source: "registry",
                    nativeBinding: nativeBindingOf(m)
                },
                note
            );
        }
        if (matches.length > 1) {
            return err(
                "MULTIPLE_DEVICES_MATCH",
                `"${trimmed}" matches multiple connected devices. Pass a more specific identifier (full name, UDID, or adb serial).`,
                matches.map(({ entry: m }) => ({
                    name: m.app.deviceInfo.deviceName,
                    platform: m.app.platform,
                    identifier: m.app.simulatorUdid ?? m.app.adbSerial ?? m.app.deviceInfo.deviceName
                }))
            );
        }
    }

    // Step 4: OS-level name match.
    const inv = await listAllDevices();
    if (trimmed) {
        const needle = normalizeName(trimmed);
        const iosBootedMatches = inv.ios.simulators.filter(
            (s) => s.state === "booted" && normalizeName(s.name).includes(needle)
        );
        const androidRunningMatches = inv.android.emulators.filter(
            (e) => e.state === "running" && normalizeName(e.name).includes(needle)
        );
        const androidPhysicalMatches = inv.android.physical.filter(
            (p) => p.state === "device" && normalizeName(p.model).includes(needle)
        );

        const totalMatches =
            iosBootedMatches.length + androidRunningMatches.length + androidPhysicalMatches.length;

        if (totalMatches === 1) {
            if (iosBootedMatches.length === 1) {
                const s = iosBootedMatches[0];
                return ok({
                    platform: "ios",
                    iosUdid: s.udid,
                    deviceName: s.name,
                    source: "name-match",
                    nativeBinding: "simctl"
                });
            }
            if (androidRunningMatches.length === 1) {
                const e = androidRunningMatches[0];
                return ok({
                    platform: "android",
                    androidSerial: e.serial ?? undefined,
                    deviceName: e.name,
                    source: "name-match",
                    nativeBinding: "adb"
                });
            }
            const p = androidPhysicalMatches[0];
            return ok({
                platform: "android",
                androidSerial: p.serial,
                deviceName: p.model,
                source: "name-match",
                nativeBinding: "adb"
            });
        }
        if (totalMatches > 1) {
            const candidates = [
                ...iosBootedMatches.map((s) => ({ name: s.name, platform: "ios" as const, identifier: s.udid })),
                ...androidRunningMatches.map((e) => ({ name: e.name, platform: "android" as const, identifier: e.serial ?? e.name })),
                ...androidPhysicalMatches.map((p) => ({ name: p.model, platform: "android" as const, identifier: p.serial }))
            ];
            return err(
                "MULTIPLE_DEVICES_MATCH",
                `"${trimmed}" matches multiple devices. Pass a UDID or adb serial to disambiguate.`,
                candidates
            );
        }
        // Distinguish "never seen this name" from "this device was attached
        // earlier and has since dropped off" — the second reads as a typo
        // otherwise, and sends the reader to re-check their spelling instead of
        // the device.
        const dropped = findDisconnectedDeviceName(trimmed);
        if (dropped) {
            return err(
                "DEVICE_NOT_FOUND",
                `Device "${dropped.name}" DISCONNECTED — it was attached earlier in this session and is not reachable now. ` +
                `The name is correct; the device dropped off. Run scan_metro to re-attach, or list_devices to see whether ` +
                `the emulator/simulator is still running.`
            );
        }
        return err(
            "DEVICE_NOT_FOUND",
            `"${trimmed}" did not match any connected RN app, booted simulator, or attached Android device. Call list_devices to enumerate options.`
        );
    }

    // Step 5: No `device` argument — pick the single available device.
    const bootedSims = inv.ios.simulators.filter((s) => s.state === "booted");
    const runningEmus = inv.android.emulators.filter((e) => e.state === "running");
    const onlinePhys = inv.android.physical.filter((p) => p.state === "device");
    const totalRunning = bootedSims.length + runningEmus.length + onlinePhys.length;

    if (totalRunning === 0) {
        // Final fallback: if a single RN app is connected (e.g. physical iOS
        // not in simctl), use it.
        const apps = getConnectedApps();
        if (apps.length === 1) {
            const m = apps[0].app;
            return ok({
                platform: m.platform,
                iosUdid: m.simulatorUdid,
                androidSerial: m.adbSerial,
                deviceName: m.deviceInfo.deviceName,
                source: "default",
                nativeBinding: nativeBindingOf(m)
            });
        }
        return err(
            "NO_DEVICES_FOUND",
            "No devices found. Boot an iOS simulator or start an Android emulator, then retry."
        );
    }

    if (totalRunning > 1) {
        const candidates = [
            ...bootedSims.map((s) => ({ name: s.name, platform: "ios" as const, identifier: s.udid })),
            ...runningEmus.map((e) => ({ name: e.name, platform: "android" as const, identifier: e.serial ?? e.name })),
            ...onlinePhys.map((p) => ({ name: p.model, platform: "android" as const, identifier: p.serial }))
        ];

        try {
            const remembered = listDevices();
            for (const dev of remembered) {
                const match = candidates.find((c) => c.identifier === dev.identifier);
                if (match) {
                    const day = Number.isFinite(dev.lastUsedAt)
                        ? new Date(dev.lastUsedAt).toISOString().slice(0, 10)
                        : "unknown";
                    return {
                        ok: true,
                        note: `defaulted to ${match.name} (${match.identifier}) — last used ${day}; pass device= to override.`,
                        target: {
                            platform: match.platform,
                            iosUdid: match.platform === "ios" ? match.identifier : undefined,
                            androidSerial: match.platform === "android" ? match.identifier : undefined,
                            deviceName: match.name,
                            source: "default",
                            nativeBinding: match.platform === "ios" ? "simctl" : "adb",
                        },
                    };
                }
            }
        } catch {
            // Project-memory lookup must never break device resolution; fall
            // through to the existing MULTIPLE_DEVICES_MATCH error below.
        }

        return err(
            "MULTIPLE_DEVICES_MATCH",
            "Multiple devices available. Specify device='...'. Call list_devices to enumerate.",
            candidates
        );
    }

    if (bootedSims.length === 1) {
        const s = bootedSims[0];
        return ok({ platform: "ios", iosUdid: s.udid, deviceName: s.name, source: "default", nativeBinding: "simctl" });
    }
    if (runningEmus.length === 1) {
        const e = runningEmus[0];
        return ok({
            platform: "android",
            androidSerial: e.serial ?? undefined,
            deviceName: e.name,
            source: "default",
            nativeBinding: "adb"
        });
    }
    const p = onlinePhys[0];
    return ok({ platform: "android", androidSerial: p.serial, deviceName: p.model, source: "default", nativeBinding: "adb" });
}

/**
 * Public resolver: delegates to the inner resolution, then records the resolved
 * device to project memory (best-effort, never throws). The inner function also
 * consults project memory to auto-default on no-hint ambiguity (see Step 5).
 */
export async function resolveDeviceTarget(
    device?: string,
    options: ResolveDeviceOptions = {}
): Promise<ResolveResult> {
    let result = await resolveDeviceTargetInner(device, options);

    // The device inventory is cached (see deviceDiscovery), so a device booted
    // or plugged in moments ago can be missing from it. Every "I can't find it"
    // outcome is therefore retried once against a freshly queried inventory —
    // this is what makes the longer cache TTL safe: staleness can cost an extra
    // ~150ms on a genuine miss, but never a wrong answer.
    if (!result.ok && STALE_INVENTORY_RETRY_CODES.has(result.error.code)) {
        resetDeviceDiscoveryCache();
        result = await resolveDeviceTargetInner(device, options);
    }

    if (result.ok) {
        try {
            const t = result.target;
            const identifier = t.iosUdid ?? t.androidSerial ?? t.deviceName;
            let appId: string | undefined;
            try {
                appId = getConnectedApps().find(
                    (e) =>
                        e.app.simulatorUdid === identifier ||
                        e.app.adbSerial === identifier ||
                        e.app.deviceInfo.deviceName === t.deviceName,
                )?.app.deviceInfo.appId;
            } catch {
                // registry lookup is best-effort
            }
            recordDevice({ identifier, name: t.deviceName, platform: t.platform, appId });
        } catch {
            // recording must never affect resolution
        }
    }
    return result;
}
