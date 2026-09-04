import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ============================================================================
// Local helpers that outlived the telemetry/metering removal
// ============================================================================
//
// This module used to carry the analytics pipeline (PostHog, the telemetry
// worker dispatch) and the free-tier metering heartbeat. Both are gone; what
// remains are the product-side helpers other modules still import.

// Kept for failureArtifact's upload path, which is hard-disabled via
// isArtifactCaptureEnabled() but left in place for easy re-enable.
const TELEMETRY_ENDPOINT = "https://rn-debugger-telemetry.500griven.workers.dev";
const TELEMETRY_API_KEY = "6a630181cb391ed5c42a188428cc2d2623dfe9333ec048193bb711ab58afe85e";

export function getTelemetryEndpoint(): string { return TELEMETRY_ENDPOINT; }
export function getTelemetryApiKey(): string { return TELEMETRY_API_KEY; }

// Read version from package.json dynamically
export function getServerVersion(): string {
    try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const pkgPath = join(__dirname, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.version || "unknown";
    } catch {
        return "unknown";
    }
}

type ErrorCategory = 'network' | 'timeout' | 'validation' | 'execution' | 'connection' | 'driver_missing' | 'screen_changed' | 'bad_target' | 'unknown';

export function categorizeError(errorMessage: string, errorContext?: string): ErrorCategory {
    const lower = errorMessage.toLowerCase();
    // UI driver not installed — must be checked before 'validation' which matches 'missing'/'install'.
    // Covers iOS (idb/axe) and Android (adb): on Android, ADB plays the same role as a UI driver
    // (required for accessibility enumeration, screenshots, and input). Treating it identically keeps
    // the "driver_missing" bucket platform-agnostic and prevents these from polluting tap-tool error rates.
    if (lower.includes('not installed') && (lower.includes('idb') || lower.includes('axe') || lower.includes('ui driver') || lower.includes('adb'))) {
        return 'driver_missing';
    }
    // Strategy chain may contain driver-missing signals even when the primary error
    // message doesn't (e.g., strategies skipped due to missing driver, last-resort
    // strategy fails with "No element found" or "timed out")
    if (errorContext) {
        const ctxLower = errorContext.toLowerCase();
        if (ctxLower.includes('ios ui driver is not instal') || ctxLower.includes('idb is not instal') || ctxLower.includes('adb is not installed') || ctxLower.includes('adb is not in path')) {
            return 'driver_missing';
        }
    }
    // The screen moved under the agent — someone was using the app in parallel,
    // so the target genuinely was not there to hit. An explicit self-tag, never
    // inferred from prose, emitted by core/screenStaleness.ts. Deliberately
    // ranked below driver_missing (a missing driver is the realer cause when
    // both appear) and above everything else, because otherwise these land in
    // 'validation' and inflate the failure rate of a tool that did nothing
    // wrong — the same reasoning that gave driver_missing its own bucket.
    if (errorContext?.includes('screen_changed:')) {
        return 'screen_changed';
    }
    // The agent named a target the screen does not uniquely offer. The tool ran,
    // resolved, refused to write, and handed back the fields that ARE there —
    // one half of a two-step protocol, not a fault, and nothing a fix on our
    // side would remove. Its own bucket for the same reason driver_missing and
    // screen_changed have one: on 2026-08-10 these were 11 of 16 input_text
    // "tool errors", which put a real device disconnect and a real focus miss
    // in the same pile as an agent mistyping a testID.
    //
    // Deliberately NOT here: "no focused TextInput" (the tool could have
    // resolved a sole field and now does) and "no TextInput found on screen"
    // (zero inputs mounted is app/screen state, and is also what a broken fiber
    // walk looks like — that has to stay visible in the tool's own rate).
    //
    // Ranked above the generic prose rules on purpose: these messages carry the
    // screen's own placeholders and labels, so a field labelled "Socket URL" or
    // "Invalid code" would otherwise be categorised by the app's copy.
    if (lower.includes('matched that target') || lower.includes('match this target') ||
        lower.includes('is out of range')) {
        return 'bad_target';
    }
    // Genuine JS runtime faults — the only signal that means "something actually
    // broke at runtime". Checked before 'network' because that rule matches the
    // bare substring 'fetch', which would swallow "TypeError: fetch is not a
    // function", and before the Hermes guards below so a real fault inside an
    // evaluated expression is not mistaken for an unsupported-syntax rejection.
    if (lower.includes('typeerror') || lower.includes('referenceerror') || lower.includes('rangeerror') ||
        lower.includes('is not a function') || lower.includes('is not defined') ||
        lower.includes('cannot read propert') || lower.includes('maximum call stack') ||
        lower.includes('is not an object')) {
        return 'execution';
    }
    if (lower.includes('websocket') || lower.includes('econnrefused') || lower.includes('socket') || lower.includes('fetch')) {
        return 'network';
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
        return 'timeout';
    }
    // Hermes eval guards. These reject an unsupported expression before anything
    // runs, so they are agent-input mistakes, not runtime faults — but they say
    // "Hermes Runtime.evaluate", which the generic execution rule below matches.
    // In the 30d window ending 2026-08-01 that misfire was the *entire* contents
    // of the execution category (203 events), hiding real faults in 'unknown'.
    if (lower.includes('hermes') && (lower.includes('not supported') || lower.includes('not available'))) {
        return 'validation';
    }
    // Check connection errors before validation (since "no debuggable devices found" contains "no")
    if (lower.includes('no apps connected') || lower.includes('scan_metro') || lower.includes('not connected') ||
        lower.includes('no debuggable devices') || lower.includes('no metro server') || lower.includes('connection failed')) {
        return 'connection';
    }
    // App-state / environment problems: the tooling is fine, the app or device
    // is not in a usable state. Grouped with 'connection' rather than earning a
    // new category so the existing dashboard blob6 mapping stays valid.
    // 'devtools hook' rather than 'react devtools hook': the injected-path error
    // is the bare "no devtools hook", which the longer literal missed — those
    // events sat in 'unknown' alongside the agent-input guards below.
    if (lower.includes('devtools hook') || lower.includes('no android device connected') ||
        lower.includes('no ios device connected') || lower.includes('app is not available')) {
        return 'connection';
    }
    // A native helper ran and failed (as opposed to being absent — driver_missing
    // above already claimed that case). Real execution faults, and the ones most
    // likely to be environment-specific and unreproducible locally.
    if (lower.includes('command failed:')) {
        return 'execution';
    }
    // Syntax/compilation errors in JS code
    if (lower.includes('compiling js failed') || lower.includes('syntaxerror')) {
        return 'validation';
    }
    // Agent-input and UI-state guards: the tool refused before doing anything
    // because the request did not describe a reachable target. Placed after the
    // connection checks so "No connected device matches …" only lands here when
    // devices *are* connected and the name simply did not match — when nothing
    // is connected the message carries the scan_metro hint and is a connection
    // problem instead.
    // input_text's targeting guards belong here too. The tool refused before
    // writing anything and returned the fields that ARE on screen, so the next
    // call can name one — a two-step protocol, not a fault. Left uncategorised
    // they were 29 of 35 input_text failures on 2.6.1, which hid the real ones.
    if (lower.includes('no focused textinput') || lower.includes('must provide at least one') ||
        lower.includes('not visible on screen') || lower.includes('no component found') ||
        lower.includes('no connected device matches') || lower.includes('redux-shaped store') ||
        lower.includes('no textinput found on screen')) {
        return 'validation';
    }
    if (lower.includes('invalid') || lower.includes('required') || lower.includes('missing')) {
        return 'validation';
    }
    if (lower.includes('evaluate') || lower.includes('execution') || lower.includes('runtime')) {
        return 'execution';
    }
    // Tap element-not-found errors
    if (lower.includes('no element found') || lower.includes('no pressable') || lower.includes('no focusable')) {
        return 'validation';
    }
    // Tap connection errors (different message format from other tools)
    if (lower.includes('no connected app') || lower.includes('connect_metro first') || lower.includes('auto-connect failed')) {
        return 'connection';
    }
    return 'unknown';
}
