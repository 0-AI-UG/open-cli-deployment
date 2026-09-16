import { expect, test } from "bun:test";
import { assertReadCommand, parseOcdCommand, runOcdCommand } from "./incident-agent.ts";
import { apiRoutes } from "../routes.ts";
import { seedTestAdmin } from "../../shared/test-helpers.ts";
import { getUserById } from "../../shared/db.ts";
import { createServer } from "node:net";

test("agent command parser passes argv to OCD without a shell", () => {
  expect(parseOcdCommand('ocd app show "my app" --storage')).toEqual(["app", "show", "my app", "--storage"]);
  expect(parseOcdCommand("ocd logs app;touch /tmp/marker")).toEqual(["logs", "app;touch", "/tmp/marker"]);
  expect(() => parseOcdCommand("sh -c 'ocd apps'")).toThrow();
});

test("investigation allows inspection and rejects mutations", () => {
  expect(() => assertReadCommand(parseOcdCommand("ocd app show demo"))).not.toThrow();
  expect(() => assertReadCommand(parseOcdCommand("ocd logs demo --tail=100"))).not.toThrow();
  expect(() => assertReadCommand(parseOcdCommand("ocd restart demo"))).toThrow();
  expect(() => assertReadCommand(parseOcdCommand("ocd gc --execute"))).toThrow();
});

test("agent executes the real OCD CLI against normal panel API routes", async () => {
  const userId = seedTestAdmin();
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      socket.close(() => resolve(address.port));
    });
  });
  const server = Bun.serve({ port, routes: apiRoutes });
  const previousPort = process.env.PORT;
  process.env.PORT = String(server.port);
  try {
    const result = await runOcdCommand("ocd apps", "investigate", { userId, username: "admin", tokenVersion: getUserById(userId)!.token_version });
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("Not logged in");
  } finally {
    server.stop();
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});
