# Install Bunny on a VPS

Start here when a user asks an agent to install this repository. Use a fresh Ubuntu
24.04 VPS with root or sudo access. The public release source is
`https://github.com/automate-friday/bunny-board`; no repository invitation is needed.
A supplied reviewed source archive is an alternative. The separate development
repository stays private. Do not copy an existing operator's board or login.

The default route is a single trusted operator using an SSH tunnel. It keeps every
Bunny port private. Public HTTPS is a separate configuration below. Both routes
need an applicable tldraw licence for production use; a tunnel is not a licence
exemption. The built-in agent runtime also needs the user's own provider login.

## 1. Record the source and check the machine

Check `git`, `curl`, `openssl` and CA certificates first, even if Docker is already
installed. On Ubuntu, install missing prerequisites with `sudo apt-get update`
and `sudo apt-get install -y git curl openssl ca-certificates` (omit `sudo` as root).
Clone `https://github.com/automate-friday/bunny-board.git` into a new directory, then
run from that checkout. If the user supplied a pinned public release commit, check
it out before installing. If this public URL fails, check connectivity and the exact
URL, then report the failure; do not ask for private development access or invent
an alternative download.

```sh
git rev-parse HEAD
cat /etc/os-release
uname -m
free -h
df -h .
ss -ltn
```

Record the commit in your installation receipt. For an exported package, use its
`RELEASE.json` and verify the supplied SHA-256 receipt instead. Check the available
RAM and disk before building; no measured minimum is promised. Do not stop or
replace an existing service to free a port. Use a separate Compose project if the
host is shared, and keep that project name for all later commands.

## 2. Install Docker if it is missing

```sh
docker version
docker compose version
```

Docker Compose must be v2.24 or newer. If Docker already works, preserve it. On a
fresh Ubuntu VPS without Docker, use Docker's official apt repository. These
commands assume sudo access; when already root, omit `sudo`.

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

For an existing installation with conflicting distribution packages, follow
[Docker's Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/) before
changing packages. Docker access is effectively root access; do not add unrelated
users to the Docker group. Use `sudo docker` below if your account needs it.

## 3. Configure a private installation

From the source root:

```sh
cd deploy/compose
umask 077
test ! -e .env && cp .env.example .env
chmod 600 .env
```

If `.env` already exists, inspect it and preserve its settings. Keep these values
for the first installation:

```dotenv
COMPOSE_PROFILES=local-runtime
BOARD_PUBLIC_URL=http://localhost:8080
BOARD_HTTP_PORT=127.0.0.1:8080
BOARD_HTTPS_PORT=127.0.0.1:8443
BOARD_DIRECT_PORT=127.0.0.1:8793
BOARD_HUMAN_NAME=User
```

Set application authentication before starting. Generate a password once, save it
to `board-auth.env` and give the operator a secure way to retrieve it. Do not print
the password into agent transcripts or screenshots. Do not overwrite existing
credentials. This file is gitignored and excluded from the Docker build context.

```sh
test ! -e board-auth.env && (
  umask 077
  printf 'BUNNYBOARD_AUTH_USERNAME=board\nBUNNYBOARD_AUTH_PASSWORD=' > board-auth.env
  openssl rand -hex 24 >> board-auth.env
)
chmod 600 board-auth.env
```

Leave proxy `BOARD_AUTH` off when using app auth alone. The application protects
both proxy and direct access. The runtime port stays unpublished. Do not mount the
Docker socket or unrelated host directories. Read [the trust boundary](AUTH.md#trust-boundary):
agents share the installation's workspaces, board state and provider credentials.

For production, supply the user's tldraw licence as `tldraw-license.txt`, mode 600,
and set `TLDRAW_LICENSE_KEY_FILE=./tldraw-license.txt` in `.env` before building.
Never invent, purchase, reuse another deployment's key or suppress licence checks.
Without a suitable key, label the result development/evaluation only and leave
production acceptance incomplete. See [tldraw licensing](https://tldraw.dev/community/license).

## 4. Build, start and sign in to one provider

```sh
docker compose -p bunnyboard config --quiet
docker compose -p bunnyboard up -d --build
docker compose -p bunnyboard ps
docker compose -p bunnyboard run --rm runtime login claude
docker compose -p bunnyboard run --rm runtime status
```

Complete the provider's interactive login with the account owner. For Codex, use
`docker compose -p bunnyboard run --rm runtime login codex` instead. A host CLI's
login is not automatically shared with the container. Do not copy login files from
another machine or another user's session. Verify the chosen provider's status;
the status wrapper's exit code alone is not a successful login check.

If the account owner cannot complete login now, leave the services private and
report exactly that remaining step. Do not claim a useful-agent test passed.

## 5. Open it from your computer

On the operator's computer, open a tunnel using the same SSH identity and host
already used for this VPS:

```sh
ssh -N -L 8080:127.0.0.1:8080 user@your-vps
```

Replace `user@your-vps` with the actual SSH destination. Open
**http://localhost:8080/?board=main**, then use the browser's basic-auth prompt.
Retrieve the generated username/password from `board-auth.env` in your own secure
terminal. Keep the tunnel open while using Bunny. A busy local port requires a
different local port plus the corresponding `BOARD_PUBLIC_URL` in `.env` and a
`docker compose -p bunnyboard up -d` to apply it; do not kill the existing listener.

The unauthenticated health endpoint deliberately returns only minimal health:

```sh
curl --fail http://127.0.0.1:8080/api/health
```

A 200 response is not enough. Keep the browser open at least 15 seconds; confirm
the canvas and controls render, there is no licence error, and changes persist on
reload. Check published bindings with `docker compose -p bunnyboard ps`: all ports
must remain on `127.0.0.1`. From another machine, the VPS's public address must not
serve 8080, 8443, 8793 or 6767.

## 6. Prove a useful task and return

Follow [A useful first task](self-hosted.md#a-useful-first-task): three notes,
a frame, an available provider/model, a useful checklist, and a correction.
Confirm the assistant reply appears **inside the open sidebar**, not only in the
frame card or a status badge. Ask the agent to create a workspace file containing
`Bunny restore check 2026` and open it to verify those exact contents. Upload a
small synthetic text attachment containing `Bunny attachment restore check` to
the board and open it. Record both locations and contents for the restore check;
do not use personal files as test fixtures.

```sh
docker compose -p bunnyboard restart
```

Reload, reopen the same frame, send a new request and confirm a new visible reply.
Do not use `down -v`: it deletes persistent volumes. Follow
[full installation recovery](self-hosted-recovery.md) on a disposable copy and
verify board data, provider state, conversation, workspace files and attachments.
The board-only `bunny backup` command does not back up the entire installation.

## Public HTTPS, when requested

Use the private installation above until the operator supplies a domain pointing
to this VPS and an applicable tldraw licence for that domain. Keep app auth on and
the direct board port loopback-only. In `.env`, set:

```dotenv
PUBLIC_HOST=board.example.com
BOARD_PUBLIC_URL=https://board.example.com
BOARD_HTTP_PORT=80
BOARD_HTTPS_PORT=443
BOARD_DIRECT_PORT=127.0.0.1:8793
TLDRAW_LICENSE_KEY_FILE=./tldraw-license.txt
```

Replace the example domain with the operator's real domain. BuildKit does not
invalidate its cache when a secret's contents change. Whenever adding or changing
the licence after an earlier build, rebuild explicitly:

```sh
docker compose -p bunnyboard build --no-cache board runtime
docker compose -p bunnyboard up -d --no-build
```

Allow TCP 80/443 through the VPS
firewall for Caddy certificate issuance and HTTPS. Preserve SSH access. Do not
publish 8793 or the runtime port. Docker-published ports can bypass UFW rules;
bindings and external reachability checks are both required.

Check the real HTTPS URL, certificate, authentication, canvas, WebSocket sync,
useful task and restart in a browser. Without those checks, record HTTPS as
unverified. Do not offer public unencrypted HTTP as a fallback.

## Installation receipt

Return the source commit, OS, Docker/Compose versions, chosen provider and access
mode; the working browser URL or tunnel command; locations of configuration and
backups; and PASS/FAIL/UNVERIFIED for build, authentication, canvas, useful task,
restart, recovery, network exposure and production licensing. Keep credentials,
raw login output and unrelated data out of the receipt. Record every user input
and any step that required guidance outside this repository.
