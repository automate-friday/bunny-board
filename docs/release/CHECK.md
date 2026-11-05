# Check this Bunny release

Use this page in the extracted release candidate or the reviewed source checkout.
Record `sourceCommit` from `RELEASE.json`, or `git rev-parse HEAD` for a checkout.
Evidence from a different revision does not approve this one. On a fresh VPS,
give a vanilla coding-agent session only `Install this: <repository URL>` and
retain its transcript plus every human input or outside intervention. Follow
[the VPS guide](../install-vps.md) for the installed system's acceptance checks.

Before backup, create a synthetic workspace file with `Bunny restore check 2026`
as its content and upload a synthetic text attachment containing
`Bunny attachment restore check`. Record their locations and open both. Compare
those exact contents after restore; a note-only fixture cannot prove file recovery.

| Step | What I do | What I should see | Failed if |
| --- | --- | --- | --- |
| 1. Install and open | Follow the package README on an empty installation; open localhost:8080 and leave it open for 15 seconds. | The canvas stays visible and the runtime connects. | Blank canvas, licence error, crash, or it depends on the developer's checkout. |
| 2. Use an agent | Sign in through the provider's own login command. Add three synthetic to-do notes, frame them, and ask: “Order these tasks and add a first-step sticky for each.” | A reply and useful new stickies appear inside that frame. | Login is claimed without a working task, the reply never arrives, or work appears on another board. |
| 3. Restart | Close the browser. Run `docker compose restart` from `deploy/compose`, reopen the same address, and continue the conversation. | Notes, frame, conversation and provider access persist. | Work is missing or every restart needs a new login. |
| 4. Restore | On the disposable installation, follow the backup/restore guide using a different empty project and volumes. Keep the original stopped. | The restored notes, attachment, conversation and workspace file match the pre-backup examples. | Only the home page loads, state is missing, or the restore overwrites the original. |
| 5. Check access | With the default configuration, try the published port from another machine. For an explicitly configured HTTPS deployment, test anonymous, wrong-password and correct-password access, then leave the canvas open for 15 seconds. | Defaults are unreachable from another machine. Configured HTTPS rejects anonymous/wrong credentials and works with correct credentials and a valid licence. | Defaults expose the board, credentials travel over public HTTP, or the licensed canvas disappears. |

## Release receipt

The release owner fills this in after running the checks, with links to screenshots
and command results from the exact candidate. A placeholder is not a passing result.

- Candidate source commit and archive SHA-256:
- Tested system and provider:
- Install and persistent canvas: UNVERIFIED
- Useful agent task: UNVERIFIED
- Restart and return: UNVERIFIED
- Backup and restore: UNVERIFIED
- Local-only default exposure: UNVERIFIED
- Authenticated production HTTPS and licence entitlement: UNVERIFIED
- Privacy review of exported source and archive contents: UNVERIFIED

This checks the software handoff. Course signup, lesson access, customer invitations,
and support routing require their own receipts; this page does not claim they exist.
