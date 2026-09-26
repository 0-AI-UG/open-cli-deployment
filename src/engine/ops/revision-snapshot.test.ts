import { expect, mock, test } from "bun:test";

const image = `ghcr.io/acme/app@sha256:${"a".repeat(64)}`;
const sshExec = mock(async (_ip: string, command: string) => {
  if (command.includes("docker inspect --format")) {
    return { exitCode: 0, stdout: `sha256:${"b".repeat(64)}\n`, stderr: "" };
  }
  if (command.includes("echo present")) return { exitCode: 1, stdout: "", stderr: "snapshot missing" };
  if (command.includes("/image-ref")) return { exitCode: 0, stdout: `${image}\n`, stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
});
mock.module("../../shared/remote/index.ts", () => ({ sshExec, asUser: (command: string) => command }));

const { captureRemoteRevisionSnapshot } = await import("./_revision-snapshot.ts");

test("snapshot capture refuses an unverified environment before rollout", async () => {
  await expect(captureRemoteRevisionSnapshot({
    ip: "203.0.113.10",
    appName: "app",
    containerName: "app",
    opId: 42,
    currentImageRef: image,
  })).rejects.toThrow("could not be verified");
});
