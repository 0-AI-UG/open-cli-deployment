# App SDK clients

OCD currently ships source-only Bun/TypeScript SDK packages in this repository.
They are not published to npm or GitHub Packages yet; a registry install command
would be misleading. In a Bun app with a local checkout of this repository, add
the package directories as file dependencies:

```bash
bun add file:../open-cli-deployment/packages/storage-client
bun add file:../open-cli-deployment/packages/ntfy-client
```

Adjust the relative path to the checkout. Commit the resulting app lockfile and
ensure the checkout is available when building the app. Then import by package
name:

```ts
import { OcdStorageClient } from "@0-ai-ug/ocd-storage-client";
import { OcdNtfyClient } from "@0-ai-ug/ocd-ntfy-client";
```

Both clients use the standard Fetch API. The packages export TypeScript source,
so a Bun or TypeScript-aware bundler must compile them. For independently hosted
apps without this repository checkout, vendor the small client source files
until versioned packages are published. Do not add the panel repository itself
as an app dependency or put OCD-issued tokens in source control.
