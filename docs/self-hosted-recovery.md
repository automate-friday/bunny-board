# Manual backup, update, restore and rollback

Bunny has **no built-in installation backup, recovery or rollback**. Frame history is not
an installation backup. These procedures cover the base local-runtime Compose stack.
Remote runtimes and extra mounts require backups on their owning hosts too.

Use the supplied release receipt to see which platform, volumes and restore checks
were tested. A drill that reuses an existing provider volume does not verify recovery
of its credentials or conversation history. Rehearse the complete procedure on a
disposable installation before relying on it. Run shell blocks in one POSIX-compatible
shell; replace placeholders before execution.

The sequence follows [n8n's Compose update model](https://github.com/n8n-io/n8n/blob/master/docker/images/n8n/README.md#updating-with-docker-compose)
(review breaking changes, pull, down, up) and [full-state recovery model](https://github.com/n8n-io/n8n-docs/blob/main/docs/deploy/host-n8n/keep-n8n-running/backup-and-restore.md)
(keep state plus secrets/configuration; stop writers before copying; restore, then start).
The state and image steps below are specific to Bunny.

A disposable Ubuntu 24.04 VPS drill verified all six fresh volumes, configuration,
matching source and running images, workspace file and attachment, conversation
history and a new browser-visible Codex reply without reauthentication. The original
installation stayed stopped. Off-host encrypted backup remains untested.

## What must travel together

The actual keys in `docker-compose.yml` are:

| Volume key | State to preserve |
| --- | --- |
| `board-state` | Whole `/data/board`: boards, assets, histories, archives, prompt outbox, configuration, signing secret, discovery files and the scratch folders of boards created before `/workspaces/boards` (see [Board workspaces](../deploy/compose/README.md#board-workspaces)) |
| `agent-auth` | Whole `/home/node/.agent-auth`: Claude and Codex credentials, provider configuration, native conversation history and session state |
| `workspaces` | Whole `/workspaces`: agent working files, checked-out repos and board scratch folders (`/workspaces/boards/<board>`) |
| `paseo-home` | Whole `/home/node/.paseo`: daemon state and agent records; provider history also requires `agent-auth` |
| `caddy-data` | Whole proxy `/data`: certificate and other Caddy state |
| `caddy-config` | Whole proxy `/config`: Caddy persisted configuration |

With project `bunnyboard`, Docker names these `bunnyboard_board-state`, etc. A custom
project changes the prefix. Inspect actual volume names before copying; never assume an
empty or newly created volume is your data. Do not let two board processes write one set.

Also preserve `.env`, `Caddyfile`, Compose files/overrides, any CA bundles or secret files,
custom bind mounts and external storage, the exact release/source commit, and **all three
running images**. `.env` can hold credentials; image backups can contain private source.
Protect backups like the original secrets, encrypt your off-host copy, and test access to it.
Store backups outside the checkout and outside Docker volumes. Docker container writable
layers are not backed up here: persist or separately copy any custom state outside mounts.

## 1. Capture a consistent backup

Tell other users about downtime. Finish or stop agent jobs, including external jobs that
write workspaces; pause alone does not stop running jobs. From the installed `deploy/compose`
directory, choose a new empty backup directory. Examples assume project `bunnyboard` and
all three services running; adapt the project and `-f` flags if your install differs.
Use a Docker host where you own this installation; do not operate unrelated projects.

```sh
# untested: setup and prerequisite checks
set -eu
umask 077
compose_project=bunnyboard
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/absolute/private/backup-directory/$backup_stamp"  # replace parent path
mkdir "$backup"  # parent must exist; refuse an existing snapshot directory
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker compose -p "$compose_project" ps
# Pull the helper before downtime; this does not update Bunny.
docker pull alpine:3.22
```

First record the exact source version. For a clean Git checkout, the following captures
committed build inputs. Stop if there are local edits: retain them explicitly before
continuing. For a delivered source package without Git, retain that original package in
`$backup/source.tar.gz` (a tar.gz with the source files at its root) and write its supplied
release/commit ID to `$backup/release.txt` instead. Keep the exact delivered source archive; do not substitute a newer checkout during recovery.

```sh
# untested: Git-delivered source only, from deploy/compose
test -z "$(git -C ../.. status --porcelain)"
git -C ../.. rev-parse HEAD > "$backup/release.txt"
git -C ../.. archive --format=tar.gz --output="$backup/source.tar.gz" HEAD
```

Capture configuration and the image IDs actually running, not whatever a mutable `local`
tag happens to name now. The generated `images.env` contains recovery image names only.
Keep this complete snapshot directory; the IDs alone cannot recreate removed images.

```sh
# untested: configuration and exact running images
cp -R . "$backup/compose"
docker compose -p "$compose_project" config > "$backup/resolved-compose.yaml"
printf '%s\n' "$compose_project" > "$backup/project.txt"
: > "$backup/images.env"
for service in board runtime proxy; do
  container_id=$(docker compose -p "$compose_project" ps -q "$service")
  test -n "$container_id"
  image_id=$(docker inspect --format '{{.Image}}' "$container_id")
  image_tag="bunny-recovery/$service:$backup_stamp"
  docker image tag "$image_id" "$image_tag"
  case "$service" in
    board) image_var=BOARD_IMAGE ;;
    runtime) image_var=RUNTIME_IMAGE ;;
    proxy) image_var=PROXY_IMAGE ;;
  esac
  printf '%s=%s\n' "$image_var" "$image_tag" >> "$backup/images.env"
  printf '%s %s %s\n' "$service" "$image_id" "$image_tag" >> "$backup/images.txt"
done
docker image save --output "$backup/images.tar" \
  "bunny-recovery/board:$backup_stamp" \
  "bunny-recovery/runtime:$backup_stamp" \
  "bunny-recovery/proxy:$backup_stamp"
```

Now stop the **whole project** so board, runtime and proxy state are quiescent. Do not use
`-v`. Check every named volume exists before mounting it, then archive all six with owner
IDs and permissions. If any step fails, the backup is incomplete; do not update.

```sh
# untested: stopped full-volume backup
docker compose -p "$compose_project" down
for volume in board-state agent-auth workspaces paseo-home caddy-data caddy-config; do
   volume_name="${compose_project}_${volume}"
   docker volume inspect "$volume_name" > "$backup/$volume.volume.json"
   docker run --rm --user 0 \
     --mount "type=volume,src=$volume_name,dst=/state,readonly" \
     --mount "type=bind,src=$backup,dst=/backup" \
     alpine:3.22 tar czpf "/backup/$volume.tar.gz" -C /state .
done
for volume in board-state agent-auth workspaces paseo-home caddy-data caddy-config; do
   tar -tzf "$backup/$volume.tar.gz" > /dev/null
done
```

Copy any additional external files/mounts now. Verify the six archives, configuration,
source and images exist and can be read. Make an encrypted off-host copy, preserving its
key separately. Archive listing checks only readability; a successful restore drill is the
recovery proof. Leave stopped for an update, or run the following to resume the old images:

```sh
# untested: resume old images from the completed snapshot
set -a
. "$backup/images.env"
set +a
docker compose -p "$compose_project" up -d --no-build --pull never
```

## 2. Update to a pinned version

Review the target release's breaking changes, state migrations, provider requirements and
Compose differences. Keep the completed **pre-update** backup and old images. Do not reuse
an old snapshot after more work has been written without taking a new consistent backup.
No published Bunny image release is confirmed; the current Compose defaults build locally.
Do not treat `bunnyboard/board:local` or `runtime:local` as downloadable releases.

For the current source-build path, fetch a pinned public release commit from
`https://github.com/automate-friday/bunny-board.git` into a **separate** source directory,
or obtain its matching reviewed source archive. The public Git commit differs from the
private source commit recorded inside `RELEASE.json`; use the public commit for Git
checkout commands. Copy your reviewed `.env`, Compose
overrides, `board-auth.env`, custom `Caddyfile`, licence/CA files and every referenced
configuration file into the new source's `deploy/compose` or its configured location.
Preserve restrictive permissions (600 for credentials and licence files). Check the
resolved configuration without printing secrets. **A missing `board-auth.env` turns
app authentication off**; verify the file is present and authentication still rejects
anonymous access before restoring any network exposure. Keep the project name and
volume keys unchanged.

For an existing public Git checkout, first verify `origin` is the public repository,
then obtain a pinned source tree without changing the installed checkout. Replace the
path and full public commit:

```sh
# untested: run from the existing public source root; no invitation required
git remote get-url origin
# Expected: https://github.com/automate-friday/bunny-board.git
git fetch --no-tags origin main
git worktree add --detach /path/to/new-bunny-source '<full-public-release-commit>'
```

For an archive installation without Git metadata, clone the public repository into a
new directory and check out that same pinned public commit, or obtain a reviewed archive
for the target release. Confirm the new tree's commit matches the chosen release before building. If using a
source package, check its supplied release identity instead. Do not update from a moving
branch name alone.

In that directory, pin locally built Bunny tags to the full source commit (hex digits;
replace the placeholder), and pin Caddy to a reviewed published digest. Clear recovery
image overrides from the previous shell. Save these exact settings in the new `.env` too.

```sh
# untested: source-build update; use the SAME project as the old install
unset BOARD_IMAGE RUNTIME_IMAGE PROXY_IMAGE
release_commit='<full-commit-of-the-new-source>'
export BOARD_IMAGE="bunnyboard/board:$release_commit"
export RUNTIME_IMAGE="bunnyboard/runtime:$release_commit"
export PROXY_IMAGE='caddy@sha256:<reviewed-published-digest>'
docker compose -p "$compose_project" config --quiet
# Pull external image, build Bunny from the pinned source, then replace containers.
docker compose -p "$compose_project" pull proxy
docker compose -p "$compose_project" build --no-cache board runtime
docker compose -p "$compose_project" down
docker compose -p "$compose_project" up -d --no-build --pull never
```

The no-cache build also applies changed licence/CA build secrets, whose contents do
not otherwise invalidate BuildKit's cache. A source commit does not make a future
rebuild byte-identical (base images can change).
Keep the built images as part of each snapshot. If versioned Bunny images are later
provided, set `BOARD_IMAGE`, `RUNTIME_IMAGE`, `PROXY_IMAGE` to their **confirmed immutable
digests**, then use this alternative to building locally:

```sh
# untested: FUTURE published-image path; requires real supplied image digests in .env
docker compose -p "$compose_project" pull
docker compose -p "$compose_project" down
docker compose -p "$compose_project" up -d --no-build --pull never
```

Smoke check after either path (**untested**):

```sh
# untested: replace URL/port if configured differently
docker compose -p "$compose_project" ps
curl --fail http://localhost:8080/api/health
# With app auth enabled: anonymous root must return 401.
curl --output /dev/null --write-out '%{http_code}\n' http://localhost:8080/
# Use the configured username; curl prompts for the password without echoing it.
curl --fail --user board --output /dev/null --write-out '%{http_code}\n' http://localhost:8080/
docker compose -p "$compose_project" logs --tail 100 board runtime proxy
```

Expect health 200, anonymous root 401, authenticated root 200 and a connected runtime.
These health expectations assume the recommended app-auth-only setup. Optional
Caddy proxy auth also protects `/api/health`; use the same prompted `--user` option
for that check when proxy auth is enabled.
Use the configured app/proxy credentials; do not put passwords in command arguments
or captured logs. Investigate an unexpected anonymous 200 before exposing the service.
Open the browser, confirm the canvas loads, find the previous notes/frame/conversation,
check an existing asset and workspace file, send a small frame task, then close/reopen the
tab. HTTP health alone misses a licence or provider failure. Keep the old backup until this
works. Record the new version, image IDs and smoke result; take a fresh backup after changes.

## 3. Restore or roll back with matching state

Rollback means the **old version plus its matching pre-update state**, including auth,
workspaces and daemon history. Never run an old version against state already changed by
a newer version. Restoring loses work since that snapshot. Preserve the failed/new state
in a separate full backup first if you need it. Stop the original project and every writer.

To avoid mixing files with newer state, restore into a **fresh project and fresh volumes**.
Keep the original project down and intact. Choose a unique recovery name; inspect all
projects and ports before starting. Do not run the original and restored installations
at the same time, even on different ports: they have the same saved agent identities/jobs.

```sh
# untested: choose paths and a previously unused project name
set -eu
umask 077
backup='/absolute/private/backup-directory/<snapshot>'
restore_root='/absolute/private/new-empty-restore-directory'
old_project=$(cat "$backup/project.txt")
restore_project='bunnyboard-restore-<unique-lowercase-id>'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker compose -p "$old_project" down
# mkdir intentionally fails if this restore path already exists.
mkdir "$restore_root"
tar xzpf "$backup/source.tar.gz" -C "$restore_root"
# Restore saved deployment files, including .env and any CA/override files.
cp -R "$backup/compose/." "$restore_root/deploy/compose/"
cd "$restore_root/deploy/compose"
docker image load --input "$backup/images.tar"
set -a
. "$backup/images.env"
set +a
```

Compare the restored `.env` with `resolved-compose.yaml`: shell-exported overrides may
not have been written to `.env`. Reapply the reviewed values and adjust host paths; do not
blindly execute the resolved file with its old absolute paths. Check the chosen ports.
For a drill, edit `.env` to use unused
loopback ports for **all three** published ports, update `BOARD_PUBLIC_URL`, and use a
throwaway project name. Any saved outbox work can resume on startup. Never rehearse
with a backup of a live installation or its credentials.

### Prepare a disposable recovery fixture

Start with a fresh disposable installation using the [VPS guide](install-vps.md).
Use only synthetic notes and attachments, no customer data or connected services.
Ask the operator to authorize normal provider login specifically for this test and
the small continuation task after restoration; use the provider's normal login flow
inside this installation. Do not copy credentials from another host or deployment.
If that authorization is unavailable, record live-provider recovery as unverified.
Dummy credentials cannot prove an authenticated conversation can continue.

Complete [the useful-task and restart checks](install-vps.md#6-prove-a-useful-task-and-return),
including the synthetic attachment and workspace-file sentinel. Record the frame,
conversation and file locations. Finish every agent turn and confirm there are no
running tasks, scheduled tasks or pending outbox messages before taking the snapshot.
Use section 1 above to capture this disposable installation's six volumes,
configuration, exact source and running images. Keep its original project stopped.

Use that snapshot with section 3's fresh-project restore commands. After restoration,
confirm the notes, conversation, attachment and workspace sentinel are present, then
send one small operator-authorized continuation request in the same frame. Record any
provider reauthentication as an intervention; do not call dummy-state restoration a
successful live-provider recovery. Keep the original installation stopped throughout.

Use GNU tar from the saved runtime image for extraction. The tested Alpine helper's
tar restored three temporary provider symlinks with root ownership instead of their
saved owner. GNU tar with numeric ownership preserved the complete metadata in the
drill. Keep the helper root user and entrypoint override below; do not invoke the
runtime entrypoint while extracting. Compare restored contents, ownership, modes and
symlink targets with the snapshot before starting services.

The following checks prevent accidentally selecting existing volumes; do not continue if
the project already exists or any target volume is found. `create` makes containers and
initializes their fresh volumes without starting the services.

```sh
# untested: refuse existing recovery volumes, then create stopped containers
test -z "$(docker compose -p "$restore_project" ps -aq)"
for volume in board-state agent-auth workspaces paseo-home caddy-data caddy-config; do
  if docker volume inspect "${restore_project}_${volume}" > /dev/null 2>&1; then
    echo 'Recovery volume already exists; choose a new project name.' >&2
    exit 1
  fi
done
docker compose -p "$restore_project" config --quiet
docker compose -p "$restore_project" create --no-build --pull never
for volume in board-state agent-auth workspaces paseo-home caddy-data caddy-config; do
  volume_name="${restore_project}_${volume}"
  docker volume inspect "$volume_name" > /dev/null
  docker run --rm --user 0 \
    --mount "type=volume,src=$volume_name,dst=/state" \
    --mount "type=bind,src=$backup,dst=/backup,readonly" \
    --entrypoint tar "$RUNTIME_IMAGE" --numeric-owner -xzpf "/backup/$volume.tar.gz" -C /state
done
docker compose -p "$restore_project" up -d --no-build --pull never
```

Repeat the browser/health/first-task smoke checks above, using the restored port. Verify
assets, history and workspace files as well as the canvas. Credentials may still need
refreshing. Persist the recovery image settings from `images.env` in the restored `.env`
and record the new project name before future restarts; shell exports do not survive a
new shell. Keep the old project stopped until you decide which installation to retain.
Do not delete either set of volumes as part of this procedure. A successful recovery is
still **unverified** until you perform the drill and inspect the restored work.
