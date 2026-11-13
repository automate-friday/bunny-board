# Self-host Bunny

Bunny by Automate Friday runs on your own machine. This guide uses the supplied
[Docker Compose stack](../deploy/compose/docker-compose.yml).

A fresh Ubuntu 24.04 VPS trial used a vanilla coding agent given only the public
repository URL to install Bunny. It verified normal Codex login, a browser task and
correction, a workspace file and attachment, restart continuation, and full recovery
into fresh volumes with a new visible reply without reauthentication. Licensed public
HTTPS, production tldraw entitlement and off-host encrypted backup remain untested. See
[release check](release/CHECK.md).

The installer corrected restrictive source-file permissions caused by its launch umask.
The recovery drill required GNU tar to preserve symlink ownership; use the corrected
[recovery procedure](self-hosted-recovery.md). These were not zero-adjustment runs.

For a VPS, start with [the VPS installation guide](install-vps.md), which includes
Docker installation and SSH browser access. The commands below assume Docker is ready.

## Get the software

Clone the public release repository; no invitation is required:

```sh
git clone https://github.com/automate-friday/bunny-board.git
cd bunny-board
git rev-parse HEAD
```

Keep the public commit and the source commit recorded in `RELEASE.json` in your
installation receipt. Alternatively, keep the supplied source archive and SHA-256
receipt, and extract it into an empty directory. The root README is the entry point.

The separate development repository stays private. Course signup and lesson access
are separate from obtaining this public source; follow your course provider's
instructions if those apply to you.

## Before starting

You need:

- Docker Engine or Docker Desktop running, with Docker Compose **v2.24 or newer** (the board reads `board-auth.env` as an optional `env_file`)
  (the stack uses optional service dependencies).
- Enough disk for source builds, images, workspaces and a separate full backup.
  No measured minimum RAM or CPU requirement is available. Agent jobs add load.
  Tested on Ubuntu 24.04, 4 vCPU / 8 GB (Hetzner CPX32); this is tested hardware, not a minimum.
- Internet access for image/package pulls and a Claude Code or Codex account with
  access accepted by its CLI. Provider use is separate from course access.
- Free host ports: HTTP **8080**, reserved proxy HTTPS **8443**, direct board **8793**.
  The runtime's **6767** stays inside Docker; it is not a host port.

**The supplied defaults are local-only, with auth off.** Caddy's 8080 and 8443 mappings
and the board's direct 8793 mapping all default to `127.0.0.1` (also in `.env.example`);
the runtime is internal. Anyone who reaches an unauthenticated board can start agents
with the runtime's configured permissions, so publishing on another interface is your
explicit choice and needs authentication **and** encrypted transport first. Basic auth
alone does not encrypt traffic. See
[Docker published ports](https://docs.docker.com/engine/network/#published-ports) and
[authentication](../deploy/compose/README.md#network-boundary-and-authentication).
The release receipt records both the resolved defaults and the ports used in the installation drill.

## First start, using Claude Code

After obtaining and unpacking the confirmed software package, enter its `deploy/compose`
directory. Keep the same Compose project name for every command: examples use `bunnyboard`,
which is also the supplied default. Changing it creates a different set of volumes.

```sh
# Run from the delivered source root
cd deploy/compose
cp .env.example .env
```

Edit `.env` **before starting**. Keep `COMPOSE_PROFILES=local-runtime`. These are the
loopback defaults, written out so they stay explicit. Leave `PUBLIC_HOST` unset:

```dotenv
# Local-only .env settings
BOARD_PUBLIC_URL=http://localhost:8080
BOARD_HTTP_PORT=127.0.0.1:8080
BOARD_HTTPS_PORT=127.0.0.1:8443
BOARD_DIRECT_PORT=127.0.0.1:8793
BOARD_HUMAN_NAME=User
```

Check existing containers and your host's listeners before choosing ports. If 8080 is in
use, choose another unused host port in both `BOARD_HTTP_PORT` and `BOARD_PUBLIC_URL`.
Likewise change reserved 8443 and direct 8793 if needed. Do not stop someone else's service.

```sh
# Inspect, build and start only this project
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker compose -p bunnyboard config --quiet
docker compose -p bunnyboard up -d --build
docker compose -p bunnyboard run --rm runtime login claude
docker compose -p bunnyboard run --rm runtime status
```

`runtime-entrypoint.sh` invokes `claude auth login`: follow its link, sign in, and paste
back the requested code. Authentication is saved in `agent-auth`. Check that the status
output says Claude is signed in; the wrapper's exit status alone is not proof of login.
New frames default to a Claude provider/model; choose an available Claude model in the UI.

For Codex instead, use `docker compose -p bunnyboard run --rm runtime login codex`
which invokes `codex login --device-auth`, then choose Codex when starting
a conversation. Normal device login inside the runtime was verified on a fresh VPS;
`runtime status` reported “Logged in using ChatGPT”. `login` with no provider attempts both; you only need one working provider.

Open [your local board](http://localhost:8080/?board=main). Expect the Bunny canvas,
not just an HTTP response. A health check is useful but does not prove the licence gate,
WebSocket sync or provider authentication works:

```sh
# Local smoke check
curl --fail http://localhost:8080/api/health
curl --fail --output /dev/null --write-out '%{http_code}\n' http://localhost:8080/
```

Expect HTTP 200, `ok: true`, and (with app auth off) `paseo: true` when the runtime is
connected. If Caddy auth is enabled, these proxy requests need basic credentials.
[Compose reference](../deploy/compose/README.md) explains both auth layers.

## A useful first task

1. On `main`, add three notes: **What I need to finish**, **What is blocking me**, and
   **What I can do in 20 minutes**. Fill each with a real detail.
2. Press **F** and draw a frame around the notes, or use **Draw a frame** on an empty
   board and put the notes inside it.
3. Select the frame → **Start conversation**. The model picker defaults to Claude even
   when only Codex is logged in. Choose the provider you signed in to (**Harness → Codex**
   for a Codex login), then an available model. Ask: “Read these notes. Add a checklist inside this frame for
   one useful thing I can finish in 20 minutes.” Press **Start**.
4. Expect a sidebar reply and a checklist inside the frame. Reply with a correction;
   confirm the conversation continues. This is the first-task receipt.

If the agent says it is not logged in, rerun the chosen provider's CLI login, check status,
and start a fresh conversation in another frame. There is no board `/login` command.
The organizer shortcut is unavailable in this Compose image: it requires a local `codex`
binary in the board container. Use the frame conversation for this task.

To attach files or recordings, drop them inside a frame already bound to a local agent.
Dropping outside a bound frame shows a notice asking you to drop inside one.

## Reopen later or restart

Bookmark your own board URL, including `?board=main` (or your board's chosen name).
Return to that URL and select the same frame to reopen the conversation. Expect the notes,
checklist and frame binding to remain. Browser display preferences are separate from the
server's volumes. Provider credentials can expire and may require another login.

From the same `deploy/compose` directory, with the same `.env` and project name:

```sh
# Restart existing containers
docker compose -p bunnyboard restart
# Start again after a previous down, preserving named volumes
docker compose -p bunnyboard up -d
# Stop this project without deleting its volumes
docker compose -p bunnyboard down
```

Do not use `down -v` for normal operation: it removes state volumes. Restart policies are
`unless-stopped`; Docker itself must be running. For updates, use the full
[backup, update and rollback procedure](self-hosted-recovery.md), rather than an unpinned pull.

## URL support and remote use

- **Local HTTP:** `http://localhost:8080` with the loopback bindings above.
- **LAN/tailnet HTTP:** `http://<your-private-host>:<your-http-port>` is a supported URL
  form. Replace the placeholders with your own address, update `BOARD_PUBLIC_URL`, and
  bind `BOARD_HTTP_PORT` to the intended private interface. Restrict access, enable
  [app auth](../deploy/compose/README.md#network-boundary-and-authentication), and use an
  encrypted private transport (for example a tailnet/VPN). Ordinary LAN HTTP has no
  encryption; keep loopback-only if you cannot supply both protections.
- **HTTPS / domain:** needs your own tldraw production licence key, built in as described in
  [tldraw licence and HTTPS](../deploy/compose/README.md#tldraw-licence-and-https); Bunny
  does not ship one. This path is **untested**: no licensed HTTPS install has been
  verified. Do not expose a public HTTP board as a workaround.
- **Licence:** production use of the tldraw canvas needs an applicable tldraw licence
  whatever the URL scheme or network; HTTP and private networks are not an exemption.
  See [tldraw licence](https://tldraw.dev/community/license).

## Support

Support: email [jacob@automatefriday.com](mailto:jacob@automatefriday.com).
Include the release/commit, relevant redacted error, and whether the canvas or agent failed.
Do not send `.env`, authentication volumes, tokens or full backups.
