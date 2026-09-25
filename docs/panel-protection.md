# Panel backups and notifications

Open **Admin → Panel** for backups, recovery, and shared notification settings.
The operational **Panel** page shows status, releases, deployments, and logs to
users with `panel.view`. Redeployment requires `panel.manage`.

The **Manual panel redeploy** card resolves the current `main` commit to its
published, immutable GHCR image and lets an operator redeploy it with one
confirmation. If the same image is already running, the action restarts that
version. If CI has not published the commit's image yet, refresh the target
after the build finishes. **Advanced: redeploy a specific image** remains
available for an explicitly chosen digest.

Applications continue to own their PostgreSQL databases, PGMQ workers, and cron
scheduling; OCD does not back up application data or schedule application jobs.

## Enable backups

1. Connect and assign an S3-compatible provider in **Admin → Providers**.
2. Enter an existing bucket in **Panel backups**. Use a dedicated prefix per panel
   (default `ocd-panel`). The credentials need GetObject, PutObject, and DeleteObject
   access to that prefix. Bucket creation remains in the object-storage controls.
3. Create and download the recovery key. Save it **outside the panel**, together
   with the S3 endpoint, region, bucket, and independent S3 access credentials.
4. Enable daily backups and save. The first backup runs on the next engine tick.

Defaults are one backup every 24 hours and seven successful backups retained.
The path prefix and retention count (1–90) are optional advanced settings.
**Back up now** queues a backup even when the daily schedule is disabled.
The engine processes requests durably, without keeping the browser connected.
A failed scheduled backup retries after an hour; there is no catch-up burst.

Each `.ocdb` object contains a consistent SQLite `VACUUM INTO` snapshot, its
checksum, SSH directory files, the panel's credential encryption/JWT secret,
creation time, schema version, and recorded panel image. Configuration and
provider credentials stored in SQLite are included. Build caches, app volumes,
container images, application databases, external DNS, and infrastructure are
not included. Keep the panel image available in your registry.

The archive is gzip-compressed and authenticated/encrypted with AES-256-GCM using
a separate random recovery key. The key is encrypted in the panel's secret store
and can be shown again to an administrator. S3 receives only encrypted bytes.
OCD downloads each upload and checks its checksum before declaring success or
applying retention. Retention deletes only exact object keys recorded by this
panel. Failed deletions remain visible and are retried after subsequent backups.
With S3 versioning, bucket lifecycle rules are needed to expire old versions.

The current implementation supports a SQLite database up to 256 MiB and an
archive up to 512 MiB. A larger database fails the backup explicitly. Keep an eye
on backup status; this implementation is intended for small panels.

## Restore without the original panel

Stop the original panel and any separately running engine. Never run two active
panels against the same fleet. Restore onto a host with access to the recorded
servers, using the OCD release that created the backup. Restoration preserves
recorded server addresses and panel placement; it does not provision replacement
infrastructure or automatically move the panel to a different server.

Supply secrets through environment variables, not command-line arguments:

```bash
export OCD_S3_ENDPOINT=https://your-s3-endpoint.example
export OCD_S3_REGION=your-region
# Set these from your password manager or secret manager:
# OCD_S3_ACCESS_KEY, OCD_S3_SECRET_KEY, OCD_RECOVERY_KEY

bun run restore:panel --from s3://my-bucket/ocd-panel/backup.ocdb \
  --data-dir /srv/ocd-restored
```

`OCD_RECOVERY_KEY` is the downloaded 64-character key, without a trailing newline.
The destination directory must **not exist**. The restore command has no
connection to a running panel and does not open the ordinary panel database.
It downloads and authenticates the archive, verifies the database checksum,
SQLite integrity and foreign keys, and atomically installs the new directory.
A wrong key, corrupt database, incompatible schema, or existing destination
leaves the destination untouched.

For a previously downloaded object:

```bash
bun run restore:panel --file /safe/backup.ocdb --data-dir /srv/ocd-restored
```

The release container also includes the restore script. Mount a parent directory
in which it can create a new child (substitute your pinned OCD image):

```bash
docker run --rm \
  -v /srv/recovery:/restore \
  -e OCD_S3_ENDPOINT -e OCD_S3_REGION \
  -e OCD_S3_ACCESS_KEY -e OCD_S3_SECRET_KEY -e OCD_RECOVERY_KEY \
  --entrypoint bun "$OCD_IMAGE" run scripts/restore-panel.ts \
  --from s3://my-bucket/ocd-panel/backup.ocdb --data-dir /restore/panel
```

Ensure the container user can write the parent directory. Mount the resulting
directory as the replacement panel's `/app/data`, reusing the original panel's
networking and domain. Start the matching release with `OCD_DATA_DIR=/app/data`.
The recovered `jwt-secret` file is loaded automatically. Omit `JWT_SECRET`, or
supply the identical original value; a conflicting override is rejected rather
than silently making credentials unreadable. All restored private files are
mode 0600, inside restricted directories.

The panel starts with **automation paused**. Sign in using the restored account,
open **Admin → Panel**, confirm that the original panel is stopped, and choose
**Verify servers and resume**. OCD checks pinned SSH host keys and Docker access
to every recorded server before permitting saved operations and reconciliation
to resume. If any check fails, it remains paused. Review the saved operation count
before resuming: an older backup may contain operations whose effects occurred
after that backup. This access check does not prove application data consistency.

Daily backups remain disabled after restore so an old retention history cannot
immediately prune backups. Confirm the destination and enable backups again.
Pending ntfy notifications from the old snapshot are discarded to avoid replaying stale alerts.

## Notifications

ntfy is OCD's only alert channel. Enable the shared service and platform alerts
in **Admin → Panel → Shared notifications**, then configure subscriptions and
recovery notices in **Account → Notifications**. See [Shared ntfy notifications](notifications.md)
for server setup, app bindings, delivery retries, and access controls.

Built-in incidents cover failed deployments, apps unhealthy for two minutes,
failed or overdue panel backups, and sustained server disk usage of at least 90%.
The incident list remains visible in Incidents. The panel and ntfy must be available
to deliver alerts; use external monitoring for a total panel-host outage.
