# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in this project,
please report it **privately**. **Do not open a public GitHub issue.**

### How to report

- **GitHub Private Vulnerability Reporting** (preferred, if enabled on this
  repo): [Report a vulnerability](../../security/advisories/new)
- **TechX Maestro contact**: <https://techxmaestro.com>

Please include:

- A clear description of the issue and its potential impact
- Steps to reproduce or a minimal proof-of-concept
- Affected version / commit hash
- Any mitigations or workarounds you've identified

We will acknowledge receipt and coordinate on disclosure timing. Please
allow a reasonable window before any public disclosure.

## Scope

**In scope**: TechX Maestro source contained in this repository, including
configuration, deployment scripts, and first-party services.

**Out of scope**:

- Third-party dependencies (librespot, etc.) &mdash; please report upstream
- Denial-of-service against demo or production instances
- Attacks requiring physical access to user-owned hardware
- Social-engineering of the repository owner
- Reports from automated scanners without validated impact

## Recognition

We're happy to credit responsible reporters in release notes or commit
messages if you would like to be acknowledged. We do not currently offer a
bug bounty.

## Scope of secrets in this repo

This repository should not contain secrets, API keys, or credentials. If
you discover any in the commit history, please report it privately so we
can rotate and purge. Do not post it publicly.
