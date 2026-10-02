# Releases and Rollback

Normal delivery is `ocd deploy`, which reconciles either a Git build or a
prebuilt image declared in the manifest. Build manifests may additionally use
signed repository push webhooks to build the exact pushed commit and reconcile
the complete committed manifest or stack.

## Artifact-only release

```bash
ocd release api \
  --image registry.example.com/team/api@sha256:<64-hex-digest> \
  --commit <source-sha>
```

`ocd release` requires an existing app and an exact digest. It changes only the
running image while preserving stored configuration. It does not read
`.ocd-deploy.json` or `ocd-stack.json`, so do not use it when environment
mappings, ingress, health, storage, resources, or stack relationships may
have changed. It remains useful for importing a trusted externally produced
artifact or retrying an already synchronized configuration.

## Rollback

```bash
ocd app deployments api
ocd rollback api --deployment=<id>
```

Rollback pulls the historical digest and applies its recorded deployment
identity. Registry retention must keep the supported rollback window.
