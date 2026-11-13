# Bunny — release candidate

Bunny is a whiteboard where a frame can hold an AI conversation and the work it produces.
This package contains buildable application source, the Docker Compose installation,
and customer instructions. It excludes the development repository's history, captured
boards, operator tools, and historical notes.

**This is a candidate, not a production approval.** Read
[third-party requirements](docs/release/THIRD-PARTY.md) before use outside internal
development. A working localhost canvas does not prove production licensing.
The exact source commit and file hashes are recorded in `RELEASE.json`.

**Developer preview.** A fresh Ubuntu 24.04 VPS trial used a vanilla coding agent given
only the public repository URL to install Bunny. It verified normal Codex login, a
browser task and correction, a workspace file and attachment, restart continuation, and
full recovery into fresh volumes with a new visible reply without reauthentication.
Licensed public HTTPS, production tldraw entitlement and off-host encrypted backup
remain untested.

## Licence

Bunny's code is source-available under the [Business Source License 1.1](LICENSE.md).
Development and self-hosting for yourself or your organisation are free; offering
a competing hosted or managed service is restricted by the Additional Use Grant.
Each release converts to Apache-2.0 four years after its first public release.

The tldraw canvas is covered by tldraw's own licence. Self-hosters must comply with
its development terms or use their own applicable production licence key; Bunny's
licence does not grant tldraw production rights. See
[third-party requirements](docs/release/THIRD-PARTY.md).


## Try the candidate

**Installing on a VPS? Start with [Install Bunny on a VPS](docs/install-vps.md).**
That guide covers a fresh Ubuntu host, Docker, private access, authentication,
provider login, a useful task, restart and recovery. It is also the entry point
for a vanilla coding agent asked to install this repository. Record any missing
input or instruction; a running container alone does not complete installation.

Clone the public source into an empty folder:

```sh
git clone https://github.com/automate-friday/bunny-board.git
cd bunny-board
```

If using a release archive instead, retain its SHA-256 receipt and extract it into an
empty folder. You need Docker with Compose v2.24 or newer, a browser, and a supported Claude or Codex
account to run agent tasks. Provider usage is charged under your own account's terms.

Check `docker compose version` before starting.

From the extracted folder:

```sh
cd deploy/compose
cp .env.example .env
docker compose up -d --build
docker compose run --rm runtime login claude
```

For Codex, replace the last command with `docker compose run --rm runtime login codex`.
Complete the provider's own login flow; do not put access tokens into chat or commit them.
Then open **http://localhost:8080** on the same computer. The default installation must
remain local-only. Remote access requires the separately documented authentication,
encrypted transport, and production licence setup in [AUTH.md](docs/AUTH.md).

Run the [five checks](docs/release/CHECK.md). The person preparing your release should
give you a completed receipt for this exact commit, including the tested operating
system and provider. Missing evidence remains unverified.

## Keep your work

Docker volumes hold board data, provider login, conversations and workspace files.
Restarting the containers should retain that work. Removing volumes deletes it:
do not use `docker compose down -v` as a restart command.

Follow [backup and recovery](docs/self-hosted-recovery.md) before updating an installation
that has work you want to keep. Restore into a separate, empty installation during a
rehearsal; never use the only copy of your real board as the test fixture.

This public repository contains reviewed source snapshots. Public issues and pull
requests supply reports and ideas; maintainers independently implement changes in the
private source. See [CONTRIBUTING.md](CONTRIBUTING.md). Public source availability does
not promise course access, a support agreement, or a new project licence.

<!-- These links are relative to README.md at the package root. -->
