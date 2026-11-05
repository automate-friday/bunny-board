# Third-party requirements

Bunny uses the tldraw SDK. The SDK is source available under the tldraw licence;
it is not covered by a permissive open-source licence. Production use requires an
applicable trial, commercial, or hobby licence. A download of Bunny does not grant
that entitlement to the recipient.

The SDK's technical development-mode detection is not a grant to distribute an
unlicensed production application. In particular, a canvas that renders over local
HTTP does not establish permission for customer use. For self-hosted distribution,
confirm the appropriate entitlement and host coverage with tldraw before release.
Do not patch or disable its licence checks.

Official references, checked 2026-11-01:

- [SDK licence and downstream use](https://tldraw.dev/community/license)
- [Production licence-key configuration](https://tldraw.dev/sdk-features/license-key)
- [SDK licence text](https://github.com/tldraw/tldraw/blob/main/LICENSE.md)

Keep dependency copyright and licence files. The supplied npm lockfiles record the
dependency versions; npm installation includes their package notices. Container images
also contain Node.js, operating-system packages, Caddy, Paseo, and the provider CLIs,
which retain their own terms. Claude and Codex require the recipient's own supported
account and usage authorization.

This source package preserves [Paseo's copied-code notice](../../canvas/src/paseo/NOTICE.md)
and includes the [Apache 2.0 licence text](LICENSE-APACHE-2.0.txt) for that code.
It also includes [tldraw's licence text from v5.2.2](LICENSE-TLDRAW.md).
These texts retain their original scope; neither relicenses Bunny's own code.

No project licence is invented or granted by this document. It is an installation
requirement and attribution guide, not legal advice or a substitute for the actual terms.
