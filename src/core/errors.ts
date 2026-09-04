/**
 * Marker class for errors caused by invalid agent input (wrong device name,
 * missing required predicate, ambiguous match, etc). Marks the error as
 * agent-input noise rather than a product bug, so reporting/triage paths can
 * skip or downgrade it.
 *
 * The trade-off vs regex-matching the message: this is self-documenting at
 * the throw site and survives message reformatting / translation.
 */
export class UserInputError extends Error {
    /**
     * Optional low-cardinality tag (e.g. "device_mismatch") forwarded to
     * telemetry's error-context column. Lets the dashboard cluster validation
     * failures by cause instead of regex-matching free-form messages.
     */
    readonly context?: string;

    constructor(message: string, context?: string) {
        super(message);
        this.name = "UserInputError";
        this.context = context;
    }
}
