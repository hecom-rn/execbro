# Privacy Policy

**Last updated:** September 10, 2026

ExecBro ("the Tool"), shipped as the npm package `execbro`, is an MCP server for AI-powered React Native debugging. This document explains what data the Tool handles, what leaves your machine, and how you can control it.

## Summary

**The Tool makes no automatic outbound network requests.** There is no telemetry, no usage metering, no account system, no license validation, no cloud OCR, and no failure-artifact upload. All automatic network traffic stays on your machine, between the Tool and your own Metro bundler and debuggable apps.

| Surface | Network behaviour | When |
|---------|-------------------|------|
| Metro / bundler endpoints | `localhost` HTTP | Automatic, during connection and symbolication |
| App debugging protocol (CDP) | `localhost` WebSocket | Automatic, while an app is connected |
| `http_request` tool | Outbound to the URL the agent names | **Only when explicitly invoked** |
| `send_feedback` tool | Builds a GitHub issue URL for you to open | Only when invoked; nothing is sent by the Tool itself |

## 1. Automatic network traffic is localhost-only

While debugging, the Tool talks to:

- **Your Metro bundler** (`http://localhost:<port>`) — app listing, bundle status/errors, symbolication.
- **Your running app** via its Chrome DevTools Protocol WebSocket on `localhost` — logs, network inspection, layout, screenshots, and injected evaluation.

Nothing in this traffic is sent anywhere else. No analytics or telemetry hooks are attached to it.

## 2. `http_request` — the only intentional outbound path

The `http_request` tool issues HTTP requests **from your machine to a URL the agent explicitly names**, typically to exercise your app's backend API directly.

- It fires **only** when the agent calls it. It is never triggered by other tools or by server startup.
- It does not run inside your app; it is an ordinary host-side request, like `curl`.
- With `auth: { secret: "<origin>" }` it attaches a credential previously captured into the local vault (see Section 3). A credential is bound to the origin it was captured on and can only be sent back to that host.

If you do not want this capability, simply do not invoke `http_request`; the server performs no outbound request of any kind without it.

## 3. Credential vault and redaction — local and memory-only

The vault stores credentials observed in your app's own network traffic (or captured explicitly via `vault_capture`):

- Stored **in memory only**, content-hashed, for the lifetime of the server process. A server restart empties it.
- **Never transmitted anywhere** by the vault itself. The only way a credential leaves the process is an explicit `http_request` call to its bound origin (Section 2).
- Redaction (`redactSecrets`) runs locally on tool output to mask detected secrets in transcripts. It performs no network I/O and can be disabled with `EXECBRO_REDACT=off`.

## 4. Features that no longer exist

This build removed the following capabilities entirely; they cannot be turned back on because there is nothing left to enable:

- **Anonymous usage telemetry** — removed. No usage events are collected or dispatched.
- **Usage metering / free-tier counting** — removed. No heartbeat, quota, or cap signals.
- **License validation & accounts** — removed. No installation ID, device fingerprint, or account linking; the `activate_license`, `get_license_status`, and `delete_account` tools do not exist.
- **Cloud OCR** — removed. Screenshots are never sent anywhere for text recognition.
- **Tap failure artifact upload** — hard-disabled in code (`isArtifactCaptureEnabled()` returns `false`); the dormant upload path performs no network I/O.

## 5. Local storage

The Tool creates the following files on your machine:

| File | Purpose | Contents |
|------|---------|----------|
| `~/.execbro/config.json` | Local server configuration | Settings you set (e.g. dev mode flag) |
| `~/.execbro/feedback.json` | Feedback draft state | Whether the feedback hint was shown |
| `~/.execbro/projects/` | Per-project state | Local debug session metadata |

To delete all locally stored data:

```bash
rm -rf ~/.execbro/
```

## 6. Children's Privacy

The Tool is a developer utility and does not knowingly collect any personal information from anyone, including children under 13.

## 7. Changes to This Policy

We may update this Privacy Policy from time to time. Changes will be posted in the repository.

## 8. Contact

Open an issue at the project repository, or use the `send_feedback` tool from within your AI assistant.
