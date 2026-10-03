# App Manifest

The default `.ocd-deploy.json` is complete desired configuration for one app.
Unknown fields are rejected by default.

## Example

```json
{
  "$schema": 1,
  "name": "API",
  "suggested_app_name": "api",
  "build": {
    "repository": "https://git.example.com/team/product.git",
    "branch": "main",
    "dockerfile": "apps/api/Dockerfile",
    "context": ".",
    "image_repository": "registry.example.com/team/api",
    "webhook": false
  },
  "container_port": 3000,
  "environment": "production",
  "env": { "DATABASE_URL": { "from": "environment.DATABASE_URL" } },
  "domain": "api.example.com",
  "public": true,
  "placement": { "server-2": 1, "server-3": 1 },
  "health_check": { "mode": "http", "path": "/health", "expected_statuses": [200] },
  "volume": null
}
```

## Placement

`placement` is required. It maps server names (as shown by `ocd servers`, or a
numeric server ID) to the number of replicas that server runs, for example
`{"server-2": 1}` or `{"server-2": 1, "server-3": 1}`. OCD runs exactly
this; it never picks servers or replica counts. Apps with a `volume` must be
placed on exactly one server with one replica. See
[Placement](scaling-storage-and-placement.md#placement).

## Image source

Declare exactly one of `build` or `image`.

`image` is one OCI image-reference string, including Docker Hub shorthand such
as `postgres:17-alpine`. OCD resolves tags to a registry digest before changing
desired state and always runs the immutable digest.

For source builds, `build` contains:

- `repository`: HTTPS Git URL. Public or accessible with the configured
  read-only Git checkout token.
- `branch`: webhook branch, default `main`.
- `dockerfile`: safe repository-relative Dockerfile path.
- `context`: safe repository-relative Docker build context.
- `image_repository`: OCI repository where OCD pushes the build, without a tag
  or digest.
- `platform`: optional `linux/amd64`; this is the only supported runtime ABI.
- `cache`: optional boolean; `false` disables registry-backed BuildKit cache.
- `webhook`: whether signed push delivery is enabled, default `true`. The
  current push-webhook protocol integration is GitHub; use `false` with other
  Git providers and deploy exact commits through the CLI.

Paths must not be absolute, contain `..`, or use backslashes. Credentials never
belong in this object.

## Other top-level fields

`$schema`, `$llm`, `name`, `description`, `icon`, `build`, `image`,
`container_port`, `env`, `outputs`, `storage`, `command`, `cap_add`,
`environment`, required `volume` (`null` for none),
`suggested_app_name`, `domain`, `placement`, `public`, `memory_mb`,
`cpu_limit`, `health_check`, `internal_protocol`, `rate_limit_rps`, and
`compress` retain their normal complete-desired-state semantics.

The `env` object maps variable names to literal strings or `{ "from":
"environment.KEY" }` / `{ "from": "apps.MEMBER.outputs.KEY" }` references.
Only mapped values are delivered; missing references fail deployment. No values
are generated or written to shared environments during deployment.

The `outputs` map defines `{ "template": "...", "secret": true }` values for
stack consumers. Templates accept `{app.host}`, `{app.port}`, and `{env.KEY}`.
Secrets propagate from referenced values; mark other sensitive outputs with
`secret: true`. See [Environments and secrets](environments-and-secrets.md).

Primary volumes are grow-only. Omission of `environment` detaches a standalone
app; stack members inherit their stack selection. Explicit `null` detaches.
Domain omission retains its existing value; an empty string clears it.

## Object storage bindings

`storage` maps binding names to `{ bucket, prefix, permissions, generation? }` in
OCD's Hetzner Object Storage account. Permissions are `read`
(GET/HEAD), `write` (PUT), `delete`, and `list`. Prefix is explicit: use `""` for
bucket root or a relative prefix ending in `/`. Bucket creation is separate.

OCD creates a private token per app binding. `primary` injects `OCD_STORAGE_TOKEN`
and `OCD_STORAGE_URL`; `media` injects `OCD_MEDIA_STORAGE_TOKEN` and
`OCD_MEDIA_STORAGE_URL`. Values are injected independently of the env map and are
read-only. Use the OCD storage client, not a standard S3 SDK with this token.
Increment `generation` to rotate. Old grants are retired after replicas attest
to the new configuration. Removing `storage` removes the app's bindings.

## Notifications

`notifications` declares private topics on OCD's managed ntfy service:

```json
{
  "notifications": {
    "primary": { "permissions": ["publish"], "generation": 0 }
  }
}
```

Enable shared ntfy and app access in Settings → Panel first. OCD injects
`OCD_NTFY_URL`, `OCD_NTFY_TOPIC`, and `OCD_NTFY_TOKEN`; named bindings use
`OCD_<NAME>_NTFY_*`. Permissions are `publish` and/or `subscribe`. Apps can use `OcdNtfyClient.fromEnv(process.env)`
from the local `@0-ai-ug/ocd-ntfy-client` package (`packages/ntfy-client`) to
publish, or `subscribe(signal)` to stream
JSON events; pass a binding name to `fromEnv` for named bindings. In a Bun app
with this repository checked out nearby, install it with
`bun add file:../open-cli-deployment/packages/ntfy-client` (adjust the path);
independent build repositories must vendor the source until it is published.
The native ntfy
API also works with the injected bearer token. These are managed topic-scoped
grants; there is no separate manual notification grant/revoke CLI.
Each app has isolated topics. Increment `generation`
to rotate credentials; old credentials retire after rollout attestation.
Removing `notifications` removes the bindings. Settings → Panel → Shared notifications configures
personal platform alerts independently of application messages.

`build.inputs` optionally declares the complete literal repository-relative files
and directories consumed by a Dockerfile. OCD fingerprints their Git tree entries,
the Dockerfile and Docker ignore rules, recipe, platform and repository. An
unchanged fingerprint reuses a registry-verified immutable digest across commits;
missing cached artifacts build normally. Include every COPY/bind source and update
this list when adding inputs. Omit it to always invoke BuildKit; `cache: false`
disables reuse too. Input tags are transport only, never runtime image identity.
