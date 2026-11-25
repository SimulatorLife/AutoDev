import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildOpencliRoleTaskSpec,
  runOpencliRoleTurn
} from "../src/providers/opencli-role.ts";
import { OpencliCommandError } from "../src/providers/opencli-turn.ts";

const task = buildOpencliRoleTaskSpec({
  role: "explorer",
  provider: "opencli-chatgpt",
  model: "opencli-chatgpt-balanced",
  sessionId: "opencli-role-regression",
  workspace: process.cwd(),
  mcpApp: "AutoDev explorer",
  systemPrompt: "",
  task: "Reply exactly PONG."
});

test("role runner resolves the configured executable and preserves native argv", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "autodev-opencli-role-"));
  const previous = process.env.OPENCLI_BIN;
  try {
    const binary = path.join(directory, "opencli");
    process.env.OPENCLI_BIN = binary;
    writeFileSync(
      binary,
      `#!${process.execPath}
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ${JSON.stringify([
        "chatgpt", "ask", task.prompt, "--app", task.mcpApp,
        "--new", "true", "--timeout", String(task.timeoutSeconds), "-f", "json"
      ])});
console.log(JSON.stringify({ok:true,data:[{response:"PONG",conversationId:"test-conversation"}]}));
`,
      { mode: 0o700 }
    );
    assert.deepEqual(await runOpencliRoleTurn(task), {
      outputText: "PONG",
      exitCode: 0,
      conversationId: "test-conversation"
    });
    writeFileSync(
      binary,
      `#!${process.execPath}
console.log(JSON.stringify({ok:false,error:{code:"APP_NOT_FOUND",message:"App unavailable",hint:"Connect the role app"}}));
process.exitCode = 1;
`
    );
    await assert.rejects(
      runOpencliRoleTurn(task),
      (error: unknown) =>
        error instanceof OpencliCommandError &&
        error.code === "APP_NOT_FOUND" &&
        error.exitCode === 1 &&
        error.message === "App unavailable (Connect the role app)"
    );

    // The executable exists, but its interpreter does not: the OS cannot
    // spawn it. This is not a child process exiting with code 1.
    writeFileSync(binary, "#!/nonexistent-autodev-test-interpreter\n");
    await assert.rejects(
      runOpencliRoleTurn(task),
      (error: unknown) =>
        error instanceof OpencliCommandError &&
        error.exitCode === null &&
        /ENOENT/u.test(error.message)
    );

    process.env.OPENCLI_BIN = path.join(directory, "missing-opencli");
    await assert.rejects(
      runOpencliRoleTurn(task),
      /opencli is not executable/u
    );
  } finally {
    if (previous === undefined) delete process.env.OPENCLI_BIN;
    else process.env.OPENCLI_BIN = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
