import { resolveOciImage } from "../../engine/oci-image.ts";

export const PANEL_REPOSITORY = "ghcr.io/0-ai-ug/open-cli-deployment";
const MAIN_REF_URL = "https://api.github.com/repos/0-AI-UG/open-cli-deployment/git/ref/heads/main";
const FULL_COMMIT = /^[a-f0-9]{40}$/i;

/** Resolve the exact artifact built for GitHub's current main commit. Never
 * use the mutable :main/:latest image tags for a panel release. */
export async function latestMainPanelRelease(
  fetcher: typeof fetch = fetch,
  resolveImage: typeof resolveOciImage = resolveOciImage,
): Promise<{ commit: string; image: string }> {
  const response = await fetcher(MAIN_REF_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ocd-panel" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not read GitHub main (${response.status})`);
  const body = await response.json() as { object?: { sha?: unknown } };
  const commit = body.object?.sha;
  if (typeof commit !== "string" || !FULL_COMMIT.test(commit)) throw new Error("GitHub returned an invalid main commit");
  let image: string;
  try {
    // The official panel package is public. Avoid a stale fleet GHCR login
    // blocking an otherwise readable release artifact.
    image = await resolveImage(`${PANEL_REPOSITORY}:sha-${commit}`, { anonymous: true });
  } catch (error) {
    throw new Error(`The image for main ${commit.slice(0, 12)} is not published yet: ${error instanceof Error ? error.message : "registry lookup failed"}`);
  }
  if (!new RegExp(`^${PANEL_REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@sha256:[a-f0-9]{64}$`, "i").test(image)) {
    throw new Error("Registry returned an invalid panel image digest");
  }
  return { commit: commit.toLowerCase(), image: image.toLowerCase() };
}
