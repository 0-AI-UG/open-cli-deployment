import { describe, expect, test } from "bun:test";
import { latestMainPanelRelease, PANEL_REPOSITORY } from "./panel-main-release.ts";
import type { resolveOciImage } from "../../engine/oci-image.ts";

const commit = "a".repeat(40);
const image = `${PANEL_REPOSITORY}@sha256:${"b".repeat(64)}`;
const github = (sha: unknown, status = 200) => (async () => Response.json({ object: { sha } }, { status })) as unknown as typeof fetch;

describe("latest main panel release", () => {
  test("pins the exact main commit tag to an anonymous immutable image", async () => {
    let requested = "";
    const resolver = (async (ref: string, options: { anonymous?: boolean }) => {
      requested = ref;
      expect(options.anonymous).toBe(true);
      return image;
    }) as typeof resolveOciImage;
    expect(await latestMainPanelRelease(github(commit), resolver)).toEqual({ commit, image });
    expect(requested).toBe(`${PANEL_REPOSITORY}:sha-${commit}`);
  });

  test("rejects an invalid GitHub SHA", async () => {
    await expect(latestMainPanelRelease(github("main"))).rejects.toThrow("invalid main commit");
  });

  test("explains when the exact commit image has not been published", async () => {
    const resolver = (async () => { throw new Error("404"); }) as typeof resolveOciImage;
    await expect(latestMainPanelRelease(github(commit), resolver)).rejects.toThrow("not published yet");
  });

  test("rejects a digest from another repository", async () => {
    const resolver = (async () => `ghcr.io/other/panel@sha256:${"b".repeat(64)}`) as typeof resolveOciImage;
    await expect(latestMainPanelRelease(github(commit), resolver)).rejects.toThrow("invalid panel image digest");
  });
});
