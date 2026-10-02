# Hetzner Object Storage

OCD can inventory, create, and delete buckets in one Hetzner Object Storage
account. Object storage uses its own access key and secret key, separate from
the Hetzner API token.

## Configure

Generate an access key and secret key in the Hetzner Console. In OCD, open
**Admin → Hetzner** and enter the Object Storage region (`fsn1`, `nbg1`, or
`hel1`) and both keys. OCD verifies the credentials before saving them and
stores both values in its encrypted secret store. To rotate keys, update them
in place.

Use the Resources page or the CLI:

```text
ocd buckets list
ocd buckets create <globally-unique-name>
ocd buckets delete <name>
```

New buckets are private. Create and delete operations require browser approval.
OCD only deletes an empty bucket and never recursively deletes objects, object
versions, or incomplete multipart uploads. Remove that data with an S3 client
before deleting the bucket.

Select a bucket name under **Resources → Object Storage** to browse its
delimiter-separated prefixes and preview text objects. Previews are capped at
256 KiB and binary objects are not rendered. Non-admin users need the
`buckets.objects.read` permission because object names and contents are
application data.

Object-storage credentials are often account- or project-wide. Do not inject
OCD's administrative credential into applications. Apps should declare scoped
storage bindings in their manifests instead.

## OCD-scoped application access

Apps can instead use OCD-issued tokens; the Hetzner credentials stay in the
panel. Each token is bound to a bucket, prefix, and explicit methods.
The application requests short-lived object URLs from `/api/storage/authorize`
and transfers bytes directly to object storage. List requests are constrained
to the token's prefix.

Declare the bucket, prefix, and permissions in the app manifest as shown below.
OCD creates and injects a scoped token during deployment. Apps must opt into
the OCD storage driver. The TypeScript fetch client is in
`packages/storage-client/index.ts`; see [SDK clients](sdk-clients.md) for
installation.

New app grants come only from manifest bindings. For readers outside OCD, such
as a CDN, create a separately named, read-only external reader:

```text
ocd storage-readers create skyline-cdn skyline-media-nbg1 --prefix=uploads/editorial/ --token-file=/private/path/cdn-token
ocd storage-readers list
ocd storage-readers revoke <reader-id>
```

An external reader is pinned to one bucket and optional prefix. Its token can
authorize only GET and HEAD; it cannot list, write, or delete.
The token is written once to a mode-0600 file and never shown again.
Install it in the external service's secret store, not in an OCD app manifest.
Revocation blocks new authorizations immediately; previously signed object
URLs can remain valid for up to one hour.

External readers are the only non-app storage consumers. App tokens must come
from manifest bindings; untyped manual grants are not authorized.

## Managed app bindings

Declare app-owned access in the manifest:

```json
{
  "storage": {
    "primary": {
      "bucket": "app-uploads",
      "prefix": "production/",
      "permissions": ["read", "write", "delete", "list"]
    }
  }
}
```

Bindings require an existing bucket and the global `apps.storage.bind` permission for deployment. Administrators have this permission implicitly.
Each app and named binding receives a different encrypted grant, even when they
share a bucket or prefix.

The `primary` binding injects `OCD_STORAGE_TOKEN` and `OCD_STORAGE_URL` directly
into the container. Other names use `OCD_<NAME>_STORAGE_TOKEN` and
`OCD_<NAME>_STORAGE_URL`. These override environment values and bypass shared
variable projection. The panel displays masked, read-only binding details.
Keep application driver settings (such as `STORAGE_DRIVER=ocd`) in normal app
configuration and use the OCD client. No Hetzner credentials reach the app.

Permissions map to GET/HEAD (`read`), PUT (`write`), DELETE (`delete`), and LIST
(`list`). Increment a binding's `generation` to rotate its token. Preparation
keeps the previous grant valid; retirement happens only after all replicas attest
to the desired environment. Removing a binding follows the same retirement rule.
Deleting an app revokes its managed grants. External-reader grants have an
independent lifecycle and must be explicitly revoked when the external service
stops using them.

Bindings do not copy objects.
