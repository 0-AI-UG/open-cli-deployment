# Security, authorization, deletion, and retention

## Contents

- [Authentication and CLI access](#authentication-and-cli-access)
- [Sensitive capabilities](#sensitive-capabilities)
- [Confirmation model](#confirmation-model)
- [Deletion matrix](#deletion-matrix)
- [App deletion](#app-deletion)
- [Stack deletion](#stack-deletion)
- [Environment deletion](#environment-deletion)
- [Volume/resource deletion](#volumeresource-deletion)
- [Secret safety](#secret-safety)

## Authentication and CLI access

The browser login/device flow issues a token marked with client type. There
are no roles or per-user permissions: every signed-in user can do everything,
including inviting new users and resetting or deleting other users' accounts
(a user cannot delete their own account). Only invite people you would trust
with the whole fleet.

The one channel rule that remains: manifest-driven desired state (deploys,
stack applies, and manifest-owned resources) is accepted only from CLI-minted
tokens. Browser sessions can operate resources but cannot apply manifests.

## Sensitive capabilities

Every user has all of these, so treat each account as fleet-wide access:

- Reading/writing environment variable values (secrets).
- Browsing volume files and bucket objects (application data).
- Opening a host terminal, which is root-equivalent infrastructure access.
- Cancelling, retrying, or finalizing any user's operations.
- Deleting servers, volumes, and other Hetzner resources/data.

## Confirmation model

High-risk destructive actions use a server-issued, single-use,
resource-bound confirmation. The CLI opens a web page showing an action
summary; the panel itself does not start operations. Approval is bound to:

- user;
- action;
- resource type;
- exact resource ID;
- expiry (about ten minutes).

The confirmation is consumed once. It cannot be replayed for another target.

There is no non-interactive approval token. Confirmation always comes from the
signed-in web UI.

Invariant:

- stack deletion always requires actual web UI approval;
- environment deletion always requires actual web UI approval;
- user-initiated permanent Hetzner volume deletion always requires web UI
  approval and typing the exact Hetzner volume ID;
- the only unattended exception is an expired failed-deploy provisional volume;
  the reconciler rechecks that it has no live OCD owner and is detached in Hetzner,
  then records the deletion in the permanent audit;
- legacy `--yes` automation tokens are rejected server-side for every action.

Bare authenticated stack/environment/volume DELETE requests are
rejected. Permanent volume deletion additionally requires typing the exact
Hetzner volume ID before the server marks the confirmation approved.

## Deletion matrix

| Action | Confirmation | Environment | Managed volume | Other effects |
|---|---|---|---|---|
| Delete app | Web UI always | retained | detached/retained | containers and ingress removed; DNS cleanup shown as manual |
| Delete server | Web UI always | retained | workload volumes retained | cascades through assigned workloads, then deletes the Hetzner server |
| Delete stack | Web UI always | retained | member volumes detached/retained | all recorded apps destroyed |
| Delete environment | Web UI always | explicitly deleted only if unused | n/a | fails while apps link it |
| Cancel operation | Web UI always once compensation is possible | compensation depends on provisional ownership | compensation may detach created volume | runs operation rollback |
| Delete Hetzner volume | Web UI + typed volume ID | n/a | volume data destroyed | irreversible; verify backup/ownership |
| Create server capacity | Web UI always | n/a | n/a | creates one or more billable Hetzner resources |

## App deletion

App deletion:

1. stops/removes containers and app directories;
2. logs the DNS record the operator may remove; it never changes DNS;
3. detaches and retains volumes;
4. deletes app/replica rows only if cleanup gates succeed;
5. rerenders ingress;
6. keeps every server, including servers left empty; only an explicit
   `ocd servers delete` removes one.

It never calls environment deletion. If cleanup partially fails, keep the app
row as `cleanup_failed`.

## Stack deletion

Stack deletion:

1. requires web UI confirmation;
2. enqueues a durable stack-wide destroy operation;
3. enqueues child destroy operations for every app;
4. waits for children;
5. logs retention of the stack's environment;
6. deletes only the stack row.

Confirmation text explicitly states environment and volume retention.

## Environment deletion

Environment retirement:

1. requires web UI confirmation;
2. verifies the exact environment still exists;
3. lists attached apps;
4. refuses deletion when any are attached;
5. records deletion and seven-day recovery timestamps only on explicit
   confirmed request.

There is no force flag.

Deleted environments keep encrypted variables, remain separate from active
selection, and can be listed/restored in the UI or with `ocd envs
deleted`/`restore`. During the seven-day recovery window, the protection can be
overridden only by the Purge button in the web environment view, after typing
the exact environment name. The CLI remains blocked until the window expires;
afterward purge is still a browser-confirmed action.

## Volume/resource deletion

Detachment/retention and Hetzner volume deletion are different operations. App/stack
destroy performs the former. A later explicit volume delete can destroy data
and requires a single-use resource-bound
browser approval, and the exact Hetzner volume ID typed into the approval page.

Before Hetzner volume deletion, verify:

- detached state and exact Hetzner volume ID;
- former owner and intended target;
- backup/checksum;
- no recovery/rollback need;
- billing implications.

OCD creates a durable audit record before Hetzner volume deletion and records the
actor, Hetzner volume identity, former owner, retention state/dates, outcome, and
Hetzner error. Inspect it with `ocd volumes audit`.

## Secret safety

- Store environment secrets encrypted; do not commit them.
- Keep Git checkout and registry tokens out of logs.
- Store the read-only source token and OCI push/pull token only in panel
  Settings. OCD sends the OCI credential only to the host selected by the
  configured repository; review the host before saving it.
- Treat build workers as trusted production infrastructure because repository
  Dockerfiles execute there.
- Prefer container-side access to connection URLs.
- Prefer `--secret-file`, `--secret-stdin`, `--from-env`, or `--from-dotenv` so
  secret values do not appear in process arguments or shell history.
- Do not send tokens, passwords, connection strings, or personal identifiers
  into issue comments, dashboards, or agent-visible output.

## CLI confirmation behavior

Use the normal `ocd delete` / `ocd volumes delete` workflow to open the browser
and wait for the resource-bound approval. Raw API calls do not launch a browser.
Existing user authorization establishes task scope, but the server still
requires its browser confirmation before consuming destructive requests.
Show exact reviewed targets before opening approvals; for volume deletion the
user types the exact volume ID. Do not substitute direct Hetzner Console deletion for
OCD's confirmation and audit workflow.
