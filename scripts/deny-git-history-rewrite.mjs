#!/usr/bin/env node
// PreToolUse guard shared by Claude Code (.claude/settings.json) and Codex
// (.codex/config.toml). Blocks any attempt by an agent to run
// `git checkout`, `git reset`, or `git stash`, which can silently discard or
// rewrite uncommitted work in the shared worktree.
//
// Both harnesses speak the same PreToolUse contract: a JSON payload is written
// to stdin, and a `hookSpecificOutput.permissionDecision` of "deny" on stdout
// (exit 0) blocks the call. Any other output allows it. On unexpected input we
// fail open (allow) so a malformed payload never bricks every command — the
// native permission deny-lists remain as a backstop.

const BLOCKED = new Set(['checkout', 'reset', 'stash']);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// Keys whose value carries a shell command across the harnesses/tools we know
// (Claude Bash -> `command`; Codex shell/local_shell -> `command`/argv;
// exec_command/unified_exec -> `cmd`/`input`). Deliberately excludes content
// fields like `content`/`file_text` so editing a file that merely mentions
// "git reset" is never blocked.
const COMMAND_KEYS = new Set([
  'command',
  'cmd',
  'args',
  'argv',
  'script',
  'shell_command',
  'run',
  'input',
]);

// Turn a command-bearing value into inspectable strings: plain strings, plus
// the space-joined form of string arrays so an argv payload like
// ["git","reset","--hard"] is still inspectable.
function valueToStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    const strings = value.filter((v) => typeof v === 'string');
    if (strings.length > 1) out.push(strings.join(' '));
    for (const v of value) valueToStrings(v, out);
  }
  return out;
}

// Walk the tool input and collect candidate command strings only from
// command-bearing keys (recursing into nested objects/arrays to find them).
function collectCandidates(node, out) {
  if (Array.isArray(node)) {
    for (const v of node) collectCandidates(v, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (COMMAND_KEYS.has(key)) valueToStrings(value, out);
      collectCandidates(value, out);
    }
  }
  return out;
}

// git global options that consume the following token as their value.
const VALUE_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

function segmentHitsBlockedGit(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip leading environment assignments: FOO=bar git ...
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return false;

  const cmd = tokens[i];
  const base = cmd.split('/').pop() || cmd;
  // Dashed form: git-reset / git-checkout / git-stash
  const dashed = /^git-(checkout|reset|stash)$/.exec(base);
  if (dashed) return true;
  if (base !== 'git' && base !== 'git.exe') return false;
  i++;

  // Walk git global options to reach the subcommand.
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (VALUE_OPTS.has(t)) i += 2; // option + its value
      else i += 1; // flag, or --opt=value form
      continue;
    }
    return BLOCKED.has(t); // first non-option token is the subcommand
  }
  return false;
}

function commandIsBlocked(command) {
  // Split on shell control/grouping operators so `cd x && git reset` and
  // subshells are each inspected independently.
  const segments = command.split(/(?:&&|\|\||[;\n|&()`]|\$\()/);
  return segments.some(segmentHitsBlockedGit);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // not JSON -> allow (fail open)
  }
  const toolInput = payload && payload.tool_input;
  if (!toolInput) return;

  const candidates = collectCandidates(toolInput, []);
  for (const c of candidates) {
    if (commandIsBlocked(c)) {
      deny(
        'Blocked: agents are not permitted to run `git checkout`, `git reset`, ' +
          'or `git stash` in this repository (they can discard or rewrite ' +
          'uncommitted work). Ask the user to run it, or use a non-destructive ' +
          'alternative such as `git switch -c`, `git restore --staged`, or `git worktree`.',
      );
    }
  }
}

main().catch(() => process.exit(0));
