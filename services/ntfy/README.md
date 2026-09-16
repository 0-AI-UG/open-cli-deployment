# ntfy

A regular OCD app running the official ntfy image, with persistent SQLite
storage, private authentication, HTTPS, and a health check.

Use **Admin → Panel → Shared notifications → Create ntfy app** to choose its
name, domain, and server. The shortcut deploys this manifest and creates its
dedicated environment with encrypted credentials. Hosting is managed from the
normal app page: deployments, logs, resources, storage, and lifecycle.

The environment references in the manifest are populated by OCD's notification
integration. If deploying through the CLI, provision that dedicated environment
first and select the resulting app in Admin. Do not share this environment
with other apps or manually edit the managed `NTFY_AUTH_*` variables.

Users subscribe to private OCD event topics through Account → Notifications.
Other apps use manifest `notifications` bindings for their own isolated topics
and tokens. See [notification documentation](../../docs/notifications.md).

Defaults: one replica, 128 MiB RAM ceiling, 0.5 CPU ceiling, and a server-local
persistent directory mounted at `/var/lib/ntfy`. It shares the server disk and
has no separately reserved or billed capacity; the manifest's 1 GB size is not
an enforced quota. Change resources on the app page. Keep one replica because
the service uses SQLite. Pause and resume it like any other app.
