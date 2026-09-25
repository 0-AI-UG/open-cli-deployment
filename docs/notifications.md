# Shared ntfy notifications

ntfy is OCD’s only alert channel. Its server is a regular OCD app, defined in
[`services/ntfy/.ocd-deploy.json`](../services/ntfy/.ocd-deploy.json).
In **Admin → Panel → Shared notifications**, create the app on a ready server
or select an existing app deployed with that manifest. Point its domain to
that server's ingress address. OCD uses the ordinary app deployment operation,
immutable image resolution, persistent volume, health checks, and HTTPS ingress.

Open the ntfy **app page** for logs, deployments, resources, storage, domain,
and lifecycle controls. Admin settings contain only setup and notification
integration options. Per-user preferences are in **Account → Notifications**.

The default resource ceilings are **128 MiB RAM and 0.5 CPU**, configurable on
the app page. These are limits, not reservations or measured steady-state usage.
Local Docker checks measured approximately 16 MiB for a minimal idle server
and 61 MiB after provisioning users and exercising authenticated delivery,
with 0% idle CPU. Concurrent subscribers and traffic increase usage. Authentication
and the message cache use SQLite. Attachments, email, billing, and public
signup are disabled. No additional database server is needed.

## User alerts

In **Account → Notifications**, enable alerts, select event categories, and
choose whether to receive recoveries. Add the displayed server, username,
password, and private topic to the ntfy mobile app or web client. Use **Send
test** and **Refresh status** to verify delivery.

Unhealthy app and disk-pressure incidents have a two-minute grace period.
Repeated observations generate one opening notification and one recovery. Each
notification opens the corresponding incident detail page. Incidents are recorded
and resolved even when ntfy delivery is disabled; the Incidents page retains the
history and offers read-only investigation guidance.
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

Bindings require the global `apps.notifications.bind` permission and **Allow hosted app
notification bindings**. Each app, binding, and credential generation receives
an isolated private topic and native ntfy credential. Production and staging
apps have separate identities. Apps cannot publish platform alerts or access
another app's topics. There are no administrator credentials in app environments.

The primary binding injects `OCD_NTFY_URL` (server origin), `OCD_NTFY_TOPIC`,
and `OCD_NTFY_TOKEN`. A `jobs` binding injects `OCD_JOBS_NTFY_URL`,
`OCD_JOBS_NTFY_TOPIC`, and `OCD_JOBS_NTFY_TOKEN`. These values are managed by
OCD and override same-named user environment variables.

Use the small fetch client in `packages/ntfy-client/index.ts` ([local installation](sdk-clients.md)):

```ts
import { OcdNtfyClient } from "@0-ai-ug/ocd-ntfy-client";

const ntfy = OcdNtfyClient.fromEnv(process.env);
await ntfy.publish("Background job completed", { title: "Worker" });
```

Named bindings use `OcdNtfyClient.fromEnv(process.env, "jobs")`. The client
also exposes `subscribe(signal)` as an async stream of native ntfy JSON events;
request `"subscribe"` permission for that binding. Apps can alternatively
publish using the native ntfy HTTP API:

```ts
await fetch(`${process.env.OCD_NTFY_URL}/${process.env.OCD_NTFY_TOPIC}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OCD_NTFY_TOKEN}` },
  body: "Background job completed",
});
```

A subscription-enabled binding can use `/<topic>/json`, SSE, or WebSockets
with the same bearer token. See [ntfy's subscription API](https://docs.ntfy.sh/subscribe/api/).
These manifest bindings are the notification equivalent of managed object-storage
grants: OCD issues a topic-scoped token with `publish` and/or `subscribe` access,
injects it into only that app, and retires it after binding removal or rotation.
There is no separate manual `ocd notifications grant`/`revoke` command. Unlike
object-storage grants, a notification binding does not choose an arbitrary
shared topic; OCD creates an isolated topic for each app and binding.
Increment `generation` to rotate credentials. Old credentials remain during
rollout and retire after live replicas attest to the desired configuration.
Removing a binding removes its access after that rollout; destroying the app
removes its credentials. ACL changes take effect when the service reconciles,
usually within 30 seconds, and restart ntfy; clients must reconnect.

## Operations and persistence

The app mounts persistent storage at `/var/lib/ntfy` for its authentication
and message-cache SQLite databases. It has a dedicated OCD environment;
managed users, tokens, and ACLs are encrypted environment secrets. OCD applies
access changes through normal app reload operations. This uses ntfy's
[declarative environment configuration](https://docs.ntfy.sh/config/#users-via-the-config).
Do not manually edit the managed authentication variables. Keep one replica,
private authentication, and the persistent mount when editing the app manifest.

Disabling integration revokes OCD access and leaves the app's lifecycle under
your control. Pause or stop it on its app page. Integration changes never
unpause it. Disabling app access retains binding declarations. After changing
the ntfy app's domain, redeploy consuming apps to refresh their injected URL.

Panel database backups preserve configuration, credentials, and queued platform
notifications. Restore discards pending messages from the old timeline. The
ntfy app's volume needs its own backup for cached messages, just like other
stateful apps. Do not run two restored copies of the panel simultaneously.

OCD events are queued while ntfy is unavailable and retried after it recovers.
The panel must be running to observe and publish events. Place ntfy on a
separate server if desired; external monitoring covers total panel outages.

This is a hard cut to app-based hosting. There is no conversion of the former
special-purpose ntfy container or configuration.

The Incidents page opens on active conditions and includes filters for all or
resolved occurrences. Details show when the condition was first detected, when
it opened after any grace period, its duration, and when it cleared. Active
detail pages refresh every 15 seconds. Each category includes investigation
steps and a link to its app, server, deployment operation, or panel settings.
Status is managed by monitoring; resolving the underlying condition closes the
incident automatically. Repeated deployment failures update the operation link
within the existing incident. A recurrence after recovery creates a new record.
Incident tracking and investigation guidance require no external AI service.
