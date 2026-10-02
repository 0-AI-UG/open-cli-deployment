# Scaling, Storage, and Placement

## Placement

Every manifest declares `placement`: which servers run the app and how many
replicas each server runs. Keys are server names as shown by `ocd servers`
(a numeric server ID also works); values are replica counts of at least 1.

```json
{
  "placement": { "server-2": 1 }
}
```

Run two replicas on two servers:

```json
{
  "placement": { "server-2": 1, "sight-capacity-1": 1 }
}
```

Apply with `ocd deploy`. OCD never chooses servers or replica counts on its
own and never creates servers: it runs exactly the declared replicas on exactly
the declared servers. Every named server must exist, be `ready`, and not be a
dedicated build worker, otherwise the deploy fails. The panel server is a
valid placement. Create capacity explicitly with `ocd servers create`.

Convergence is per server. Missing replicas start on their declared server and
surplus ones are removed. When a placement drops a server, its replicas are
removed only after the replicas on the declared servers are healthy. If a
declared server becomes unavailable, OCD does not reschedule its replicas
anywhere else: the app reports unhealthy until the server returns or you change
the placement. Use `ocd pause` / `ocd unpause` to stop and start an app
manually.

## Moving an app

Move every replica an app runs on one server to another server:

```bash
ocd move my-app --to sight-capacity-1
ocd move my-app --from server-2 --to sight-capacity-1   # app placed on several servers
```

Stateless apps start their replicas on the target before the source replicas
are removed. Apps with a primary volume stop, move their portable volume to the
target, and restart there. `ocd move` records the new placement; update
`placement` in the manifest to match so the next deploy keeps it. Deploying a
volume app with a different placement server fails and asks for `ocd move`.

## Storage

Declare the primary `volume` and `extra_volumes` in the manifest. The primary
`volume` field is required: `null` means no attached volume, an object without
`id` means an OCD-managed volume, and an object with `id` adopts that exact
Hetzner volume. `ocd deploy` is the only topology/size/path mutation path.

Use `ocd volumes` and `ocd resources` only to inspect volumes, browse files,
review deletion audit records, or permanently delete
an unused volume. The browser shows manifest intent and observed attachment as
separate read-only state; it has no volume controls.

There are two drivers. `hetzner-block` is a Hetzner volume that can be detached
and moved to another server. `local-directory` is a server-local directory.
Inspect the actual driver and mount
instead of inferring it from the server's location or a manifest size.
Server-local directories live under `/var/lib/ocd/volumes`; they survive
container replacement but share the host disk, have no separate storage charge,
and have no reserved capacity or enforced quota. Changing their configured size
does not allocate disk. They and explicit host mounts cannot be moved to another
server with `ocd move`.

### Inventory and disk usage

- Infrastructure → Volumes and `ocd volumes` list Hetzner volumes only,
  with capacity, attachment and estimated Hetzner cost. A successful Hetzner
  listing excludes stale records for disks that no longer exist.
- App → Storage and `ocd app show <app> --storage` show persistent mounts and
  measured usage; the CLI also shows image storage.
- Server → Storage and `ocd servers show <name|id> --storage` show server-local
  directories, including retained directories, alongside the server's disk metrics.

Local entries show host, path, usage, and “shares server disk · no separate
storage charge”. Usage is cached for up to one minute; failed inspection shows
unavailable, not zero. The requested manifest size is not displayed as local
capacity. Inspect server free space because images and other workloads share it.

### PostgreSQL placement

Verify `SHOW data_directory` and its mount after deploying or consolidating a
database. A host directory is persistent across containers but does not provide
an independently detachable Hetzner volume. Preserve the requested storage type
when migrating; choosing a separate Hetzner volume requires the `hetzner-block`
driver and confirmation of the actual volume attachment.

An app with a primary volume must be placed on exactly one server with one
replica. Placement does not configure PostgreSQL replication. Database replication needs separate data
stores and database-aware orchestration; introduce it when availability or read
load requirements justify the additional operations.
