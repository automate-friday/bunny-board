# Bunny deployment architecture

The browser connects to Caddy, which forwards HTTP and WebSocket requests to the
board. The board connects to the Paseo runtime; that runtime runs Claude or Codex
agents. Each frame agent receives a token scoped to its board, frame and agent
binding for calls back to the board API.

| Service | Responsibility | State |
| --- | --- | --- |
| Board | Canvas, board snapshots, frame conversations and agent API | `board-state`, `workspaces` |
| Runtime | Provider login, agent execution and conversation history | `agent-auth`, `paseo-home`, shared board and workspace volumes |
| Caddy | Browser entry point, optional proxy authentication and TLS | `caddy-data`, `caddy-config`, deployment files |

A board has one writer. Never run two board processes against the same state
volume. Separate installations need separate volumes and Compose project names.
Containers do not reserve CPU or memory; agent workloads compete with the board
unless the operator sets resource limits or uses separate hosts.

## Access

The supplied Compose ports bind to loopback. The runtime port stays inside the
Compose network. Anyone with access to the board can run agents with the configured
provider permissions; this is a trusted-user application, without per-user accounts
or per-board authorization.

App Basic auth protects both direct board access and access through Caddy. Optional
Caddy auth protects the proxy path. When both are enabled, use matching credentials.
The agent API still requires its frame token; bypassing the proxy password for that
path does not bypass token validation. See [authentication](../../docs/AUTH.md).

Remote browser access requires authentication and encrypted transport. Production
canvas use also requires an applicable tldraw licence. The build accepts a licence
key; successful compilation alone does not prove entitlement or a working licensed
HTTPS deployment. See [Compose setup](README.md).

## Runtime and persistence

Standalone mode uses the same board core as plugin mode. It maps `RUNTIME_WS` and
`BOARD_*` settings into core configuration and receives lifecycle events from the
runtime connection. Board-created agents receive the frame tools directly.

A remote runtime needs reachable callback URLs, an installed board MCP entry point
and matching paths. The board client does not pass a daemon password, so keep that
connection restricted to a trusted network. Remote runtime state must be backed up
on its own host as well.

Back up every persistent volume and the matching deployment files before upgrading.
Provider credentials and board secrets belong in a private backup, never in the
source package. Use the [recovery guide](../../docs/self-hosted-recovery.md) and
rehearse restoration into an empty installation. The [release checks](../../docs/release/CHECK.md)
record whether install, useful agent work, restart and restore actually passed.
