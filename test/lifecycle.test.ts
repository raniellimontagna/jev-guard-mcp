import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createShutdown, installStdioLifecycle } from "../src/lifecycle.js";

test("closes every resource once when stdin ends or closes", async () => {
  const input = new EventEmitter();
  let guardCloses = 0;
  let serverCloses = 0;
  const shutdown = createShutdown([
    async () => {
      guardCloses += 1;
    },
    async () => {
      serverCloses += 1;
    },
  ]);
  installStdioLifecycle(shutdown, input);

  input.emit("end");
  input.emit("close");
  await shutdown();

  assert.equal(guardCloses, 1);
  assert.equal(serverCloses, 1);
});
