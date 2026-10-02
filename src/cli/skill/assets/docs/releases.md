# Releases

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

## Returning to a previous version

There is no rollback command. To return to an earlier version, either deploy
the previous commit with `ocd deploy` (preferred when configuration may also
have changed), or re-release a previous digest:

```bash
ocd app deployments api
ocd release api --image registry.example.com/team/api@sha256:<previous-digest>
```

Registry retention must keep the digests you may want to return to.
