import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordToolCall } from "./screenStaleness.js";
import { shouldShowFeedbackHint, markFeedbackHintShown, pushLogBox } from "./index.js";
import { redactSecrets, redactionEnabled } from "./redact.js";

// Tools that do NOT require an active Metro connection — excluded from feedback hint trigger
const NON_METRO_TOOLS = new Set([
    "scan_metro",
    "connect_metro",
    "disconnect_metro",
    "ensure_connection",
    "get_connection_status",
    "get_usage_guide",
    "get_apps",
    "list_devices",
    "ios_boot_simulator",
    "ios_launch_app",
    "android_launch_app",
    "send_feedback"
]);

// Registry for dev meta-tool — stores handlers and configs for dynamic dispatch.
// Also exported so unit tests can enumerate every registered tool without booting
// the server. Populated by registerToolWithTelemetry AND by the server.registerTool
// interceptor installed below, so it captures every registration site.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const toolRegistry = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();

// Interceptor: capture every direct server.registerTool call into toolRegistry so
// tests and the dev meta-tool see the full surface (including platform-native tools
// and the dev meta-tool itself that bypass registerToolWithTelemetry).
export function installToolRegistryInterceptor(server: McpServer): void {
    const _originalRegisterTool = server.registerTool.bind(server);
    (server as any).registerTool = (name: string, config: any, handler: any) => {
        toolRegistry.set(name, { config, handler });
        return _originalRegisterTool(name, config, handler);
    };
}

// The name is historical: this wrapper no longer reports telemetry. It now only
// keeps the per-invocation side effects that are product behaviour — screen
// staleness attribution and the first-install feedback hint — and propagates
// handler results/exceptions unchanged.
export function registerToolWithTelemetry(
    server: McpServer,
    toolName: string,
    config: any,
    handler: (args: any) => Promise<any>,
    emptyResultDetector?: (result: any) => boolean,
): void {
    void emptyResultDetector;
    toolRegistry.set(toolName, { config, handler });
    server.registerTool(toolName, config, async (args: any) => {
        try {
            const result = await handler(args);
            // Secret redaction, applied once for every tool rather than at each
            // render site. Runs before anything else reads the text.
            //
            // There is deliberately no per-call escape. `verbose:true` used to
            // lift this, which put the hatch in the hands of the model — the
            // exact actor a mechanism is supposed to not depend on, and the
            // reason this exists rather than an instruction telling the agent
            // to be careful. Its stated justification, that a per-call flag
            // leaves an audit trail, does not hold either: the trail and the
            // leak are the same file. Transcripts are append-only and
            // permanent, so one revealing call is not undone by a thousand
            // redacted ones. EXECBRO_REDACT=off is the only way out, it is set
            // by a human, and it needs a restart — which is the right amount
            // of friction for reading a live credential.
            if (Array.isArray(result?.content) && redactionEnabled()) {
                for (const item of result.content) {
                    if (item.type === "text" && typeof item.text === "string") {
                        item.text = redactSecrets(item.text);
                    }
                }
            }
            // First-install feedback hint — fires once on first successful Metro-connected tool
            if (!NON_METRO_TOOLS.has(toolName) && shouldShowFeedbackHint()) {
                markFeedbackHintShown();
                // Fire-and-forget — don't block the tool response
                pushLogBox(
                    "Congratulations on your first tool call! If you encounter any issues or have ideas for improvement, ask your AI assistant to call send_feedback. Your feedback helps me make this product better for everyone. Best regards, ExecBro developer.",
                    "warning",
                    true,
                    "logbox"
                ).catch(() => {
                    // Non-fatal — hint delivery failure should not affect tool execution
                });
            }
            return result;
        } finally {
            // Attribute the NEXT tool's screen changes. Recorded in `finally` so
            // that while a handler runs this still names the PREVIOUS tool —
            // which is what screenStaleness needs to tell "the agent moved the
            // screen" from "someone else did".
            recordToolCall(toolName);
        }
    });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
