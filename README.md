<div align="center">

# Open CLI Deployment

**A self-hosted, CLI-first platform for deploying containers to your own servers.**

[![CI](https://github.com/0-AI-UG/open-cli-deployment/actions/workflows/ci.yml/badge.svg)](https://github.com/0-AI-UG/open-cli-deployment/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/0-AI-UG/open-cli-deployment)](https://github.com/0-AI-UG/open-cli-deployment/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/container-GHCR-blue)](https://github.com/orgs/0-AI-UG/packages/container/package/open-cli-deployment)

</div>

Open CLI Deployment (OCD) builds immutable OCI images from Git and reconciles
them onto Linux servers. You operate it through the `ocd` CLI while a small,
self-hosted panel keeps desired state, credentials, deployment history, and
recovery operations in one place.

## Why OCD?

- **Your infrastructure:** connect an existing Docker host or optionally
  provision servers and volumes on Hetzner.
- **Immutable releases:** deployments and rollbacks use digest-qualified images.
- **Git-based configuration:** keep single-app or multi-app manifests beside the
  code they deploy.
- **Operational controls:** inspect logs, open a shell, copy files, pause, scale,
  promote, roll back, and recover failed operations from the CLI.
- **Portable integrations:** use HTTPS Git hosts, OCI registries, and
  S3-compatible object storage rather than a closed hosting ecosystem.

## Requirements

To run a panel you need one of the following:

- a Linux server with Docker, a public IPv4 address, and root SSH access; or
- a Hetzner Cloud account and API token for guided provisioning.

The CLI supports macOS and Linux on x64 and arm64. App builds require an OCD
BuildKit worker or a prebuilt image in an OCI registry.

## Quick start

Install the latest CLI release and start the guided bootstrap:

```sh
curl -fsSL https://github.com/0-AI-UG/open-cli-deployment/releases/latest/download/install.sh | sh
ocd bootstrap
```

The wizard connects an operator-owned Docker host or provisions a managed
Hetzner server. It verifies access, deploys the panel, and guides you through
browser setup. Omit `--domain` to use a generated `nip.io` address:

```sh
OCD_PROVISIONER_TOKEN=... ocd bootstrap \
  --provider=hetzner \
  --domain=panel.example.com
```

Once the panel is ready, log in and check that all deployment prerequisites are
configured:

```sh
ocd login https://panel.example.com
ocd registry login registry.example.com/team --username=registry-user
ocd source login git.example.com --username=git-user # private Git only
ocd doctor
```

## Deploy an app

Applications are described by a `.ocd-deploy.json` manifest. A minimal app
built from Git looks like this:

```json
{
  "$schema": 1,
  "name": "Example API",
  "build": {
    "repository": "https://github.com/example/example-api.git",
    "branch": "main",
    "dockerfile": "Dockerfile",
    "image_repository": "ghcr.io/example/example-api"
  },
  "container_port": 3000,
  "health_check": { "path": "/healthz" },
  "environment": "production",
  "env": {
    "NODE_ENV": "production",
    "DATABASE_URL": { "from": "environment.DATABASE_URL" }
  }
}
```

Validate and deploy it:

```sh
ocd manifest validate .ocd-deploy.json
ocd deploy .ocd-deploy.json
ocd logs example-api --tail=200
```

Use `ocd envs set` or `ocd envs generate` to create referenced values before
deploying. Stack manifests can connect multiple apps and infer startup order
from references such as `apps.database.outputs.URL`.

## Documentation

Start with the [documentation index](docs/README.md) for concepts, manifests,
infrastructure, networking, storage, releases, and recovery. The CLI also ships
the complete deployment guide as an installable skill for supported coding
agents:

```sh
ocd skill list
ocd skill install --agent <agent>
```

## Development

OCD is built with Bun, TypeScript, React, and Docker.

```sh
git clone https://github.com/0-AI-UG/open-cli-deployment.git
cd open-cli-deployment
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and pull
request checklist. Please report security issues according to
[SECURITY.md](SECURITY.md), not in a public issue.

## License

Open CLI Deployment is available under the [MIT License](LICENSE).
