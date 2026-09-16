# Security policy

## Supported versions

Security fixes are made on the `main` branch and included in the next release.
Only the latest published release is supported; operators should upgrade before
reporting an issue that affects an older version.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's
[private vulnerability reporting](https://github.com/0-AI-UG/open-cli-deployment/security/advisories/new)
to share a description, affected versions, reproduction steps or proof of
concept, and the impact you expect. Remove live credentials, customer data, and
other third-party secrets from the report.

The maintainers will acknowledge the report, investigate it, and coordinate a
fix and disclosure with the reporter. Please allow time for a patch to be
prepared and released before publishing details.

## Deployment security

OCD manages privileged infrastructure credentials and root SSH access. Review
the security and deletion guide, use scoped provider and registry credentials,
keep the panel private where possible, and back up its data and recovery key.
Never use `SKIP_2FA=1` outside local development.
