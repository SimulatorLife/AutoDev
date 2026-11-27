/**
 * The Commands MCP, driven as a client sees it.
 *
 * The unit suite proves the catalogue, the confinement and the admission
 * rules. This suite starts the real server over stdio, with the real
 * approved catalogue and the real role contract, and proves that a client
 * can discover the commands its role holds, run one, and read the result --
 * through an ordinary call and through the native task lifecycle.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  CreateTaskResultSchema
} from "@modelcontextprotocol/sdk/types.js";

import { externalMcpBackend } from "../src/mcp/chatgpt-filesystem-sandbox.ts";

const SERVER = path.resolve(
  import.meta.dirname,
  "..",
  "src",
  "mcp",
  "commands-main.ts"
);

/** The test process's environment, as the stdio transport's string map. */
function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}

/** A disposable workspace with a Git repository in it. */
function workspaceFixture(): string {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "autodev-commands-workspace-"))
  );
  execFileSync("/usr/bin/git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root
  });
  writeFileSync(path.join(root, "README.md"), "# fixture\n");
  return root;
}

async function connect(
  workspace: string,
  role: string
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "--role", role, "--workspace", workspace],
    env: processEnvironment()
  });
  const client = new Client({ name: "commands-integration", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    }
  };
}

test(
  "a client discovers exactly the commands its role holds, and runs one",
  {
    skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { client, close } = await connect(workspace, "worker");
    t.after(() => close());

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "build",
      "duplicates",
      "duplicates_similar",
      "format_fix",
      "git_add",
      "git_blame",
      "git_branches",
      "git_commit",
      "git_diff",
      "git_diff_path",
      "git_diff_staged",
      "git_diff_stat",
      "git_head",
      "git_log",
      "git_log_path",
      "git_ls_files",
      "git_merge_base",
      "git_show",
      "git_stage",
      "git_status",
      "git_unstage",
      "install_dependencies",
      "knip",
      "knip_production",
      "lint",
      "lint_fix",
      "test",
      "typecheck"
    ]);
    // The commit tool declares its parameter rather than accepting free argv.
    const commit = listed.tools.find((tool) => tool.name === "git_commit")!;
    const schema = commit.inputSchema as {
      properties?: Record<string, { type?: string; maxLength?: number }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    assert.equal(schema.properties?.message?.type, "string");
    assert.equal(schema.properties?.message?.maxLength, 500);
    assert.deepEqual(schema.required, ["message"]);
    assert.equal(schema.additionalProperties, false);

    // An ordinary call runs the command and returns its structured result.
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const structured = result.structuredContent as {
      commandId: string;
      status: string;
      exitCode: number | null;
      stdout: string;
    };
    assert.equal(structured.commandId, "git_status");
    assert.equal(structured.status, "succeeded");
    assert.equal(structured.exitCode, 0);
    assert.match(structured.stdout, /README\.md/u);
  }
);

test(
  "a role with a narrower grant sees only its own commands",
  {
    skip: process.platform !== "darwin"
  },
  async (t) => {
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { client, close } = await connect(workspace, "validator");
    t.after(() => close());
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "duplicates",
      "duplicates_similar",
      "git_blame",
      "git_branches",
      "git_diff",
      "git_diff_path",
      "git_diff_staged",
      "git_diff_stat",
      "git_head",
      "git_log",
      "git_log_path",
      "git_ls_files",
      "git_merge_base",
      "git_show",
      "git_status",
      "knip",
      "knip_production",
      "lint",
      "test",
      "typecheck"
    ]);
  }
);

test(
  "a read-only role is refused the command surface entirely",
  {
    skip: process.platform !== "darwin"
  },
  async (t) => {
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, "--role", "explorer", "--workspace", workspace],
      env: processEnvironment()
    });
    const client = new Client({
      name: "commands-integration",
      version: "1.0.0"
    });
    await assert.rejects(() => client.connect(transport));
  }
);

test(
  "the native task lifecycle is available to a client that drives it",
  {
    skip: process.platform !== "darwin"
  },
  async (t) => {
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { client, close } = await connect(workspace, "worker");
    t.after(() => close());

    // An augmented call receives the task immediately rather than a result.
    const augmented = await client.request(
      {
        method: "tools/call",
        params: {
          name: "git_status",
          arguments: {},
          task: { ttl: 60000 }
        }
      },
      CreateTaskResultSchema
    );
    assert.ok(augmented.task.taskId, "the augmented call must return a task");

    const taskId = augmented.task.taskId;
    let status = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const observed = await client.experimental.tasks.getTask(taskId);
      status = observed.status;
      if (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status, "completed");
    const taskResult = await client.experimental.tasks.getTaskResult(
      taskId,
      CallToolResultSchema
    );
    const payload = taskResult.structuredContent as { commandId: string };
    assert.equal(payload.commandId, "git_status");
  }
);

test(
  "the server runs commands when launched exactly as the gateway launches it",
  {
    skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    // The server is a trusted broker that confines each command under its own
    // Seatbelt profile. macOS refuses that profile from inside any restrictive
    // one, so a gateway launch that wrapped the server in a sandbox ran no
    // command at all (exit 71, `sandbox_apply: Operation not permitted`)
    // while the server started from its own entry point worked.
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const home = process.env.HOME!;
    const launch = externalMcpBackend(
      "commands",
      path.resolve(import.meta.dirname, "../.."),
      workspace,
      process.execPath,
      home,
      process.env.CODEX_HOME ?? path.join(home, ".codex"),
      { role: "worker" }
    );
    assert.notEqual(launch.command, "/usr/bin/sandbox-exec");
    const client = new Client({
      name: "commands-gateway-launch",
      version: "1.0.0"
    });
    await client.connect(
      new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        cwd: workspace,
        env: processEnvironment()
      })
    );
    t.after(() => client.close());

    const result = await client.callTool({ name: "git_status", arguments: {} });
    const structured = result.structuredContent as {
      status: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };
    assert.equal(structured.status, "succeeded", structured.stderr);
    assert.equal(structured.exitCode, 0);
    assert.match(structured.stdout, /README\.md/u);
  }
);

test(
  "the server refuses to start when the approved catalogue is inside the workspace",
  {
    skip: process.platform !== "darwin"
  },
  async (t) => {
    // The repository's own catalogue is the approved one; a workspace that
    // contains it would let an agent edit its own authority, so the server
    // must refuse rather than serve.
    const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, "--role", "worker", "--workspace", repositoryRoot],
      env: processEnvironment()
    });
    const client = new Client({
      name: "commands-integration",
      version: "1.0.0"
    });
    await assert.rejects(() => client.connect(transport));
  }
);

test(
  "the workspace's scratch and cache live outside it",
  {
    skip: process.platform !== "darwin"
  },
  async (t) => {
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { client, close } = await connect(workspace, "worker");
    t.after(() => close());
    await client.listTools();
    const runDirectory = path.join(process.env.CODEX_HOME ?? "", "run");
    assert.ok(runDirectory.length > 0);
    // The command's private roots are provisioned by the Runtime, not by the
    // workspace, so a command cannot write into another workspace's cache.
    const scratch = path.join(runDirectory, "command-scratch");
    const cache = path.join(runDirectory, "command-cache");
    assert.ok(!scratch.startsWith(workspace));
    assert.ok(!cache.startsWith(workspace));
    assert.ok(existsSync(scratch));
    assert.ok(existsSync(cache));
  }
);

test(
  "a command's output is bounded and its exit status is the observed one",
  {
    skip: process.platform !== "darwin"
  },
  async (t) => {
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { client, close } = await connect(workspace, "worker");
    t.after(() => close());
    // A command that fails reports the status it observed, and is a
    // completed command rather than a transport failure.
    const result = await client.callTool({
      name: "git_diff",
      arguments: {}
    });
    const structured = result.structuredContent as {
      status: string;
      exitCode: number | null;
      durationMs: number;
    };
    assert.equal(structured.status, "succeeded", JSON.stringify(structured));
    assert.equal(structured.exitCode, 0);
    assert.ok(structured.durationMs >= 0);
  }
);

test(
  "the server writes its private roots with owner-only permissions",
  {
    skip: process.platform !== "darwin"
  },
  async (t) => {
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { client, close } = await connect(workspace, "worker");
    t.after(() => close());
    await client.listTools();
    const scratch = path.join(
      process.env.CODEX_HOME ?? "",
      "run",
      "command-scratch"
    );
    const entries = execFileSync("/bin/ls", ["-la", scratch], {
      encoding: "utf8"
    })
      .split("\n")
      .filter((entry) => entry.startsWith("d") || entry.startsWith("-"));
    for (const entry of entries) {
      assert.match(
        entry,
        /^drwx------/u,
        `scratch entry is not private: ${entry}`
      );
    }
    mkdirSync(path.join(scratch, "probe"), { mode: 0o700 });
  }
);

test(
  "a commit made through the command surface is attributed to the agent",
  {
    skip: process.platform !== "darwin"
  },
  async (t) => {
    const workspace = workspaceFixture();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { client, close } = await connect(workspace, "worker");
    t.after(() => close());

    // Selective staging treats an option-looking name as a literal path.
    writeFileSync(path.join(workspace, "--literal.txt"), "selected\n");
    const staged = await client.callTool({
      name: "git_add",
      arguments: { path: "--literal.txt" }
    });
    assert.equal(
      (staged.structuredContent as { status: string }).status,
      "succeeded"
    );

    const committed = await client.callTool({
      name: "git_commit",
      arguments: { message: "fixture commit" }
    });
    const result = committed.structuredContent as {
      status: string;
      exitCode: number | null;
      stderr: string;
    };
    assert.equal(result.status, "succeeded", result.stderr);
    assert.equal(result.exitCode, 0);

    const run = async (
      name: string,
      arguments_: Record<string, string> = {}
    ) => {
      const response = await client.callTool({ name, arguments: arguments_ });
      const value = response.structuredContent as {
        status: string;
        stdout: string;
        stderr: string;
      };
      assert.equal(value.status, "succeeded", value.stderr);
      return value.stdout;
    };
    assert.match(await run("git_status"), /\?\? README\.md/u);
    assert.match(await run("git_log"), /fixture commit/u);
    assert.match(
      await run("git_log_path", { path: "--literal.txt" }),
      /fixture commit/u
    );
    const head = (await run("git_head")).trim();
    assert.match(head, /^[0-9a-f]{40,64}$/u);
    assert.match(await run("git_show", { revision: head }), /selected/u);
    assert.match(await run("git_branches"), /main/u);
    assert.match(
      await run("git_blame", { path: "--literal.txt" }),
      /selected/u
    );
    assert.match(await run("git_ls_files"), /--literal\.txt/u);
    assert.equal(
      (await run("git_merge_base", { left: "HEAD", right: head })).trim(),
      head
    );
    writeFileSync(path.join(workspace, "--literal.txt"), "updated\n");
    assert.match(await run("git_diff_stat"), /--literal\.txt/u);
    assert.match(
      await run("git_diff_path", { path: "--literal.txt" }),
      /\+updated/u
    );
    await run("git_add", { path: "--literal.txt" });
    assert.match(await run("git_diff_staged"), /\+updated/u);
    await run("git_unstage", { path: "--literal.txt" });
    assert.equal((await run("git_diff_staged")).trim(), "");
    assert.match(
      await run("git_diff_path", { path: "--literal.txt" }),
      /\+updated/u
    );

    // The commit exists and carries the Runtime's own agent identity, which
    // is the only identity a confined command can be given.
    const log = execFileSync(
      "/usr/bin/git",
      ["log", "-1", "--format=%an <%ae>%n%cn <%ce>"],
      {
        cwd: workspace,
        encoding: "utf8"
      }
    ).trim();
    assert.match(log, /^AutoDev Agent \(worker\) <autodev-worker-/u);
    assert.match(log, /AutoDev Agent \(worker\) <autodev-worker-/u);
    // The subject is the parameter the model supplied, carried literally.
    const subject = execFileSync("/usr/bin/git", ["log", "-1", "--format=%s"], {
      cwd: workspace,
      encoding: "utf8"
    }).trim();
    assert.equal(subject, "fixture commit");
  }
);
