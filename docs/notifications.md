# Shared ntfy notifications

OCD can run one private ntfy server on the panel host, behind its existing
Traefik HTTPS ingress. Enable it in **Admin → Panel → Shared notifications**.
Choose a dedicated domain and point its DNS to the panel ingress address.
OCD resolves the pinned ntfy release to an immutable digest, reserves a
loopback port, and provisions a persistent container. Configuration changes
are engine operations, and the engine reconciles service health and access.

The default resource ceilings are **128 MiB RAM and 0.5 CPU**, configurable in
Admin. These are limits, not reservations or measured steady-state usage.
The minimal v2.28.0 server measured approximately 16 MiB and 0% CPU at idle in
local Docker; concurrent subscribers and traffic increase usage. Authentication
and the message cache use SQLite. Attachments, email, billing, and public
signup are disabled. No additional database server is needed.

## User alerts

In **Account → Notifications**, enable alerts, select event categories, and
choose whether to receive recoveries. Add the displayed server, username,
password, and private topic to the ntfy mobile app or web client. Use **Send
test** and **Refresh status** to verify delivery.

Unhealthy app and disk-pressure incidents have a two-minute grace period.
Repeated observations generate one opening notification and one recovery.
App events respect the recipient's current app permissions. Deployment,
disk, and panel-backup incidents are currently admin-only. Preferences and
permissions are checked again before delivery. Enabling alerts subscribes to
future incident transitions; it does not replay every historical incident.

Delivery uses a persistent outbox with exponential backoff and up to twelve
attempts. Transport failures after ntfy accepted a message can produce a
repeat notification: this is at-least-once delivery, not exactly-once.
Messages are retained for 24 hours by default, configurable up to seven days.

Instant iOS delivery optionally uses ntfy.sh for wake-up requests; message
content remains on the private server. Without that option iOS delivery can
be delayed. See [ntfy's iOS documentation](https://docs.ntfy.sh/config/#ios-instant-notifications).

## Hosted app bindings

Add `notifications` to an app's `.ocd-deploy.json` and deploy through the OCD CLI:

```json
{
  "notifications": {
    "primary": { "permissions": ["publish"] },
    "jobs": { "permissions": ["publish", "subscribe"], "generation": 0 }
  }
}
```

Bindings require administrator authorization and **Allow hosted app
notification bindings**. Each app, binding, and credential generation receives
an isolated private topic and native ntfy credential. Production and staging
apps have separate identities. Apps cannot publish platform alerts or access
another app's topics. There are no administrator credentials in app environments.

The primary binding injects `OCD_NTFY_URL` (server origin), `OCD_NTFY_TOPIC`,
and `OCD_NTFY_TOKEN`. A `jobs` binding injects `OCD_JOBS_NTFY_URL`,
`OCD_JOBS_NTFY_TOPIC`, and `OCD_JOBS_NTFY_TOKEN`. These values are managed by
OCD and override same-named user environment variables.

Publish using the native ntfy HTTP API:

```ts
await fetch(`${process.env.OCD_NTFY_URL}/${process.env.OCD_NTFY_TOPIC}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OCD_NTFY_TOKEN}` },
  body: "Background job completed",
});
```

A subscription-enabled binding can use `/<topic>/json`, SSE, or WebSockets
with the same bearer token. See [ntfy's subscription API](https://docs.ntfy.sh/subscribe/api/).
Increment `generation` to rotate credentials. Old credentials remain during
rollout and retire after live replicas attest to the desired configuration.
Removing a binding removes its access after that rollout; destroying the app
removes its credentials. ACL changes take effect when the service reconciles,
usually within 30 seconds, and restart ntfy; clients must reconnect.

## Operations and persistence

The container is `ocd-ntfy`, bound only to `127.0.0.1:8894` on the panel host.
Data and the generated private configuration live at `/var/lib/ocd/ntfy`.
Traefik loads `/etc/traefik/dynamic/ntfy.yml`. OCD credentials are encrypted
in the panel database; the generated server configuration is mode 0600.
Do not edit its users or ACLs manually: OCD owns the declarative configuration.

Disabling retains the data and stops the container. Disabling only app access
revokes app ACLs; it does not delete app binding declarations. Changing the
service domain requires removing existing app bindings first, then rebinding
and redeploying apps for their new URL.

Panel database backups preserve configuration, credentials, and queued platform
notifications. The separate ntfy cache directory is **not** included: after
panel recovery OCD can recreate accounts, but previously delivered cached
messages are lost unless `/var/lib/ocd/ntfy` is backed up separately. Do not run
two restored copies of the panel simultaneously.

ntfy shares the panel host's failure domain. It cannot deliver alerts while
that host is offline; external monitoring is needed for total panel outages.
