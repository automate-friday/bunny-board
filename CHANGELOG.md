# Changelog

Dates identify reviewed source snapshots in UTC.

## [2026.11.13] - 2026-11-13

### Added

- Images can be dropped, pasted, or picked in desktop and portal chats, previewed before sending, and shared with the frame's agent.
- Jump between earlier messages using the chat sidebar's message markers and previews. A Jump to latest button returns to the newest output when you scroll up.
- Source packages include a dated changelog with public change notes.

### Changed

- Each reply in the conversation panel now ends with Copy and Fork from here buttons, and older messages load as you scroll up.
- Chat navigation now uses subtle magnifying markers without narrowing messages, a timestamped message picker on phones, clear history shortcuts, and a compact return-to-latest arrow. Message jumps stay within their chat pane.
- Document the verified Ubuntu VPS install, Codex browser tasks, restart and fresh-volume recovery, with remaining licensing and backup limits. Restore volumes with GNU tar to preserve symlink ownership.

### Fixed

- Channel badges and offers stay behind portal windows and conversation panels, keeping portal chat clear and usable.
- The photo button, reply field, and Send button now align in desktop and portal chats, with consistent touch sizes on phones.
- Conversation menus stay fully visible inside narrow chat panels.
- Docker builds support restrictive checkout permissions. Developer preview documentation clarifies self-hosting costs, canvas licensing and verified provider login.
- A frame whose conversation could not be found now recovers on its own when the conversation is reachable again, and status updates that arrive while a frame is still starting no longer change its colour early.
- Agents can read a selected board page and continue through large results without losing shapes to the previous output limit.
- Portal badges and windows stay behind conversation panels so opening messages and panel controls remain usable.
- Messages between connected frames now wait for the receiving agent to finish its current turn. Queued messages survive a restart, keep their delivery status, and are canceled if the connection is removed before delivery.
- Next-step suggestions now appear in Docker installs, where the board server has no Claude CLI, and the message box says why when none can be made.
- Failed or canceled agent turns leave the working state promptly. Replies can proceed after a terminal error even when old turn details remain attached.

## [2026.11.05] - 2026-11-05

### Added

- Initial source-available release of Bunny.

### Changed

- Bunny uses the Business Source License 1.1 and converts to Apache 2.0 four years after each version's first public release.

Earlier changes are not itemised.
