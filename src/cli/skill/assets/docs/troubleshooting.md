# Troubleshooting

## App is unhealthy but its URL works

```bash
ocd app show my-app
ocd app replicas my-app
ocd app availability my-app
ocd logs my-app --tail=200
ocd ops --app=my-app
```

Compare the configured health mode/path/command/file with the behavior inside
the container. Fix desired health configuration in `.ocd-deploy.json`, preview
it with `ocd deploy --dry-run`, then run `ocd deploy`.

## Local and server configuration differ

```bash
ocd deploy --dry-run
```

The diff is local manifest versus stored desired manifest. If intentional,
apply with `ocd deploy` or `ocd deploy --config-only`.

## Environment not found

Manifest links use environment names, not IDs:

```bash
ocd envs list
```

Correct the manifest `environment`, then rerun deploy.

## Deploy rejects the placement

`Placement server "x" does not exist` means the manifest names a server that
`ocd servers` does not list; use its exact name or numeric ID. A server that is
not `ready` or is a dedicated build worker cannot be placed on. OCD never picks
another server or creates one; fix `placement` or create capacity with
`ocd servers create`. A volume app whose placement names a different server
fails with a pointer to `ocd move <app> --to <server>`, which moves the data.

If a placed server becomes unavailable, its replicas are not rescheduled: the
app stays unhealthy until the server returns or the placement changes. See
[Placement](scaling-storage-and-placement.md#placement).

## Build or release cannot publish/pull an image

For a build, confirm the exact commit is pushed, the Git checkout token can
read the repository, Dockerfile/context paths are repository-relative, and the
OCI token can push. For an artifact-only release, confirm the complete
`repository@sha256:<digest>` exists. Fleet hosts must authenticate to and reach
the registry. Credentials are deliberately withheld when the image host differs
from Admin Settings. Inspect operation logs before retrying.

## Stuck operation

```bash
ocd ops
ocd ops <id>
ocd ops logs <id>
```

Only use cancel, retry, or finalize after inspecting the operation and with
explicit user intent.

## Missing UI or Hetzner key errors after a panel release

Inspect the running panel image digest, its source commit, and the configured
status of the Hetzner settings before asking for credentials again. A release
built from an older committed tree can omit features present in a custom image
or uncommitted workspace. Existing encrypted keys may still be intact while the
older code reads a legacy credential location. Check configured status without
printing credentials.

The OCD panel repository's `.github/workflows/cd.yml` builds on main pushes and
releases the resulting digest through `/webhooks/github/panel-release`. This is
separate from OCD-managed application delivery. Before pushing panel changes,
ensure the release tree contains the running features and keep a verified panel
backup and known-good image digest. Verify the served UI/API after deployment.
A working-tree fix is not live until the running panel and installed CLI contain it.

## Confirmation page does not open

Use the normal CLI mutation command. Its confirmation helper creates a
resource-bound request, launches the OS browser, waits for approval, and sends
the confirmed code to the mutation endpoint. A raw API confirmation request
only returns codes; it does not open the browser. If OS launching fails, open
the printed URL. Never bypass the server confirmation gate or expose the private
confirmation token. Volume deletion additionally requires typing the exact ID.

## A local directory was displayed as a paid volume

Current source separates Hetzner Volumes from local directories in app/server
Storage. Older panel/CLI versions may mix them and show the manifest's requested
size as capacity. A `local:<server-id>:<name>` identity is server-local storage;
verify its actual mount and host free space. Changing that display does not
allocate a Hetzner volume or move data. See [Storage](scaling-storage-and-placement.md#storage).
