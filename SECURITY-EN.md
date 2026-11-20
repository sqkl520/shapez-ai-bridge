[简体中文](SECURITY.md) | English

# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue and how to reproduce it.

If that channel is unavailable to you, open a public issue containing only
"Security issue — requesting a private channel", with no technical detail, and a
maintainer will follow up.

Please include, as applicable:

- the affected component (mod / bridge / MCP server / agent / GUI),
- the version or commit,
- reproduction steps, or a proof of concept,
- the impact you believe it has.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement that the report was received | within 3 business days |
| Initial assessment (severity, whether it is in scope) | within 7 business days |
| Fix or mitigation plan for confirmed issues | within 30 days, faster for high severity |

These are targets from a single-maintainer project, not a contractual SLA. If a
target is going to slip, you will be told rather than left waiting.

You will be credited in the advisory unless you ask otherwise.

## Scope

In scope — the security-relevant surface of this project:

- **The mod** (`src/mod/`): it runs inside the game's renderer and opens a
  WebSocket to the local bridge.
- **The bridge** (`src/bridge/`): binds to `127.0.0.1` and exposes an RPC
  endpoint that can read and write a savegame, and read/write files on disk
  (snapshots, blueprints).
- **The MCP server** (`src/mcp/`): exposes the bridge as tools to an MCP client.
- **The GUI** (`gui/`): a local web server that can run install scripts.
- **Path handling anywhere**: snapshot names, blueprint names and savegame paths
  are user-supplied and must not escape their intended directory.

Out of scope:

- Vulnerabilities in shapez.io itself, or in Node.js — report those upstream.
- Anything that requires an attacker to already have code execution or
  filesystem access on the machine running the bridge.
- Denial of service against your own local process.

## Design notes relevant to security

- The bridge **binds to `127.0.0.1` only** and rejects non-local browser origins.
  Binding it to a public interface is not a supported configuration.
- Snapshot and blueprint names are validated against directory traversal; see the
  self-tests in `src/bridge/selftest.mjs` (`SECURITY:` prefixed checks).
- The mod, the bridge and the MCP server are all intended to run as the local
  user, with that user's privileges. There is no privilege boundary between them
  and your shell — do not run them against a savegame you are not willing to
  have modified.
- No credentials are stored by this project. API keys for an LLM provider are
  read from environment variables and never written to disk.
