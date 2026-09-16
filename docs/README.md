# Open CLI Deployment documentation

This index separates reusable operator documentation from project-specific
implementation and migration notes.

## Start here

- [Core concepts](../src/cli/skill/assets/docs/concepts.md)
- [App manifest](../src/cli/skill/assets/docs/app-manifest.md)
- [Stack manifest](../src/cli/skill/assets/docs/stack-manifest.md)
- [CLI reference](../src/cli/skill/assets/docs/cli-reference.md)
- [Deploying and updating configuration](../src/cli/skill/assets/docs/deploy-and-config.md)
- [Environments and secrets](../src/cli/skill/assets/docs/environments-and-secrets.md)

## Infrastructure and operations

- [Infrastructure and server enrollment](../src/cli/skill/assets/docs/infrastructure-and-enrollment.md)
- [Build workers and webhooks](../src/cli/skill/assets/docs/build-workers-and-webhooks.md)
- [Networking and ingress](../src/cli/skill/assets/docs/networking-and-ingress.md)
- [Scaling, storage, and placement](../src/cli/skill/assets/docs/scaling-storage-and-placement.md)
- [Releases, promotion, and rollback](../src/cli/skill/assets/docs/releases-promotion-and-rollback.md)
- [Operations and recovery](../src/cli/skill/assets/docs/operations-and-recovery.md)
- [Security and deletion](../src/cli/skill/assets/docs/security-and-deletion.md)
- [Troubleshooting](../src/cli/skill/assets/docs/troubleshooting.md)

## Focused guides

- [S3-compatible object storage](object-storage.md)
- [Panel backups and alerts](panel-protection.md)
- [Build worker operations](build-workers.md)
- [Storage inventory](storage-inventory.md)
- [Volume recovery](volume-recovery.md)
- [PostgreSQL restore](postgresql-restore.md)

The files under `src/cli/skill/assets` are the canonical source for the manual
embedded in CLI releases. Keep those files current when commands, manifests, or
operational behavior change.
