# Concepts

## Source desired state, immutable runtime

The app manifest owns complete runtime configuration and exactly one delivery
source. A `build` source builds the exact Git commit and publishes it to
`build.image_repository`; an `image` source resolves a prebuilt tag or digest
without a build worker. Both paths apply the whole manifest and store only an
immutable runtime digest. Signed push webhooks apply only to build sources.

| Intent | Command |
| --- | --- |
| Validate desired state | `ocd manifest validate` |
| Reconcile an app from its declared source | `ocd deploy` |
| Reconcile a stack from member sources | `ocd deploy stack` |
| Apply config with current digest | `ocd deploy --config-only` |
| Advanced artifact-only rollout | `ocd release <app> --image <repository@sha256:digest>` |
| Roll back exact history | `ocd rollback <app>` |

Build repositories use temporary tags only for publication. Prebuilt image
tags are resolved before deployment. Runtime desired state and deployment
history always store digest-qualified image references.

A manifest catalog is just version-controlled app manifests. It has no
separate server-side lifecycle: catalog entries deploy as standalone apps or
stack members.

## Environments and staging

An environment stores named values and secrets. Each app's env map explicitly
selects references or literal values. Webhook delivery reads committed manifests,
so mapping changes are applied with the image built from that commit.

Staging is an explicit app or stack target with its own environment and domain.
Promotion copies an exact tested digest; it does not rebuild.

## Integration boundaries

Source checkout accepts compatible HTTPS Git hosts. Image publication accepts
compatible OCI registries such as GHCR, GitLab, Docker Hub, Quay, Harbor, and
self-hosted registries. GitHub signed push webhooks are the current automatic
source trigger; manual deployment is not GitHub-dependent.

DNS is manual and operator-managed. Servers, volumes, and object storage run on
Hetzner Cloud only: every server is a managed Hetzner server provisioned by OCD.
`hetzner-block` volumes can move between servers; `local-directory` volumes
share one host's disk, are not portable, and are shown in app/server Storage,
separately from the Hetzner Volumes inventory.
