# Board authentication

The board server has one optional gate: HTTP basic auth, set by two environment
variables on the board process.

| Variables | Result |
|---|---|
| neither `BUNNYBOARD_AUTH_USERNAME` nor `BUNNYBOARD_AUTH_PASSWORD` | auth off. Keep loopback-only unless you add separate authentication and encryption. |
| both set (non-empty) | auth on. The canvas, `/api/ui/*` (including the SSE stream), `/api/assets/*`, artifact files and the `/api/connect` websocket all need the credentials. |
| only one set, or either set but empty (`BUNNYBOARD_AUTH_PASSWORD=` counts as set) | the board refuses to start (`basic auth is half configured`): the check runs first, before any state, hook, timer or connection, so a standalone board exits with status 1 and a Paseo plugin contribution throws without starting anything. |

**Basic auth needs protected transport.** The browser sends the username and password with every
request, base64-encoded, not encrypted. Outside trusted loopback or an encrypted
private transport, credentials are exposed. HTTPS requires a valid tldraw production
licence key in the canvas build as well as a certificate; see the
[HTTPS setup](../deploy/compose/README.md#tldraw-licence-and-https). A complete licensed
production installation remains unverified. An SSH tunnel provides encrypted access
for the initial installation check. Plain LAN HTTP does not supply encryption.

**Any board reachable from outside a private network must run with auth on**, either
these variables or the compose proxy's basic auth (below). There are no user accounts,
sessions or login page: the browser's own basic-auth prompt is the login.

Values come only from the environment. Never put them in `config.json`, the repo or a
compose file; use a secret store or an untracked `.env`. The server never logs or
echoes them: a refusal is a plain `401` with `WWW-Authenticate: Basic realm="Bunnyboard"`.
The username must not contain `:`.

## What stays open

- `/api/agent/boards/<board>/frames/<frame>/<op>`: the frame agents' API. Agents
  send `Authorization: Bearer <frame token>`, which the server checks against the
  frame's current binding exactly as before. Basic credentials do not open it, and a
  frame token opens nothing else (not the canvas, UI API, assets or websocket).
- `/api/health` without credentials answers `{"ok":true}` only (no board ids), so
  container health checks keep working. With credentials it returns the full answer.
- `OPTIONS` preflights get an empty `204`, as before.

Origin checks are unchanged: with auth on, a browser still needs an allowed Origin for
the UI API and the websocket.

## With Docker Compose

`deploy/compose` publishes the proxy on `127.0.0.1` only, and the board's direct port on
`127.0.0.1:8793`. Turn auth on before publishing either on another interface.

- **App auth (recommended).** Write both variables to `deploy/compose/board-auth.env`
  (gitignored, kept out of the image build). The board service reads that file as an
  optional `env_file` (Docker Compose v2.24 or newer), so only the keys written there
  reach the board: no file means auth off, an empty value makes the board refuse to start.
  Values in `.env` are **not** forwarded. App auth also covers the direct port and the
  websocket, and frame agents keep using their bearer tokens on `/api/agent/*`.
- **Proxy auth** (`BOARD_AUTH=on`, `BOARD_AUTH_USER`, `BOARD_AUTH_HASH`, optional): Caddy
  asks for the password on every path except `/api/agent/*` (exact lowercase, after
  path cleaning, so `/API/AGENT/`, `/api/agent/../`, `//api/agent/` and
  `/api%2Fagent/` still need it), which it passes to the
  board, where the frame token is still required. A frame token opens nothing else.
  Caddy auth does not cover the direct port `127.0.0.1:8793`: anyone with a shell on the
  host gets in there unless app auth is on too. `BOARD_AUTH=on` with an empty hash, or
  any `BOARD_AUTH` other than `on`/`off`, is a Caddy configuration error.
- **Both**: Caddy passes the `Authorization` header through, so the browser's one set of
  credentials must satisfy both: the same username, and the password whose bcrypt hash
  is `BOARD_AUTH_HASH`. Different credentials on the two layers lock the browser out.

Runtime agents in the `runtime` container reach the board on the compose network
(`BOARD_AGENT_URL=http://board:8793`), not through Caddy.

## Turning it on

Command status: the following standalone-process example is **untested** in the
2026-11-01 documentation pass. It does not configure Compose container environment.

```sh
export BUNNYBOARD_AUTH_USERNAME=board
export BUNNYBOARD_AUTH_PASSWORD="$(openssl rand -base64 24)"   # keep it in your secret store
```

then restart the board process. The log line `basic auth on` confirms it.

## Trust boundary

Use one installation for one trusted operator or group with the same access rights.
Bunny is not a multi-tenant service. Anyone allowed to control the board can start
agents with the configured shell permissions (including bypass/full-access modes).
The runtime shares workspaces, provider login files and board state under one Unix
user. An agent with shell access can read other workspaces and the board signing
secret; frame-token API scope does not create filesystem or credential isolation.

Do not invite untrusted users to this installation or mount host secrets, the Docker
socket, or unrelated data into it. Use separate hosts/volumes/provider accounts for
separate trust domains. Review instructions from uploaded files and external content
before giving agents sensitive access. Container isolation is not a substitute for
trusting the code and agents you run.
