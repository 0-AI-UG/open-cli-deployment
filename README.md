<div align="center">

# Open CLI Deployment

**A self-hostable, CLI-first PaaS.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/orgs/0-AI-UG/packages/container/package/open-cli-deployment)

</div>

OCD builds immutable images from Git and deploys them to your servers.

## Bootstrap the panel

Install the CLI directly from the latest GitHub release, then run the guided
bootstrap:

```bash
curl -fsSL https://github.com/0-AI-UG/open-cli-deployment/releases/latest/download/install.sh | sh
ocd bootstrap
```

The wizard can connect an operator-owned Docker host or provision a managed
Hetzner server. It resolves the panel image to an immutable digest, verifies
SSH/provider access, deploys the panel, and opens browser setup. Provider
credentials remain outside configuration:

```bash
OCD_PROVISIONER_TOKEN=... ocd bootstrap --provider=hetzner --domain=panel.example.com
```

Create any printed DNS record, then create the administrator account and
passkey in the browser. Bootstrap waits for that setup, starts CLI login, and
runs the readiness check automatically. Omit `--domain` to use a generated
`nip.io` address instead.

## Deploy with the CLI

Apps use `.ocd-deploy.json`; stacks use `ocd-stack.json`.

```bash
ocd login https://panel.example.com
ocd registry login registry.example.com/team --username=registry-user
ocd source login git.example.com --username=git-user # private Git only
ocd doctor

ocd deploy .ocd-deploy.json
ocd deploy stack ocd-stack.json
```

```bash
ocd logs my-app --tail=200
ocd ssh my-app -i
ocd cp my-app:/tmp/export.tar.gz ./export.tar.gz
```

## Development

```bash
bun install
bun run dev
bun run test
bun run build:cli
```

[Documentation](docs/) · [Contributing](CONTRIBUTING.md) · [MIT License](LICENSE)

Runtime variables are explicit in each app manifest:

```json
{
  "environment": "production",
  "env": {
    "NODE_ENV": "production",
    "DATABASE_URL": { "from": "environment.DATABASE_URL" }
  }
}
```

Create stored values with `ocd envs set` or `ocd envs generate` before deploying.
Deployment resolves references without modifying the environment. Stack members
can reference `apps.database.outputs.URL`; these references infer startup order.
Only mapped user variables are injected, alongside platform and storage variables.
