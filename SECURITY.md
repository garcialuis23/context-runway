# Security Policy

context-runway reads and writes local files only (`~/.claude/settings.json` and
`~/.claude/context-runway/usage-history.jsonl`). It has no network calls and no
runtime dependencies. Still, if you find a security issue, please report it
responsibly.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, use [GitHub's private vulnerability reporting](../../security/advisories/new)
for this repository, or email the address on the maintainer's GitHub profile.

Include:
- A description of the issue and its impact
- Steps to reproduce
- Affected version/commit

You should get an initial response within a few days.

## Supported versions

This project is pre-1.0 and moves fast. Only the latest version on `main` is
supported — please make sure you can reproduce the issue there before
reporting.
