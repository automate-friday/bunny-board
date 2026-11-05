# Bunny Board installation and contribution guide

When asked to install this repository on a VPS, follow [docs/install-vps.md](docs/install-vps.md).
It covers prerequisites, private access, authentication, provider login, a useful task,
restart and recovery. Ask the operator for required login or host information that
cannot be discovered. Do not invent credentials, weaken access controls or claim a
production licence is present without evidence. Do not copy credentials into reports.

Use [README.md](README.md) for a local installation. Preserve existing data and config
when updating. A running container alone does not establish a successful installation.

This is the public release repository. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
proposing a change. Public patches are reference material; maintainers implement and
test changes independently in the private source, then publish a reviewed snapshot.
Do not merge public pull requests or run privileged automation against their code.
