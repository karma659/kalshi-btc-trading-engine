# Security Policy

## Supported version

Security fixes are applied to the current `main` branch.

## Reporting a vulnerability

Do not open a public issue for:

- exposed credentials or private keys;
- authentication or signature defects;
- ways to bypass paper/live safeguards;
- unauthenticated remote control exposure;
- order, fill, or position-reconciliation vulnerabilities;
- account or personal data exposure.

Use GitHub's private vulnerability reporting flow:

`https://github.com/karma659/kalshi-btc-trading-engine/security/advisories/new`

If private reporting is unavailable, contact the maintainer through the GitHub profile without including exploit details in a public thread.

Include:

- affected commit;
- reproduction steps;
- expected and actual behavior;
- impact;
- suggested mitigation, if known.

## Secret handling

The project expects credentials only through ignored local files and an external PEM path. If a secret appears in Git history, revoke it immediately; deleting the latest copy is not sufficient.

## Operational boundary

The dashboard control routes are intended for a trusted local operator and are not authenticated. The default server and Compose configuration bind to loopback. Any remote deployment must add authentication, TLS, network restrictions, rate limiting, and an explicit secrets-management design.
