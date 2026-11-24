import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deleteKeychainSecret,
  readKeychainSecret,
  readRuntimeSecret,
  resolveManagedSecret,
  secureDeleteFile,
  writeKeychainSecret
} from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

function fixture(): { root: string; codexHome: string } {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-runtime-secret-"));
  const codexHome = path.join(root, ".codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return { root, codexHome };
}

test("readRuntimeSecret reads only the exact key from the protected Runtime file", () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.codexHome, "openlit-secrets.env"),
      [
        "AUTODEV_CONTROL_API_TOKEN=general-token",
        'export AUTODEV_PLAYTEST_CONTROL_API_TOKEN="runner-token"',
        "PREFIX_AUTODEV_PLAYTEST_CONTROL_API_TOKEN=not-the-key",
        "# AUTODEV_PLAYTEST_CONTROL_API_TOKEN=commented-out"
      ].join("\n") + "\n",
      { mode: 0o600 }
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN", {
        HOME: f.root
      }),
      "runner-token"
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_CONTROL_API_TOKEN", { HOME: f.root }),
      "general-token"
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN", {
        HOME: f.root,
        AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "process-runner-token"
      }),
      "process-runner-token"
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("resolveManagedSecret prefers explicit environment overrides over Keychain", () => {
  const calls: string[][] = [];
  const deps = {
    platform: "darwin" as const,
    runSecurity: (args: readonly string[]) => {
      calls.push([...args]);
      return "from-keychain\n";
    }
  };
  const env = { USER: "tester", AUTODEV_DISABLE_KEYCHAIN: "0" };
  assert.equal(
    resolveManagedSecret("MINIMAX_API_KEY", env, deps),
    "from-keychain"
  );
  assert.equal(calls.length, 1);

  assert.equal(
    resolveManagedSecret(
      "MINIMAX_API_KEY",
      { ...env, MINIMAX_API_KEY: "explicit-override" },
      deps
    ),
    "explicit-override"
  );
  assert.equal(calls.length, 1);

  assert.equal(resolveManagedSecret("UNMANAGED_SECRET", env, deps), null);
  assert.equal(calls.length, 1);
});

test("writeKeychainSecret passes secret via stdin to security -i and trusts /usr/bin/security", () => {
  const invocations: Array<{ args: string[]; input?: string }> = [];
  const store = new Map<string, string>();
  const deps = {
    platform: "darwin" as const,
    runSecurity: (args: readonly string[], input?: string) => {
      invocations.push({
        args: [...args],
        ...(input === undefined ? {} : { input })
      });
      if (args[0] === "-i" && input) {
        const match =
          /-s "([^"]+)" -T "\/usr\/bin\/security" -w "((?:[^"\\]|\\.)*)"/u.exec(
            input
          );
        if (match) {
          store.set(
            match[1]!,
            match[2]!.replaceAll('\\"', '"').replaceAll("\\\\", "\\")
          );
        }
        return "";
      }
      if (args[0] === "find-generic-password") {
        const service = args[args.indexOf("-s") + 1]!;
        const found = store.get(service);
        if (!found) throw new Error("not found");
        return `${found}\n`;
      }
      if (args[0] === "delete-generic-password") {
        const service = args[args.indexOf("-s") + 1]!;
        if (!store.delete(service)) throw new Error("not found");
        return "";
      }
      throw new Error("unexpected security invocation");
    }
  };
  const env = { USER: "tester", AUTODEV_DISABLE_KEYCHAIN: "0" };
  const secretValue = 'sk-secret_"quoted" $val';
  writeKeychainSecret("AUTODEV_CHATGPT_TUNNEL_API_KEY", secretValue, env, deps);
  assert.deepEqual(invocations[0]?.args, ["-i"]);
  assert.match(invocations[0]?.input ?? "", /-T "\/usr\/bin\/security"/u);
  assert.equal(
    readKeychainSecret("AUTODEV_CHATGPT_TUNNEL_API_KEY", env, { deps }),
    secretValue
  );
  assert.equal(
    deleteKeychainSecret("AUTODEV_CHATGPT_TUNNEL_API_KEY", env, deps),
    true
  );
  assert.equal(
    readKeychainSecret("AUTODEV_CHATGPT_TUNNEL_API_KEY", env, { deps }),
    null
  );
});

test(
  "real macOS security CLI round-trips Keychain items unattended in an isolated keychain",
  { skip: process.platform !== "darwin" },
  () => {
    const f = fixture();
    const keychain = path.join(f.root, "autodev-test.keychain-db");
    try {
      execFileSync("/usr/bin/security", [
        "create-keychain",
        "-p",
        "test-pass",
        keychain
      ]);
      execFileSync("/usr/bin/security", [
        "unlock-keychain",
        "-p",
        "test-pass",
        keychain
      ]);
      const env = {
        USER: "autodev-tester",
        AUTODEV_DISABLE_KEYCHAIN: "0",
        AUTODEV_KEYCHAIN_FILE: keychain
      };
      for (const [name, value] of [
        ["MINIMAX_API_KEY", "sk-minimax-real-test"],
        ["CONTEXT7_API_KEY", "ctx7sk-real-test"],
        ["AUTODEV_CHATGPT_TUNNEL_API_KEY", "sk-tunnel-real-test"]
      ] as const) {
        writeKeychainSecret(name, value, env);
        assert.equal(readKeychainSecret(name, env), value);
        assert.equal(
          resolveManagedSecret(name, { ...env, [name]: "override-val" }),
          "override-val"
        );
        assert.equal(deleteKeychainSecret(name, env), true);
        assert.equal(readKeychainSecret(name, env), null);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
);

test("secureDeleteFile overwrites and removes regular files without erroring on missing files", () => {
  const f = fixture();
  try {
    const target = path.join(f.root, "runtime.key");
    writeFileSync(target, "plaintext-secret\n", { mode: 0o600 });
    secureDeleteFile(target);
    assert.equal(existsSync(target), false);
    secureDeleteFile(target);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("readRuntimeSecret fails closed when the exact key or secret file is absent", () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.codexHome, "openlit-secrets.env"),
      "AUTODEV_CONTROL_API_TOKEN=general-token\n"
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN", {
        HOME: f.root
      }),
      null
    );
    assert.equal(
      readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN", {
        HOME: path.join(f.root, "missing")
      }),
      null
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
