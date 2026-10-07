# Hetzner Infrastructure

OCD runs on Hetzner Cloud only. A Hetzner API token is required: every server
is a managed Hetzner server that OCD provisions, and OCD manages its private
network, firewall, and volumes.

## Servers

OCD creates each server, joins it to the OCD private network, reconciles its
firewall, attaches Hetzner volumes, and deletes the Hetzner server when the
server is removed. Server creation and deletion are browser-confirmed
operations because they create or destroy billable Hetzner resources.

```bash
ocd servers
ocd servers show <name|id>
ocd servers create --type=X --location=X
ocd servers delete <name|id>
```

Direct SSH remains available through `ocd ssh`.

Every server carries the fleet firewall `open-cli-deployment` (SSH, HTTP,
HTTPS, ICMP). A server that runs an app with `public_ports` also carries
`ocd-public-ports-<server id>`, which OCD owns completely: its rules are the
declared public ports of the apps placed there, and OCD deletes it when there
are none. Hetzner combines the rules of every firewall on a server. Give such a
service a small server of its own when its traffic or ports should stay apart
from other apps.

## Hetzner settings

Configure Hetzner in **Settings → Hetzner**. Credentials remain in the encrypted
secret store.

- **Hetzner API token** for servers, the private network, firewalls, and
  volumes. Until it is set, requests for new capacity fail with guidance to
  configure it.
- **Hetzner Object Storage**: the region (`fsn1`, `nbg1`, or `hel1`), access
  key, and secret key. OCD uses exactly one object storage account for buckets,
  app storage bindings, external readers, and panel backups. Rotate its keys in
  place.

## Volumes

- `hetzner-block` is a Hetzner volume. It is billed separately and can be
  detached and moved to another server.
- `local-directory` is a directory under `/var/lib/ocd/volumes` on one server.
  It shares that server's disk and is not portable.

See [Storage](scaling-storage-and-placement.md#storage).

## DNS

DNS stays operator-managed. Configure an optional default domain suffix, then
create the A/AAAA records OCD displays at your DNS provider.

## Dedicated build capacity

Install an OCD BuildKit worker on an empty server explicitly with
`ocd runners install --server=<name>`. OCD then rejects that server in app
placements and prevents its deletion until the worker is removed. See
[Build workers and webhooks](build-workers-and-webhooks.md) for the trust
boundary and commands.
