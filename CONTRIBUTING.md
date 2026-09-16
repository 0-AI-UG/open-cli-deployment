# Contributing to Open CLI Deployment

Thanks for helping improve OCD. Bug reports, documentation fixes, tests, and
focused code changes are all welcome.

## Before you start

- Search [existing issues](https://github.com/0-AI-UG/open-cli-deployment/issues)
  before opening a new one.
- For a substantial feature or architectural change, open a proposal first so
  maintainers and contributors can agree on scope before implementation.
- Do not report vulnerabilities in a public issue. Follow
  [the security policy](SECURITY.md) instead.

## Development setup

### Prerequisites

- [Bun](https://bun.sh/) 1.3.5 or newer in the 1.x release line
- Docker with Buildx for image and build-worker tests
- Git

Fork the repository, then clone your fork:

```sh
git clone https://github.com/YOUR-USER/open-cli-deployment.git
cd open-cli-deployment
git remote add upstream https://github.com/0-AI-UG/open-cli-deployment.git
bun install --frozen-lockfile
```

Create a branch from an up-to-date `main`:

```sh
git fetch upstream
git switch -c fix/short-description upstream/main
```

## Common commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the development panel on port 3001 with 2FA bypassed |
| `bun run start` | Start the panel in production mode |
| `bun run typecheck` | Check TypeScript types |
| `bun run test` | Run isolated unit and route tests |
| `bun run build` | Build the web application |
| `bun run build:cli` | Compile release CLI binaries |
| `bun run test:integration` | Run opt-in integration tests |
| `bun run test:component:build` | Test BuildKit and registry integration |

The default test command explicitly disables live provider tests, even if your
shell contains cloud credentials. Integration and component tests are opt-in
because they require external services or Docker configuration.

## Making a change

1. Keep each pull request focused on one problem.
2. Add or update tests when behavior changes.
3. Update user-facing documentation and examples when interfaces change.
4. Never commit tokens, generated databases, local configuration, or customer
   data. Use reserved example domains and documentation IP ranges in fixtures.
5. Run the relevant checks locally before opening the pull request.

At minimum, most changes should pass:

```sh
bun run typecheck
bun run test
bun run build
```

Changes to CLI compilation or embedded agent documentation should also run
`bun run build:cli`. Changes to build infrastructure should run the relevant
component test when Docker is available.

## Pull requests

In the pull request description, explain the problem, the chosen approach, and
how you verified the result. Include screenshots for visible panel changes and
call out migrations, compatibility concerns, or operational risk explicitly.

Maintainers may ask for a change to be split if it combines unrelated behavior.
All CI checks must pass before merge. By contributing, you agree that your
contribution is licensed under the repository's [MIT License](LICENSE).
