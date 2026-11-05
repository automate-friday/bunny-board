# Code lifted from Paseo

The `.ts` files in this directory are copied, and in places adapted, from
[getpaseo/paseo](https://github.com/getpaseo/paseo) v0.11.4.

    Copyright (c) 2025-present Mohamed Boudra

They are licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). Each file's header names its
source path and lists the changes made for the board (import paths, i18n
strings replaced by Paseo's English strings, StreamItem adapted to board rows,
dependencies on zod, lucide and @getpaseo/highlight removed).

The React views that use them (`canvas/src/TimelineItemView.tsx`,
`canvas/src/AgentControlsBar.tsx`, `canvas/src/PermissionCards.tsx`) are new DOM
code written for the board, modelled on the behaviour of Paseo's React Native
components (`components/message.tsx`, `components/tool-call-details.tsx`,
`agent-stream/view.tsx`, `composer/agent-controls`). They copy no markup or
styles from Paseo.
