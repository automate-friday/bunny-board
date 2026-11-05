#!/bin/sh
# Agent runtime container entrypoint.
#   daemon (default)       run the Paseo daemon in the foreground on $PASEO_LISTEN
#   login [claude|codex]   sign the agent CLIs in; logins land in the agent-auth volume
#   status                 show which agent CLIs are signed in
#   anything else          run it (e.g. `sh`, `claude --version`)
set -e
cmd="${1:-daemon}"
[ $# -gt 0 ] && shift

login_claude() {
  echo "== Claude Code: open the link, sign in, paste the code back here =="
  claude auth login "$@"
}
login_codex() {
  echo "== Codex: open the link and enter the code it shows =="
  codex login --device-auth "$@"
}

case "$cmd" in
  daemon)
    exec paseo daemon run --home "$PASEO_HOME"
    ;;
  login)
    which="${1:-all}"
    [ $# -gt 0 ] && shift
    case "$which" in
      claude) login_claude "$@" ;;
      codex) login_codex "$@" ;;
      all)
        login_claude || echo "(claude login skipped or failed; run: docker compose run --rm runtime login claude)"
        login_codex || echo "(codex login skipped or failed; run: docker compose run --rm runtime login codex)"
        ;;
      *) echo "usage: login [claude|codex]" >&2; exit 2 ;;
    esac
    echo "== Signed in. Agents started from the board use these logins. =="
    ;;
  status)
    echo "claude: $(claude auth status 2>&1 | tr -d '\n' | cut -c1-200)"
    echo "codex:  $(codex login status 2>&1 | tr -d '\n' | cut -c1-200)"
    ;;
  *)
    exec "$cmd" "$@"
    ;;
esac
