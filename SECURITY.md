# Security Policy

## Reporting A Vulnerability

If you find a security issue, such as a way to crash the multiplayer server, hijack another player's seat, exfiltrate data from a hosted instance, or otherwise endanger users running this code, please report it privately rather than opening a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/EscadronRogue/Basileus/security/advisories/new) for this repo.

Please include:

- A description of the vulnerability and its impact.
- Reproduction steps or a proof of concept, including the commit hash you tested against.
- Any suggested mitigation, if you have one.

You can expect an acknowledgement within a few days. There is no bug-bounty program; this is a personal project.

## Supported Versions

Only the `main` branch is supported. Older commits and branches are not maintained.

## Scope

In scope:

- The Node multiplayer server (`multiplayer/`)
- The browser game when hosted on GitHub Pages

Out of scope:

- Issues that require a malicious extension already installed in the user's browser
- Denial-of-service against a server you do not own
- Findings against forks that have modified the code
