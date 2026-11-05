# Bunny with Docker Compose

Start with the [self-hosted guide](../../docs/self-hosted.md) for prerequisites,
local setup, one provider login, a first task and returning to your board. Use the
public `automate-friday/bunny-board` checkout or a reviewed source archive. Record the
public commit, or retain the archive and checksum; private development access is not needed.

The completed release receipt records the exact version, platform and commands tested.
Fresh provider login, remote runtimes and licensed production HTTPS need their own
verification; a localhost installation drill does not establish those results.

## What runs

| Service | Process and ports | Persistent volumes |
| --- | --- | --- |
| `board` | `server/dist/standalone.cjs` + canvas; container 8793, host `127.0.0.1:8793` by default | `board-state`, `workspaces` |
| `runtime` | Paseo 0.11.4, Claude Code and Codex CLIs; 6767 internal only | `paseo-home`, `agent-auth`, `board-state`, `workspaces` |
| `proxy` | Caddy; host `127.0.0.1:8080` → HTTP 80 and `127.0.0.1:8443` → 443 by default | `caddy-data`, `caddy-config`; file mount `Caddyfile` |

`COMPOSE_PROFILES=local-runtime` in `.env.example` enables the runtime. Agent CLI state
(logins, provider configuration and native conversation history) lives in `agent-auth`;
daemon records/settings live in `paseo-home`. Both are required for full recovery. Board scratch workspaces
are under `/workspaces/boards/<board>` and repository-context work under `/workspaces`, both in
the separate `workspaces` volume; boards created before that default keep their folder under
`/data/board/workspaces/<board>` in `board-state` (see [Board workspaces](#board-workspaces)).
Back up both.

## Board workspaces

Agents on a board (the default frame context) work in `/workspaces/boards/<board>` on the
persistent `workspaces` volume, which the runtime shares. Files there can be attached to the
board; nothing under the private state directory (`/data/board`) can. Set `BOARD_CWD_ROOT`
to use another folder that the runtime can write and that is outside `/data/board`.

Boards created before this default keep the workspace Paseo already has for them, in
`/data/board/workspaces/<board>`, so their existing agents carry on unchanged, but files
written there cannot be attached. A new board uses the new folder.

## Network boundary and authentication

Requires Docker Compose **v2.24 or newer** (optional `env_file`).

**Defaults are loopback only:** the proxy on `127.0.0.1:8080`/`127.0.0.1:8443` and the
board's direct port on `127.0.0.1:8793`, with auth off. Publishing on other interfaces
(`BOARD_HTTP_PORT=8080` or `0.0.0.0:8080`) lets anyone who can reach the machine use the
board and its agents, so turn auth on first and use encrypted transport (HTTPS or an
encrypted private network): basic auth sends the password with every request.
See [Docker published ports](https://docs.docker.com/engine/network/#published-ports).
Agents run with the configured provider permissions (including bypass/full-access modes).

**App auth (recommended).** Create `board-auth.env` next to `docker-compose.yml`
(gitignored, excluded from the image build):

```dotenv
# untested on Docker as of 2026-11-01: resolved with `docker compose config` only
BUNNYBOARD_AUTH_USERNAME=board
BUNNYBOARD_AUTH_PASSWORD=<long random password>
```

then `docker compose -p bunnyboard up -d board`. Only keys in that file reach the board:
no file means auth off; an empty or missing value makes the board refuse to start. Values
in `.env` are not forwarded. App auth covers the canvas, UI API, assets, websocket and the
direct port; frame agents keep their own bearer tokens on `/api/agent/*`, and an
unauthenticated health check gets liveness only. See [App auth](../../docs/AUTH.md).

**Proxy auth (optional).** `BOARD_AUTH=on`, `BOARD_AUTH_USER=board` and
`BOARD_AUTH_HASH='<hash>'` in `.env` (single quotes: the hash contains `$`), hash from
`docker compose -p bunnyboard run --rm --no-deps proxy caddy hash-password` (**untested**).
Caddy then asks for the password everywhere except `/api/agent/*` (exact lowercase, after path cleaning, and exactly so in the request as sent: `//api/agent/` or `/api%2Fagent/` still need it), which goes to the board
and still needs a frame token. It does not cover the direct port `127.0.0.1:8793`; use app
auth for that. With both layers on, use the same username and password. There are no user
accounts or per-board access controls.

## tldraw licence and HTTPS

tldraw requires a production licence for customer deployments. Its licence check treats
an HTTPS page without a valid key (other than on localhost) as unlicensed production use. Bunny does not
ship or bypass a key. If you hold one, put it on one line in `tldraw-license.txt` here
(gitignored, excluded from the build context) and build with
`TLDRAW_LICENSE_KEY_FILE=./tldraw-license.txt` in `.env`. A file with another name or
place inside the repository is **not** excluded: keep it outside the repository, or add
its path to the repository's `.dockerignore`, or `COPY . .` puts the raw file in the build. It reaches the canvas build as a
build secret (`VITE_TLDRAW_LICENSE_KEY`): the raw key file is not copied into the build
context or image layers, and the build log says whether a key was used, never the key.
The compiled browser bundle (in the image, served to every visitor) **does contain the
key**, as tldraw's `licenseKey` requires; do not treat it as confidential. See
[tldraw licence keys](https://tldraw.dev/sdk-features/license-key) and the
[tldraw licence](https://tldraw.dev/community/license).

With a valid key, `PUBLIC_HOST=board.example.com`, `BOARD_PUBLIC_URL=https://board.example.com`,
`BOARD_HTTP_PORT=80` and `BOARD_HTTPS_PORT=443` let Caddy get a certificate. This path is
**untested end to end**: no licensed HTTPS deployment has been verified yet. Without a key,
use it only for local or internal development: production use needs an applicable tldraw
licence whatever the URL scheme or network.

## Remote runtime (advanced)

A runtime on another host needs a checkout with the board MCP dependencies installed.
Paths below are on that runtime host; placeholders must be replaced. This is untested.
Keep the daemon on a restricted private network: the board client does not pass a daemon
password. A native daemon on the Docker host can use `ws://host.docker.internal:<port>/ws`.

```dotenv
# untested: illustrative .env values, not shell commands
COMPOSE_PROFILES=
RUNTIME_WS=ws://<runtime-private-host>:6767/ws
BOARD_DIRECT_PORT=<board-private-interface>:8793
BOARD_AGENT_URL=http://<board-private-host>:8793
BOARD_MCP_ENTRY=/path/on/runtime/host/bunny/mcp/board-mcp.mjs
BOARD_MCP_NODE=node
BOARD_FRAME_CONTEXT=repo
BOARD_DEFAULT_CWD=/path/on/runtime/host/workspace
```

The daemon's listener and allowed hosts must accept the board. The board's direct agent
API must be reachable from the runtime. `BOARD_PUBLIC_URL` remains the browser URL.
Remote-runtime auth, workspace and daemon state live outside this Compose stack: back
them up on their owning host as well.

## Operating

From `deploy/compose`, using the same `.env` and project name:

```sh
# untested: diagnostic commands
docker compose -p bunnyboard logs -f board runtime
docker compose -p bunnyboard exec runtime paseo ls -a
curl --fail http://localhost:8080/api/health
```

An HTTP 200 alone is not proof that the board loads or agents work. Open the board and
repeat the guide's frame task. See [manual backup, update, restore and rollback](../../docs/self-hosted-recovery.md)
for all six volumes, deployment files, secrets and matching version/image preservation.
There is no built-in installation recovery.

## Corporate proxies

Use a full CA bundle (system roots plus proxy CA) inside this directory; the extra Compose
file mounts it at runtime too. Include the bundle and override file in backups.

```sh
# untested: customize the source path; keep this file private
cp /path/to/ca-bundle.crt ./extra-ca.crt
EXTRA_CA_CERTS_FILE=./extra-ca.crt docker compose -p bunnyboard -f docker-compose.yml -f compose.ca.yml up -d --build
```

Use the same `-f` files for subsequent operations; the recovery examples assume the base
stack and need those extra flags for this variant. See [architecture](ARCHITECTURE.md).
