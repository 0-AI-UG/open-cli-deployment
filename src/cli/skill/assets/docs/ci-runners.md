# GitHub Actions CI runners

OCD manages GitHub Actions runners on dedicated servers or shared OCD build servers. GitHub owns workflows, job
scheduling, workflow logs, artifacts, and check results. OCD owns installation,
health, registration, draining, updates, removal, and optional deployment gates.
Application and panel servers cannot run CI. Sharing with BuildKit is an explicit scheduling mode.

## Connect GitHub

Create a GitHub App and install it on the **selected private repositories** you
want to use. Repository permissions:

- Administration: read and write (register and remove repository runners).
- Checks: read (verify deployment requirements).
- Actions: read (inspect workflows in GitHub).
- Metadata: read (included by GitHub).

No CI webhook subscription or callback URL is required. Runners connect outbound
to GitHub; OCD periodically reconciles their lifecycle. Existing signed push
webhooks still trigger OCD delivery.

Generate an RSA private key in the App settings, find the numeric App ID and the
installation ID (in the installation settings URL), then connect:

```bash
ocd ci connect github --app-id=123 --installation-id=456 --private-key-file=./github-app.pem
```

Alternatively configure the App in panel Settings → Builds → GitHub Actions CI.
The private key is encrypted in the panel secret store and is never returned by
the API. Only short-lived registration credentials reach CI hosts. Existing Git
checkout and registry connections are separate and are not copied to CI hosts.
You can rotate the key in place. Drain all runners before switching installations.

For an existing GitHub account connection, a token can instead be supplied over
stdin: `gh auth token | ocd ci connect github --token-stdin`. It stays encrypted
on the panel and is never copied to runner hosts. Organization runners require
`admin:org` for an OAuth/classic token (plus `repo` for private-repository reads),
or the equivalent fine-grained organization self-hosted-runner and repository
metadata/check permissions. Prefer a dedicated GitHub App for long-lived use.
An App used for organization runners needs Self-hosted runners (organization):
read and write, in addition to the repository read permissions above.

## Install runners

Provision an empty OCD-managed x86_64 Linux server, then reserve it for CI:

```bash
ocd servers create --name=ci-1 --type=cx23 --location=nbg1
ocd ci install --server=ci-1 --repository=owner/repo
ocd ci ls
```

To share a server across selected private repositories, create an organization
runner group in GitHub with **Selected repositories** and public repositories
disabled, then supply its numeric group ID:

```bash
ocd ci install --server=ci-1 --organization=your-org --runner-group=77
```

OCD validates the selected private repositories before installation and on health
checks. GitHub enforces the group boundary when assigning jobs. A broader or
public group causes OCD to drain the runner. Existing groups are not modified.

Repeat on another server for more parallel capacity. GitHub registrations use a unique internal name so recovery cannot adopt an
unrelated runner with the same display name. Each server runs one job
at a time and is scoped to one private repository or an organization runner group
with an explicit private-repository allowlist. A CI reservation blocks app placement and server deletion, including during
installation failures. Dedicated mode also blocks BuildKit worker installation. The host must already have OCD's normal Docker setup.

Select these runners in `.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    name: Test
    runs-on: [self-hosted, linux, x64, ocd-ci]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun test
```

This is a minimal runner host, not GitHub's `ubuntu-latest` tool image. Install
needed language runtimes using setup actions. Docker container actions and
service containers can use the host's Docker installation.

## Lifecycle and trust

Each runner registration handles one job (`--ephemeral`). OCD observes service
exit, removes any stale GitHub registration, preserves diagnostic logs, replaces
the runner/work directory, downloads the latest verified official Linux x64
runner package as needed, and registers the next runner. Reconciliation normally
runs every 30 seconds; package preparation adds some startup time. GitHub queues
jobs while no matching runner is available.

These are **persistent hosts for trusted private repositories**. Single-job
registration and workspace replacement do not rebuild the machine or isolate
jobs from a compromised previous job. Workflows have Docker access, which gives
control of the host. Before replacement OCD removes containers, unused Docker networks/volumes,
and the runner user's home contents. Tool caches and images can persist. Workflows
have passwordless sudo for setup steps; this remains a trusted-host model. Do not use these hosts for untrusted contributions or
public repository PRs. Disposable VMs and autoscaling are not part of this version.

GitHub retains workflow logs. Before replacing or removing a runner, OCD copies
runner diagnostic archives to `$OCD_DATA_DIR/ci-logs/<runner-id>/` on the panel,
keeping the newest ten archives with private filesystem permissions. Logs can
contain sensitive workflow data; treat them as secrets. The host also keeps up
to ten diagnostic archives in `/var/log/ocd-ci/` during normal job replacement.

```bash
ocd ci drain ci-runner-name
ocd ci status
ocd ci resume ci-runner-name
ocd ci retry ci-runner-name
ocd ci remove ci-runner-name
```

Drain lets an active job finish and removes the registration once idle. GitHub
can assign work during the idle check; if deletion reports a conflict OCD leaves
the job running and retries on a later reconciliation. Wait for `drained` before
removing. Removal retains the server, Docker state, and diagnostic archives;
reimage the host before repurposing it across trust boundaries. If removal is
requested while a job is active, the operation fails safely with a drain-first
message; drain continues in the background and removal can be retried.

Use `ocd ops` / `ocd ops logs <id>` for lifecycle failures, or panel Settings →
Builds for runner health and links to GitHub Actions. Failed installation keeps
the server reserved; `ocd ci retry` retries it. An engine restart resumes durable
operations and reconciles existing GitHub registrations without starting a
second runner on the same host. Runner removal needs GitHub connectivity and the
original App installation's permissions; restore that access before retrying.

## Require successful CI before deployment

Runner installation alone does not make deployments wait for tests. Configure a
policy for the build source shown by `ocd runners sources`:

```json
{
  "checks": [{ "name": "Test", "app_id": 12345 }],
  "timeout_seconds": 3600
}
```

Use the actual check-run name and producing GitHub App ID from your repository's
check-runs API response. The example App ID is illustrative; replace it with the actual provider ID.
For example: `gh api repos/OWNER/REPO/commits/SHA/check-runs --jq '.check_runs[] | {name, app_id: .app.id}'`. This is the check's producer, **not**
the App ID used to connect OCD. Matrix jobs may have distinct check names.

```bash
ocd ci checks 1 --file=ci-policy.json
ocd ci checks 1
```

OCD checks the exact delivery commit, check name, and provider ID before building
and again before manifest reconciliation. It selects the newest matching run;
a pending retry blocks even if an older run succeeded. Only `success` passes;
failed, cancelled, skipped, neutral, and timed-out checks fail the delivery.
Missing checks wait until the configured timeout (60–86400 seconds, measured
from operation enqueue time). Superseded or cancelled deliveries stop waiting.
No build-worker slot is held while awaiting checks.

The policy covers GitHub push deliveries and `ocd runners deploy` repository
releases. Manual `ocd deploy`, image deployments, and artifact-only `ocd release`
keep their existing behavior and do not use this source policy. A policy with
`"checks": []` disables the gate. CI never receives panel deployment credentials.

GitHub references: [runner lifecycle](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[runner API](https://docs.github.com/en/rest/actions/self-hosted-runners),
[check-runs API](https://docs.github.com/en/rest/checks/runs),
[self-hosted runner security](https://docs.github.com/en/actions/reference/security/secure-use).

## Share a build server with CI

Use `--share-builds` on any ready OCD build worker. This opt-in mode supports both
repository and organization runners, without changing application placement:

```bash
ocd ci install --server=my-builder --organization=my-org --runner-group=77 --share-builds
```

The server stays dedicated to trusted build/CI work. One workload owns it at a
time. Admission is atomic between the build-worker lease and a durable CI host
reservation. The CI service also takes the same host `flock` as OCD builds.
Reservations do not expire merely because the panel restarts or loses access;
cleanup must positively finish before build capacity is released.

Shared CI registers only when matching `ocd-ci` jobs are queued in the selected
private repositories. Idle queue polling runs about once a minute. Waiting
builds take priority over new CI admission. A build waiting for required CI
checks does not claim a build slot, so the checks can run on the same machine.
An idle registered runner yields to a waiting build or retires after 60 seconds.
An already assigned CI job is allowed to finish before a build takes over.

OCD stops its idle BuildKit container during CI to release memory. It preserves
the builder container, data volume, and cache while cleaning CI containers and
home files. On job exit it restores BuildKit and verifies cleanup before freeing
the host. Low-disk cleanup trims caches; immutable runtime artifacts remain in
the registry. Shared-worker removal requires removing its CI role first.

`--job-timeout-minutes=30` sets the runner lifetime bound (1–360 minutes, plus a
minute for startup/cleanup). Set workflow `timeout-minutes` within that bound.
Build capacity waits account for this configured CI limit. Long jobs can delay
a deployment; queue priority does not interrupt an active job.

This mode is for mutually trusted repositories. Both Dockerfiles and CI jobs
can control the host. Separate users, sequential execution, and cleanup do not
provide VM isolation against malicious code; use separate/disposable hosts for
different trust boundaries.
