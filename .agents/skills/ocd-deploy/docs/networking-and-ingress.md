# Networking and ingress

## Contents

- [Network layers](#network-layers)
- [Private app addressing](#private-app-addressing)
- [Public HTTP routing](#public-http-routing)
- [Internal protocol](#internal-protocol)
- [Health checks](#health-checks)
- [HTTP middleware](#http-middleware)
- [Configuration timing](#configuration-timing)

## Network layers

OCD provides two distinct exposure mechanisms:

1. stable private app names on the fleet network;
2. public HTTP/HTTPS domain routing through panel ingress.

`public: false` only disables public-domain routing. Private app networking is
separate.

## Private app addressing

Every app receives a fleet-unique virtual IP and stable name:

```text
<app>.ocd.internal
```

OCD keeps `/etc/hosts` and the per-host proxy reconciled across ready servers.
The platform injects:

- `OCD_INTERNAL_URL`
- `OCD_INTERNAL_HOST`
- `OCD_INTERNAL_PORT`

For HTTP-routed apps:

```text
OCD_INTERNAL_URL=http://<app>.ocd.internal
OCD_INTERNAL_HOST=<app>.ocd.internal
OCD_INTERNAL_PORT=80
```

For raw-TCP apps:

```text
OCD_INTERNAL_URL=tcp://<app>.ocd.internal:<container_port>
OCD_INTERNAL_HOST=<app>.ocd.internal
OCD_INTERNAL_PORT=<container_port>
```

A user-defined environment key with the same name wins.

Stack app key `api` publishes its `OCD_INTERNAL_URL` into the stack environment
as `API_URL`.

## Public HTTP routing

With `public: true`, an app receives either:

- its explicitly configured domain;
- `<app>.<default_domain_suffix>` when a suffix is configured;
- a `<app>.<panel-ip>.nip.io` fallback when no suffix is configured.

OCD manages routing, but never creates, replaces, or deletes DNS records. For
every public HTTP hostname, the panel displays an `A` record
instruction with copyable type, name, and target plus its observed status:
`pending`, `correct`, or `conflicting`. Private apps, raw-only endpoints, and
`nip.io` fallbacks require no manual record. Public domains use Let's Encrypt
HTTP-01 after the record resolves.

Setting `public: false` removes public routing while retaining private access.
OCD reports DNS as not applicable and leaves any existing external record
untouched.

## Internal protocol

`internal_protocol` selects private ingress behavior:

- `http` (default): L7 HTTP routing, portless internal URL, middleware and HTTP
  health checks available;
- `tcp`: raw pass-through to `container_port`, no HTTP middleware/request
  metrics.

Do not set `tcp` merely because a worker has no public endpoint. Set it only
when consumers connect with a raw-TCP protocol. A worker with no listener may
remain HTTP-routed but should disable HTTP health checking, or expose an
appropriate health endpoint.

## Health checks

`health_check.enabled: true` performs a post-deploy HTTP probe. The default path
is `/`. Failure rolls the deployment back.

Setting `health_check.path`:

- requires an absolute, whitespace-free path;
- is valid only for HTTP routing;
- configures the deployment probe;
- enables continuous Traefik health checks so unhealthy replicas leave
  rotation.

`health_check.enabled: false` skips the HTTP response probe but still checks
that the container remains running.

## HTTP middleware

HTTP-routed public apps support:

- per-client rate limiting;
- gzip compression;
- active health-check path.

Rules:

- health paths are invalid for raw TCP;
- rate limit must be `0..1000000`, where zero disables it.

## Configuration timing

Ingress-only manifest applications are rendered immediately. Container-injected
values such as `OCD_INTERNAL_URL` update only when a container is recreated.

Examples:

- changing the rate limit or compression can take effect without an image release;
- changing `internal_protocol` resyncs ingress, but recreate the container so
  its `OCD_INTERNAL_*` values match;
- changing `container_port`, environment, memory, or CPU needs a rollout to
  affect running containers.
