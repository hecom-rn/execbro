// src/__tests__/unit/tap.test.ts
import { describe, it, expect } from "@jest/globals";
import type { ConnectedApp } from "../../core/types.js";
import {
    type TapQuery,
    type TapResult,
    type TapStrategy,
    type TapScreenshot,
    type TapVerification,
    buildQuery,
    getAvailableStrategies,
    hasProblematicUnicode,
    convertScreenshotToTapCoords,
    formatTapSuccess,
    formatTapFailure,
    buildVerificationExplanation,
    isTapTimeout,
} from "../../pro/tap.js";

describe("ConnectedApp type", () => {
    it("accepts platform and lastScreenshot fields", () => {
        const app: ConnectedApp = {
            ws: {} as any,
            deviceInfo: {
                id: "test",
                title: "Hermes React Native",
                description: "",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: "ws://localhost:8081",
                deviceName: "iPhone 16",
            },
            port: 8081,
            platform: "ios",
            lastScreenshot: {
                originalWidth: 1179,
                originalHeight: 2556,
                scaleFactor: 1,
            },
        };
        expect(app.platform).toBe("ios");
        expect(app.lastScreenshot?.originalWidth).toBe(1179);
    });

    it("allows lastScreenshot to be undefined", () => {
        const app: ConnectedApp = {
            ws: {} as any,
            deviceInfo: {
                id: "test",
                title: "Hermes React Native",
                description: "",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: "ws://localhost:8081",
                deviceName: "iPhone 16",
            },
            port: 8081,
            platform: "ios",
        };
        expect(app.lastScreenshot).toBeUndefined();
    });
});

describe("buildQuery", () => {
    it("builds query from text param", () => {
        const q = buildQuery({ text: "Submit" });
        expect(q).toEqual({ text: "Submit" });
    });
    it("builds query from coordinates", () => {
        const q = buildQuery({ x: 300, y: 600 });
        expect(q).toEqual({ x: 300, y: 600 });
    });
    it("builds query from multiple params", () => {
        const q = buildQuery({ text: "Submit", testID: "btn" });
        expect(q).toEqual({ text: "Submit", testID: "btn" });
    });
    it("builds query from all search params combined", () => {
        const q = buildQuery({ text: "Submit", testID: "btn", component: "Button" });
        expect(q).toEqual({ text: "Submit", testID: "btn", component: "Button" });
    });
    it("ignores non-query options like strategy and native", () => {
        const q = buildQuery({ text: "Submit", strategy: "fiber", native: true, verify: true });
        expect(q).toEqual({ text: "Submit" });
    });
    it("builds empty query from empty options", () => {
        const q = buildQuery({});
        expect(q).toEqual({});
    });
});

describe("hasProblematicUnicode", () => {
    it("returns false for ASCII text", () => {
        expect(hasProblematicUnicode("Submit")).toBe(false);
    });
    it("returns false for Polish accented text", () => {
        expect(hasProblematicUnicode("Potwierdź")).toBe(false);
    });
    it("returns false for Vietnamese accented text", () => {
        expect(hasProblematicUnicode("Tin nhắn")).toBe(false);
    });
    it("returns false for German umlauts", () => {
        expect(hasProblematicUnicode("Übersicht")).toBe(false);
    });
    it("returns false for French accented text", () => {
        expect(hasProblematicUnicode("Paramètres")).toBe(false);
    });
    it("returns false for Cyrillic text", () => {
        expect(hasProblematicUnicode("Отправить")).toBe(false);
    });
    it("returns false for Chinese text", () => {
        expect(hasProblematicUnicode("提交")).toBe(false);
    });
    it("returns false for Japanese text", () => {
        expect(hasProblematicUnicode("送信")).toBe(false);
    });
    it("returns true for emoji", () => {
        expect(hasProblematicUnicode("🔥")).toBe(true);
    });
    it("returns true for mixed text with emoji", () => {
        expect(hasProblematicUnicode("Save 🔥")).toBe(true);
    });
    it("returns true for flag emoji", () => {
        expect(hasProblematicUnicode("🇺🇸")).toBe(true);
    });
    it("returns true for zero-width joiner sequences", () => {
        expect(hasProblematicUnicode("👨‍👩‍👧")).toBe(true);
    });
    it("returns true for weather symbols", () => {
        expect(hasProblematicUnicode("☀")).toBe(true);
    });
});

describe("getAvailableStrategies", () => {
    it("returns accessibility-first for text query", () => {
        expect(getAvailableStrategies({ text: "Submit" }, "auto")).toEqual(["accessibility", "fiber"]);
    });
    it("includes fiber for non-ASCII accented text", () => {
        expect(getAvailableStrategies({ text: "Отправить" }, "auto")).toEqual(["accessibility", "fiber"]);
    });
    it("includes fiber for Polish text", () => {
        expect(getAvailableStrategies({ text: "Potwierdź" }, "auto")).toEqual(["accessibility", "fiber"]);
    });
    it("includes fiber for Vietnamese text", () => {
        expect(getAvailableStrategies({ text: "Tin nhắn" }, "auto")).toEqual(["accessibility", "fiber"]);
    });
    it("skips fiber for emoji text", () => {
        expect(getAvailableStrategies({ text: "🔥 Fire" }, "auto")).toEqual(["accessibility"]);
    });
    it("returns accessibility+fiber for testID", () => {
        expect(getAvailableStrategies({ testID: "btn" }, "auto")).toEqual(["accessibility", "fiber"]);
    });
    it("returns only fiber for component", () => {
        expect(getAvailableStrategies({ component: "Button" }, "auto")).toEqual(["fiber"]);
    });
    it("returns coordinate for x,y", () => {
        expect(getAvailableStrategies({ x: 100, y: 200 }, "auto")).toEqual(["coordinate"]);
    });
    it("returns single strategy when explicitly set with text query", () => {
        expect(getAvailableStrategies({ text: "Submit" }, "fiber")).toEqual(["fiber"]);
        expect(getAvailableStrategies({ text: "Submit" }, "accessibility")).toEqual(["accessibility"]);
    });
    it("returns single strategy when explicitly set without text", () => {
        expect(getAvailableStrategies({ testID: "btn" }, "fiber")).toEqual(["fiber"]);
    });
    it("returns accessibility+fiber for testID+text combo in auto mode", () => {
        expect(getAvailableStrategies({ testID: "btn", text: "Submit" }, "auto")).toEqual([
            "accessibility",
            "fiber",
        ]);
    });
    it("returns fallback chain for component+text in auto mode", () => {
        expect(getAvailableStrategies({ component: "Button", text: "OK" }, "auto")).toEqual([
            "accessibility",
            "fiber",
        ]);
    });
    it("returns coordinate only even when text is also provided", () => {
        expect(getAvailableStrategies({ x: 100, y: 200, text: "Submit" }, "auto")).toEqual(["coordinate"]);
    });
    it("returns fiber for explicit fiber with emoji text", () => {
        expect(getAvailableStrategies({ text: "🔥 Fire" }, "fiber")).toEqual(["fiber"]);
    });
});

describe("convertScreenshotToTapCoords", () => {
    it("converts iOS screenshot pixels to points (3x device)", () => {
        expect(convertScreenshotToTapCoords(300, 600, "ios", 3)).toEqual({ x: 100, y: 200 });
    });
    it("converts iOS screenshot pixels to points (2x iPad)", () => {
        expect(convertScreenshotToTapCoords(200, 400, "ios", 2)).toEqual({ x: 100, y: 200 });
    });
    it("undoes image downscaling before dividing by DPR", () => {
        expect(convertScreenshotToTapCoords(219, 438, "ios", 3, 1.368)).toEqual({ x: 100, y: 200 });
    });
    it("passes through for Android with no downscaling", () => {
        expect(convertScreenshotToTapCoords(300, 600, "android", 1)).toEqual({ x: 300, y: 600 });
    });
    it("undoes Android image downscaling", () => {
        expect(convertScreenshotToTapCoords(250, 500, "android", 1, 1.2)).toEqual({ x: 300, y: 600 });
    });
    it("rounds to integers", () => {
        expect(convertScreenshotToTapCoords(301, 599, "ios", 3)).toEqual({ x: 100, y: 200 });
    });
    it("handles origin coordinates (0, 0)", () => {
        expect(convertScreenshotToTapCoords(0, 0, "ios", 3)).toEqual({ x: 0, y: 0 });
        expect(convertScreenshotToTapCoords(0, 0, "android", 1)).toEqual({ x: 0, y: 0 });
    });
    it("handles large coordinates for high-res displays", () => {
        const result = convertScreenshotToTapCoords(3840, 2160, "ios", 3);
        expect(result.x).toBe(1280);
        expect(result.y).toBe(720);
    });
    it("handles scaleFactor=1 as no-op for downscaling", () => {
        expect(convertScreenshotToTapCoords(300, 600, "ios", 3, 1)).toEqual({ x: 100, y: 200 });
    });
});

describe("formatTapSuccess", () => {
    it("returns minimal success response", () => {
        const result = formatTapSuccess({
            method: "fiber",
            query: { text: "Submit" },
            pressed: "PrimaryButton",
            text: "Submit",
            path: "LoginScreen > Form > PrimaryButton",
        });
        expect(result.success).toBe(true);
        expect(result.method).toBe("fiber");
        expect(result.query).toEqual({ text: "Submit" });
    });
});

describe("formatTapFailure", () => {
    it("includes attempted strategies and suggestion", () => {
        const result = formatTapFailure({
            query: { text: "hamburger" },
            attempted: [{ strategy: "fiber", reason: "No match" }],
            suggestion: "Use screenshot",
        });
        expect(result.success).toBe(false);
        expect(result.attempted).toHaveLength(1);
        expect(result.suggestion).toBe("Use screenshot");
    });

    it("sets method to last attempted strategy for telemetry tracking", () => {
        const result = formatTapFailure({
            query: { text: "Submit" },
            attempted: [
                { strategy: "fiber", reason: "No match" },
                { strategy: "accessibility", reason: "No match" },
                { strategy: "ocr", reason: "OCR did not find text" },
            ],
            suggestion: "Use screenshot",
        });
        expect(result.method).toBe("ocr");
    });

    it("sets method to undefined when no strategies attempted", () => {
        const result = formatTapFailure({
            query: { text: "Submit" },
            attempted: [],
            suggestion: "Use screenshot",
        });
        expect(result.method).toBeUndefined();
    });
});

describe("formatTapSuccess with coordinate conversion info", () => {
    it("includes tappedAt and convertedTo when provided", () => {
        const result = formatTapSuccess({
            method: "fiber+native",
            query: { text: "Submit" },
            pressed: "PrimaryButton",
            tappedAt: { x: 300, y: 600 },
            convertedTo: { x: 100, y: 200, unit: "points" },
        });
        expect(result.tappedAt).toEqual({ x: 300, y: 600 });
        expect(result.convertedTo).toEqual({ x: 100, y: 200, unit: "points" });
        // platform was dropped from TapOptions in the device-targeting refactor;
        // formatTapSuccess no longer surfaces it as a top-level field.
    });

    it("includes device name when provided", () => {
        const result = formatTapSuccess({
            method: "accessibility",
            query: { testID: "btn" },
            pressed: "Button",
            device: "iPhone 16 Pro",
        });
        expect(result.device).toBe("iPhone 16 Pro");
    });
});

describe("formatTapSuccess with screenshot and verification", () => {
    it("includes screenshot field when provided", () => {
        const result = formatTapSuccess({
            method: "fiber",
            query: { text: "Submit" },
            pressed: "Button",
            screenshot: {
                image: "data:image/jpeg;base64,abc123",
                width: 1170,
                height: 2532,
                scaleFactor: 1.0,
            },
        });
        expect(result.success).toBe(true);
        expect(result.screenshot).toEqual({
            image: "data:image/jpeg;base64,abc123",
            width: 1170,
            height: 2532,
            scaleFactor: 1.0,
        });
    });

    it("includes verification field when provided", () => {
        const result = formatTapSuccess({
            method: "coordinate",
            query: { x: 300, y: 600 },
            verification: {
                meaningful: true,
                changeRate: 0.12,
                changedPixels: 48210,
                totalPixels: 2961720,
                explanation: "Tap caused a visible UI change (12.0% pixel diff). Something on screen responded; a pixel diff cannot identify which element, so this is not confirmation that the intended target handled it.",
            },
            screenshot: {
                image: "data:image/jpeg;base64,abc123",
                width: 1170,
                height: 2532,
                scaleFactor: 1.0,
            },
        });
        expect(result.verification).toEqual({
            meaningful: true,
            changeRate: 0.12,
            changedPixels: 48210,
            totalPixels: 2961720,
            explanation: "Tap caused a visible UI change (12.0% pixel diff). Something on screen responded; a pixel diff cannot identify which element, so this is not confirmation that the intended target handled it.",
        });
        expect(result.screenshot).toBeDefined();
    });

    it("omits screenshot and verification when not provided", () => {
        const result = formatTapSuccess({
            method: "fiber",
            query: { text: "Submit" },
        });
        expect(result.screenshot).toBeUndefined();
        expect(result.verification).toBeUndefined();
    });
});

describe("formatTapFailure with timeout error", () => {
    it("includes error field when timeout info is provided", () => {
        const result = formatTapFailure({
            query: { text: "Submit" },
            attempted: [
                { strategy: "fiber", reason: "fiber timed out after 5000ms" },
                { strategy: "accessibility", reason: "accessibility timed out after 3500ms" },
                { strategy: "ocr", reason: "Skipped — only 200ms remaining (budget 20000ms)" },
            ],
            error: "Tap timed out after 20000ms (budget 20000ms)",
            suggestion: "Use screenshot and retry",
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("timed out");
        expect(result.attempted).toHaveLength(3);
        expect(result.attempted![0].reason).toContain("timed out after 5000ms");
        expect(result.attempted![2].reason).toContain("Skipped");
    });

    it("uses default error message when no explicit error field", () => {
        const result = formatTapFailure({
            query: { text: "Submit" },
            attempted: [{ strategy: "fiber", reason: "No match" }],
            suggestion: "Try OCR",
        });
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        // Default error from buildErrorMessage, not timeout
        expect(result.error).not.toContain("timed out");
    });
});

describe("formatTapFailure with screenshot and verification", () => {
    it("includes warning when verification shows not meaningful", () => {
        const result = formatTapFailure({
            query: { x: 300, y: 600 },
            attempted: [{ strategy: "coordinate", reason: "executed" }],
            suggestion: "Retry with adjusted coordinates",
            verification: {
                meaningful: false,
                changeRate: 0.001,
                changedPixels: 312,
                totalPixels: 2961720,
                explanation: "No visual change detected between before and after screenshots. The element may not respond visually or the tap may have missed.",
            },
            screenshot: {
                image: "data:image/jpeg;base64,abc123",
                width: 1170,
                height: 2532,
                scaleFactor: 1.0,
            },
        });
        expect(result.verification?.meaningful).toBe(false);
        expect(result.screenshot).toBeDefined();
        expect(result.warning).toContain("no visual change detected");
    });
});

describe("buildVerificationExplanation", () => {
    it("explains persistent visual change", () => {
        const explanation = buildVerificationExplanation({
            meaningful: true, changeRate: 0.032, changedPixels: 32000, totalPixels: 1000000,
        });
        expect(explanation).toContain("visible UI change");
        expect(explanation).toContain("3.2%");
    });

    it("explains snap-back (tap burst with transient feedback)", () => {
        const explanation = buildVerificationExplanation({
            meaningful: false, changeRate: 0.001, changedPixels: 1000, totalPixels: 1000000,
            transientChangeDetected: true, peakChangeRate: 0.041, peakFrame: 2,
            kind: "snap_back",
        });
        expect(explanation).toContain("Transient visual feedback");
        expect(explanation).toContain("frame 2");
        expect(explanation).toContain("4.1%");
    });

    it("explains snap-back on swipe with scroll-fits-viewport hint", () => {
        const explanation = buildVerificationExplanation({
            meaningful: false, changeRate: 0.001, changedPixels: 1000, totalPixels: 1000000,
            transientChangeDetected: true, peakChangeRate: 0.021, peakFrame: 1,
            action: "swipe", kind: "snap_back",
        });
        expect(explanation).toContain("Snap-back detected");
        expect(explanation).toContain("contentSize vs layoutSize");
    });

    it("explains no change in standard mode", () => {
        const explanation = buildVerificationExplanation({
            meaningful: false, changeRate: 0.0, changedPixels: 0, totalPixels: 1000000,
        });
        expect(explanation).toContain("No visual change");
        expect(explanation).toContain("before and after");
    });

    it("explains no change in burst mode (missed)", () => {
        const explanation = buildVerificationExplanation({
            meaningful: false, changeRate: 0.0, changedPixels: 0, totalPixels: 1000000,
            transientChangeDetected: false, peakChangeRate: 0.001, peakFrame: 0,
            kind: "missed",
        });
        expect(explanation).toContain("No visual change");
        expect(explanation).toContain("burst frames");
    });
});

describe("getIOSDevicePixelRatio", () => {
    it("calculates DPR from screenshot width and accessibility root frame", async () => {
        const { calculateDPR } = await import("../../core/ios.js");
        // iPhone 3x: 1260px screenshot, 420pt root frame width
        expect(calculateDPR(1260, 420)).toBe(3);
        // iPad 2x: 2048px screenshot, 1024pt root frame width
        expect(calculateDPR(2048, 1024)).toBe(2);
        // iPhone SE 2x: 750px screenshot, 375pt root frame width
        expect(calculateDPR(750, 375)).toBe(2);
    });
});

describe("tap orchestrator", () => {
    it("validates that at least one search param is provided", async () => {
        const { tap } = await import("../../pro/tap.js");
        const result = await tap({});
        expect(result.success).toBe(false);
        expect(result.error).toContain("Must provide");
    });

    it("validates x and y are both provided for coordinate tap", async () => {
        const { tap } = await import("../../pro/tap.js");
        const result = await tap({ x: 100 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Both x and y");
    });

    // udid + platform=android conflict tests removed — both fields no longer
    // exist in TapOptions (collapsed into the unified `device` field). The
    // resolver disambiguates by identifier format (UDID → iOS, adb serial →
    // Android) so the conflict can't be constructed.

    it("surfaces ambiguous-device errors from getConnectedAppByDevice", async () => {
        const { tap } = await import("../../pro/tap.js");
        const { connectedApps } = await import("../../core/state.js");
        const WebSocket = (await import("ws")).default;
        connectedApps.clear();

        const fakeWs = { readyState: WebSocket.OPEN } as any;
        const make = (key: string, deviceName: string): ConnectedApp => ({
            ws: fakeWs,
            deviceInfo: {
                id: key,
                title: "Hermes React Native",
                description: "",
                appId: "com.test",
                type: "node",
                webSocketDebuggerUrl: `ws://localhost:8081/${key}`,
                deviceName,
            },
            port: 8081,
            platform: "ios",
        });
        connectedApps.set("a", make("a", "iPhone 17 Pro"));
        connectedApps.set("b", make("b", "iPhone 17 Pro Max"));

        const result = await tap({ text: "Submit", device: "iPhone 17" });
        connectedApps.clear();

        expect(result.success).toBe(false);
        // resolveDeviceTarget emits "matches multiple connected devices" for
        // registry-substring ambiguity. The previous getConnectedAppByDevice
        // wrapper said "Multiple devices match"; the new contract is more
        // explicit about where the conflict came from.
        expect(result.error).toContain("matches multiple connected devices");
    });
});

describe("verification thresholds", () => {
    it("buildVerificationExplanation describes meaningful change at 0.1%", () => {
        const explanation = buildVerificationExplanation({
            meaningful: true,
            changeRate: 0.001,
            changedPixels: 1842,
            totalPixels: 1842000,
        });
        expect(explanation).toContain("visible UI change");
    });

    it("buildVerificationExplanation describes no change at 0.03%", () => {
        const explanation = buildVerificationExplanation({
            meaningful: false,
            changeRate: 0.0003,
            changedPixels: 553,
            totalPixels: 1842000,
        });
        expect(explanation).toContain("No visual change");
    });
});

describe("formatTapFailure with all strategies exhausted", () => {
    it("includes all attempted strategies in order", () => {
        const result = formatTapFailure({
            query: { text: "Submit" },
            attempted: [
                { strategy: "accessibility", reason: "No iOS accessibility match" },
                { strategy: "fiber", reason: "pressElement failed" },
                { strategy: "ocr", reason: "OCR did not find text" },
            ],
            suggestion: "Take a screenshot and use coordinates",
        });
        expect(result.attempted).toHaveLength(3);
        expect(result.attempted![0].strategy).toBe("accessibility");
        expect(result.attempted![1].strategy).toBe("fiber");
        expect(result.attempted![2].strategy).toBe("ocr");
    });

    it("includes device name in failure response", () => {
        const result = formatTapFailure({
            query: { text: "Submit" },
            attempted: [{ strategy: "fiber", reason: "No match" }],
            suggestion: "Try OCR",
            device: "Pixel 7",
        });
        expect(result.device).toBe("Pixel 7");
    });
});


describe("isTapTimeout", () => {
    it("returns true when a strategy wrapper fired at its cap", () => {
        expect(
            isTapTimeout([
                { strategy: "fiber", reason: "fiber timed out after 5000ms" },
            ])
        ).toBe(true);
    });

    it("returns true when a later strategy was skipped due to exhausted budget", () => {
        expect(
            isTapTimeout([
                { strategy: "fiber", reason: "fiber timed out after 5000ms" },
                { strategy: "ocr", reason: "Skipped — only 200ms remaining (budget 20000ms)" },
            ])
        ).toBe(true);
    });

    it("returns false when strategy errored quickly with a nested sub-op timeout", () => {
        expect(
            isTapTimeout([
                { strategy: "fiber", reason: "CDP getProperties timed out after 150ms" },
            ])
        ).toBe(false);
    });

    it("returns false when no element was found and no strategy actually timed out", () => {
        expect(
            isTapTimeout([
                { strategy: "fiber", reason: "No element found matching testID=\"foo\"" },
            ])
        ).toBe(false);
    });

    it("returns false for an empty attempted list", () => {
        expect(isTapTimeout([])).toBe(false);
    });

    it("accepts accessibility and coordinate wrapper formats", () => {
        expect(
            isTapTimeout([{ strategy: "accessibility", reason: "accessibility timed out after 3000ms" }])
        ).toBe(true);
        expect(
            isTapTimeout([{ strategy: "coordinate", reason: "coordinate timed out after 3000ms" }])
        ).toBe(true);
    });
});

