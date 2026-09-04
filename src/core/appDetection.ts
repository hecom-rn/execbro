import WebSocket from "ws";
import { getNextMessageId } from "./state.js";
import type { AppDetectionResult, ConnectedApp, DevicePlatform } from "./types.js";

const DETECTION_TIMEOUT_MS = 3000;
const DETECTION_DELAY_MS = 500;

// Detection expression — synchronous IIFE (awaitPromise does not work reliably with Hermes CDP).
// Runs after a 500ms delay (see scheduleAppDetection) so the RN module system is initialized.
// Fallback paths for PlatformConstants:
// 1. nativeModuleProxy.PlatformConstants (Bridgeless / New Arch)
// 2. __turboModuleProxy('PlatformConstants') (TurboModules)
// 3. __fbBatchedBridgeConfig.remoteModuleConfig (Old Arch Bridge — inlined constants)
// 4. nativeRequireModuleConfig (Old Arch Bridge — lazy load)
// Always returns arch/engine even when version is unavailable.
const DETECTION_EXPRESSION = `(function(){
var r={},c=null,p=globalThis.nativeModuleProxy;
if(p&&p.PlatformConstants){c=typeof p.PlatformConstants.getConstants==='function'?p.PlatformConstants.getConstants():p.PlatformConstants}
if(!c&&typeof globalThis.__turboModuleProxy==='function'){try{var tm=globalThis.__turboModuleProxy('PlatformConstants');if(tm)c=typeof tm.getConstants==='function'?tm.getConstants():tm}catch(e){}}
if(!c){var bc=globalThis.__fbBatchedBridgeConfig;if(bc&&bc.remoteModuleConfig){for(var i=0;i<bc.remoteModuleConfig.length;i++){var mc=bc.remoteModuleConfig[i];if(mc&&mc[0]==='PlatformConstants'&&mc[1]){c=mc[1];break}}}}
if(!c&&typeof globalThis.nativeRequireModuleConfig==='function'){try{var nc=globalThis.nativeRequireModuleConfig('PlatformConstants');if(typeof nc==='string')nc=JSON.parse(nc);if(nc&&nc[1])c=nc[1]}catch(e){}}
if(c){if(c.reactNativeVersion)r.rnVersion=c.reactNativeVersion;if(c.osVersion)r.osVersion=c.osVersion;if(c.systemName)r.systemName=c.systemName;if(c.os)r.os=c.os}
r.newArch=typeof globalThis.nativeFabricUIManager==='object';
r.hermes=typeof globalThis.HermesInternal!=='undefined';
var ep=p&&p.ExpoConstants;if(!ep&&typeof globalThis.__turboModuleProxy==='function'){try{ep=globalThis.__turboModuleProxy('ExpoConstants')}catch(e){}}
if(ep){try{var ec=typeof ep.getConstants==='function'?ep.getConstants():ep;if(ec&&ec.expoConfig&&ec.expoConfig.sdkVersion)r.expoSdk=ec.expoConfig.sdkVersion}catch(e){}}
return r})()`;

function formatVersion(v: { major: number; minor: number; patch: number }): string {
    return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Readable app id for display (get_apps, tool banners). Metro's inspector
 * proxy synthesizes "undefinedAppName@<ts>" when the app never reports its
 * name — every harmony bundle did this as of RN 0.77.1/RNOH. Fall back to
 * the device name and say so, rather than showing a generated blob.
 */
export function displayAppId(
    appId: string | undefined,
    deviceName?: string
): { appId: string; fallback: boolean } {
    if (appId && !appId.startsWith("undefinedAppName@")) return { appId, fallback: false };
    if (deviceName) return { appId: deviceName, fallback: true };
    return { appId: "unknown", fallback: true };
}

/**
 * Platform from the raw `PlatformConstants.os` string. RNOH (react-native-harmony)
 * reports "harmony" here; a value we do not recognise leaves the caller's
 * platform untouched — a compat layer that masks the OS must not be guessed at.
 */
export function platformFromRawOs(os: string | undefined): DevicePlatform | null {
    if (!os) return null;
    const v = os.toLowerCase();
    if (v.includes("harmony") || v.includes("ohos")) return "harmony";
    if (v === "ios") return "ios";
    if (v === "android") return "android";
    return null;
}

export function parseDetectionResult(
    raw: {
        rnVersion?: { major: number; minor: number; patch: number };
        osVersion?: string;
        systemName?: string;
        /** Raw PlatformConstants.os — RNOH reports "harmony" here (verify on device, V1). */
        os?: string;
        newArch?: boolean;
        hermes?: boolean;
        expoSdk?: string;
    } | null,
    platform: DevicePlatform
): AppDetectionResult | null {
    if (!raw) return null;
    // Accept partial results — arch/engine are always detectable even when
    // PlatformConstants is unavailable (e.g., Old Arch without nativeModuleProxy)
    if (raw.newArch === undefined && raw.hermes === undefined && !raw.rnVersion) return null;

    return {
        reactNativeVersion: raw.rnVersion ? formatVersion(raw.rnVersion) : "unknown",
        architecture: raw.newArch ? "new" : "old",
        jsEngine: raw.hermes ? "hermes" : "jsc",
        appPlatform: platformFromRawOs(raw.os) ?? platform,
        osVersion: raw.osVersion || "unknown",
        ...(raw.expoSdk ? { expoSdkVersion: raw.expoSdk } : {}),
    };
}

/**
 * Presumptive detection from Metro /json DeviceInfo — no JS eval required.
 * Metro's inspector endpoint only lists RN JS runtimes, so the very fact that
 * a device appears there is proof of an RN app. Description/title strings
 * reliably identify Bridgeless (new arch) and Hermes setups.
 */
function inferPresumptiveDetection(app: ConnectedApp): AppDetectionResult {
    const desc = app.deviceInfo.description || "";
    const title = app.deviceInfo.title || "";
    return {
        reactNativeVersion: "unknown",
        architecture: desc.includes("Bridgeless") ? "new" : "old",
        jsEngine: title.includes("Hermes") ? "hermes" : "jsc",
        appPlatform: app.platform,
        osVersion: "unknown",
        detectionSource: "device-info",
    };
}

/**
 * Detect app characteristics via Runtime.evaluate CDP command.
 * Fire-and-forget — does not block connection flow.
 * Stores result on the ConnectedApp object.
 *
 * Emits a presumptive `app_detected` event immediately from DeviceInfo so the
 * RN signal is recorded even when the Runtime.evaluate probe later times out
 * or returns a partial result. The probe still runs and upgrades the stored
 * result when it succeeds.
 */
export function scheduleAppDetection(app: ConnectedApp): void {
    // Probe already succeeded — nothing to do.
    if (app.appDetection?.detectionSource === "probe") return;

    // Fire presumptive event once per ConnectedApp so the user is classified as
    // RN at the moment of connect, independent of probe success.
    if (!app.appDetection) {
        app.appDetection = inferPresumptiveDetection(app);
    }

    app.appDetectionPromise = new Promise<void>((resolve) => {
        setTimeout(async () => {
            try {
                const result = await detectApp(app.ws);
                if (result) {
                    const parsed = parseDetectionResult(result, app.platform);
                    if (parsed) {
                        parsed.detectionSource = "probe";
                        app.appDetection = parsed;
                        // The probe read the app's own PlatformConstants — trust it
                        // over the connect-time default (which is "android" for
                        // every app until a sim/adb link upgrades it).
                        app.platform = parsed.appPlatform;
                        if (!app.adbSerial && !app.simulatorUdid) {
                            // Link/correlate an hdc target only when exactly one
                            // qualifies — with several, correlation is a guess,
                            // and a wrong key points native tools at the wrong
                            // device.
                            void import("./harmony.js")
                                .then(async (h) => {
                                    if (parsed.appPlatform === "harmony") {
                                        const targets = await h.listHarmonyTargets();
                                        if (targets.length === 1) app.harmonyTargetKey = targets[0].key;
                                        return;
                                    }
                                    // PlatformConstants unreachable from JS (RNOH
                                    // 0.77: empty proxy object, require undefined) —
                                    // fall back to the RNOH hilog marker.
                                    const rnohKey = await h.detectRnohTarget();
                                    if (rnohKey) {
                                        app.platform = "harmony";
                                        app.harmonyTargetKey = rnohKey;
                                        console.error(`[execbro] HarmonyOS detected via RNOH hilog marker: ${rnohKey}`);
                                    }
                                })
                                .catch(() => {});
                        }
                        const versionStr = parsed.reactNativeVersion !== "unknown"
                            ? `RN ${parsed.reactNativeVersion}, ` : "";
                        console.error(
                            `[execbro] App detected: ${versionStr}${parsed.architecture} arch, ${parsed.jsEngine}, ${parsed.appPlatform} ${parsed.osVersion}`
                        );
                    }
                }
            } catch (e) {
                console.error(`[execbro] App detection failed: ${e}`);
            } finally {
                resolve();
            }
        }, DETECTION_DELAY_MS);
    });
}

/**
 * Await an in-flight scheduleAppDetection probe, racing it against `timeoutMs`.
 * Resolves when the probe finishes OR the timeout elapses — never throws and
 * never blocks longer than `timeoutMs`. No-op when no probe is pending or the
 * stored result is already a probe success.
 */
export function awaitAppDetection(app: ConnectedApp, timeoutMs: number): Promise<void> {
    if (!app.appDetectionPromise) return Promise.resolve();
    if (app.appDetection?.detectionSource === "probe") return Promise.resolve();
    return Promise.race([
        app.appDetectionPromise,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

function detectApp(ws: WebSocket): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
        if (ws.readyState !== WebSocket.OPEN) {
            resolve(null);
            return;
        }

        const messageId = getNextMessageId();
        const timeout = setTimeout(() => {
            ws.removeListener("message", handler);
            resolve(null);
        }, DETECTION_TIMEOUT_MS);

        function handler(data: WebSocket.Data) {
            try {
                const message = JSON.parse(data.toString());
                if (message.id !== messageId) return;

                ws.removeListener("message", handler);
                clearTimeout(timeout);

                if (message.result?.result?.value) {
                    resolve(message.result.result.value);
                } else {
                    resolve(null);
                }
            } catch {
                // Ignore non-JSON messages
            }
        }

        ws.on("message", handler);

        ws.send(
            JSON.stringify({
                id: messageId,
                method: "Runtime.evaluate",
                params: {
                    expression: DETECTION_EXPRESSION,
                    returnByValue: true,
                    userGesture: true,
                    generatePreview: false,
                },
            })
        );
    });
}
