/**
 * What a read-only role is allowed to do with a tool.
 *
 * Codex cannot narrow the sandbox of a spawned child: the child thread is
 * created from the parent's configuration, and the role layer Codex applies on
 * top carries the model, the instructions, the skills and the features, but no
 * sandbox. A role that declares `read-only` therefore inherits the parent
 * session's sandbox, and a read-only role under a workspace-write session can
 * write to the workspace.
 *
 * AutoDev owns the tool boundary, so AutoDev enforces the tier itself: this
 * module is the policy that decides whether one tool call may run in a
 * read-only role.
 *
 * The policy is an allowlist. A command is permitted when every command in it
 * is a command that cannot write, and the shell's write-capable constructs --
 * redirection, command substitution, environment overrides -- are refused
 * outright. A denylist would have to know every command that can write, and
 * the next interpreter, build tool or script runner would be a hole in it;
 * an allowlist fails closed, and the cost of failing closed is that a
 * read-only role asks for something it may not have.
 *
 * The tier this policy enforces is the filesystem one, plus the remote writes
 * the ordinary read-only tools can make (`curl` posting, `gh` creating an
 * issue). The network dimension stays where the session's own sandbox puts
 * it, and the MCP servers a role may reach are the role's own contract.
 */

/** What the policy decided about one tool call. */
export interface ReadOnlyDecision {
  /** Whether the call may run. */
  readonly allowed: boolean;
  /** Why the call was refused, and what to do instead. */
  readonly reason: string | null;
}

const ALLOWED: ReadOnlyDecision = { allowed: true, reason: null };

/**
 * The tools that write.
 *
 * A patch tool is the one the model reaches for to change a file, and the
 * write tools the MCP servers expose are named by their own convention. The
 * names are matched after normalizing separators and case, so `apply_patch`,
 * `applyPatch` and `apply-patch` are one tool.
 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "apply_patch",
  "applypatch",
  "patch",
  "write",
  "write_file",
  "writefile",
  "create_file",
  "createfile",
  "edit",
  "edit_file",
  "editfile",
  "multi_edit",
  "multiedit",
  "notebook_edit",
  "notebookedit",
  "delete_file",
  "deletefile",
  "remove_file",
  "move_file",
  "movefile",
  "copy_file",
  "copyfile",
  "str_replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "write_stdin_file"
]);

/**
 * The names a tool that writes carries.
 *
 * A native tool whose name says it writes is refused even when the product
 * does not know the tool: a tool the policy has never heard of is not a tool
 * it may let through. The names are matched as tokens, so `write_report` and
 * `fileWrite` are one shape.
 */
const WRITE_TOOL_TOKENS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "patch",
  "create",
  "delete",
  "remove",
  "move",
  "copy",
  "replace",
  "insert",
  "append",
  "rename",
  "mkdir",
  "touch",
  "chmod"
]);

/**
 * The tools that run a shell command.
 *
 * The names are the ones Codex and the provider CLIs use for a shell call.
 * Codex's own shell tool is `exec_command`; `shell` is the plain-shell form
 * and `unified_exec` the session-scoped one.
 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "exec_command",
  "execcommand",
  "execute_command",
  "unified_exec",
  "unifiedexec",
  "run_command",
  "runcommand",
  "shell",
  "bash",
  "sh",
  "zsh",
  "write_stdin",
  "writestdin"
]);

/**
 * The commands that cannot write.
 *
 * Every entry reads files, lists directories, or inspects state. A command
 * that is not here is refused: the list is the set of commands whose read-only
 * behaviour is a property of the command rather than of the arguments it was
 * given.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "apropos",
  "basename",
  "b2sum",
  "cat",
  "cksum",
  "cmp",
  "column",
  "comm",
  "cut",
  "date",
  "df",
  "diff",
  "dirname",
  "du",
  "echo",
  "egrep",
  "expn",
  "false",
  "fgrep",
  "file",
  "find",
  "fd",
  "fold",
  "grep",
  "head",
  "help",
  "hostname",
  "id",
  "info",
  "ioreg",
  "jq",
  "join",
  "less",
  "ls",
  "man",
  "md5",
  "md5sum",
  "mdfind",
  "more",
  "nl",
  "od",
  "paste",
  "printenv",
  "printf",
  "ps",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "ripgrep",
  "seq",
  "sha1",
  "sha1sum",
  "sha256",
  "sha256sum",
  "sha512sum",
  "shasum",
  "sleep",
  "sort",
  "stat",
  "strings",
  "sw_vers",
  "tail",
  "test",
  "tree",
  "true",
  "tr",
  "tsort",
  "type",
  "uniq",
  "uptime",
  "vm_stat",
  "wc",
  "w",
  "which",
  "who",
  "whoami",
  "xxd",
  "yq"
]);

/**
 * The commands that read, but have a form that writes.
 *
 * The command is allowed only when none of the listed flags is present. Each
 * flag names the write the command can perform, so the list is the reason the
 * command is not simply read-only.
 */
const FLAGGED_COMMANDS: Readonly<
  Record<string, { readonly flags: readonly string[]; readonly why: string }>
> = {
  find: {
    flags: [
      "-delete",
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-fprintf0",
      "-fls"
    ],
    why: "it deletes, runs another command, or writes a file list"
  },
  sort: {
    flags: ["-o", "--output"],
    why: "it writes its output to a file"
  },
  fd: {
    flags: ["-x", "--exec", "-X", "--exec-batch"],
    why: "it runs another command for every match"
  },
  rg: {
    flags: ["--pre"],
    why: "it runs a preprocessor command for every file it reads"
  },
  man: {
    flags: ["-P", "--pager"],
    why: "it runs the pager it is told to run"
  },
  yq: {
    flags: ["-i", "--inplace"],
    why: "it rewrites the file in place"
  }
};

/**
 * The `git` subcommands that only read.
 *
 * A `git` subcommand outside this set writes to the repository or to the
 * remote: `git commit` writes the object store, `git push` writes the remote,
 * and `git config` writes the configuration that other `git` commands read.
 */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "annotate",
  "blame",
  "cat-file",
  "check-attr",
  "check-ignore",
  "cherry",
  "count-objects",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "range-diff",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "verify-commit",
  "verify-tag",
  "whatchanged"
]);

/**
 * How a `git` subcommand reads, when its bare form reads and a verb does.
 *
 * `git branch` lists branches and creates them, `git tag` lists tags and
 * creates them, `git stash` lists stashes and writes them, and `git config`
 * reads and writes configuration. Each is allowed only in the form that lists.
 *
 * `bareAllowed` says whether the subcommand with no argument at all reads.
 * `git stash` does not: with no argument it stashes the working tree, which
 * writes.
 *
 * `verbsAreArguments` says whether the first positional argument is an
 * argument rather than a verb. `git config <key>` reads a key, so its
 * positional argument is an argument; `git remote show <name>` reads, so its
 * positional argument is a verb.
 */
interface GitSubcommandRule {
  /** The verbs that make the subcommand read. */
  readonly allowedVerbs: readonly string[];
  /** How many positional arguments may follow the verb. */
  readonly maxArguments: number;
  /** Whether the subcommand with no argument at all reads. */
  readonly bareAllowed: boolean;
  /** Whether the first positional argument is an argument rather than a verb. */
  readonly verbsAreArguments: boolean;
  /** Why the subcommand is not simply read-only. */
  readonly why: string;
}

const LIST_ONLY_GIT_SUBCOMMANDS: Readonly<Record<string, GitSubcommandRule>> = {
  branch: {
    allowedVerbs: [],
    maxArguments: 0,
    bareAllowed: true,
    verbsAreArguments: true,
    why: "it creates, renames or deletes a branch"
  },
  tag: {
    allowedVerbs: [],
    maxArguments: 0,
    bareAllowed: true,
    verbsAreArguments: true,
    why: "it creates or deletes a tag"
  },
  config: {
    allowedVerbs: [],
    maxArguments: 1,
    bareAllowed: true,
    verbsAreArguments: true,
    why: "it writes the configuration"
  },
  remote: {
    allowedVerbs: ["show", "get-url"],
    maxArguments: 1,
    bareAllowed: true,
    verbsAreArguments: false,
    why: "it writes the remote configuration"
  },
  stash: {
    allowedVerbs: ["list", "show"],
    maxArguments: 1,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it writes a stash"
  },
  notes: {
    allowedVerbs: ["list", "show"],
    maxArguments: 1,
    bareAllowed: true,
    verbsAreArguments: false,
    why: "it writes a note"
  },
  worktree: {
    allowedVerbs: ["list"],
    maxArguments: 0,
    bareAllowed: true,
    verbsAreArguments: false,
    why: "it writes the worktree configuration"
  },
  submodule: {
    allowedVerbs: ["status"],
    maxArguments: 0,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it writes the submodule configuration"
  },
  reflog: {
    allowedVerbs: ["show"],
    maxArguments: 1,
    bareAllowed: true,
    verbsAreArguments: false,
    why: "it expires or deletes reflog entries"
  },
  "symbolic-ref": {
    allowedVerbs: [],
    maxArguments: 1,
    bareAllowed: true,
    verbsAreArguments: true,
    why: "it points a ref at another ref"
  }
};

/**
 * The `git` options that change what git runs.
 *
 * `-c` and `--config-env` set configuration for the invocation, and the
 * configuration can name a program to run (`core.pager`, `diff.external`).
 * `--exec-path` says where git looks for its subcommands, which is a
 * directory the agent can write to. All three are refused.
 */
const GIT_UNSAFE_OPTIONS: ReadonlySet<string> = new Set([
  "-c",
  "--config-env",
  "--exec-path"
]);

/**
 * The `git` options that take a value.
 *
 * The value is the option's argument, so it is not a positional argument of
 * the subcommand.
 */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix"
]);

/**
 * The `git` options that run another program.
 *
 * `--ext-diff` runs the configured diff driver and `--textconv` runs the
 * configured filter; both execute a program the agent may control.
 */
const GIT_EXECUTING_OPTIONS: ReadonlySet<string> = new Set([
  "--ext-diff",
  "--textconv"
]);

/**
 * The `git` options that write the diff or the log to a file.
 */
const GIT_OUTPUT_OPTIONS: ReadonlySet<string> = new Set(["--output", "-o"]);

/**
 * How a `gh` subcommand reads.
 *
 * `gh` writes to GitHub from most of its subcommands, so each is allowed
 * only in the verbs that read: `gh pr list` reads and `gh pr create` writes,
 * `gh repo clone` writes files into the workspace, and `gh run download`
 * writes an artifact to disk.
 */
interface GhSubcommandRule {
  /** The verbs that make the subcommand read. */
  readonly allowedVerbs: readonly string[];
  /** How many positional arguments may follow the verb. */
  readonly maxArguments: number;
  /** Whether the subcommand with no argument at all reads. */
  readonly bareAllowed: boolean;
  /** Whether the first positional argument is an argument rather than a verb. */
  readonly verbsAreArguments: boolean;
  /** Why the subcommand is not simply read-only. */
  readonly why: string;
}

const GH_SUBCOMMANDS: Readonly<Record<string, GhSubcommandRule>> = {
  api: {
    allowedVerbs: [],
    maxArguments: 2,
    bareAllowed: true,
    verbsAreArguments: true,
    why: "it writes to the API when it is given a method or a field"
  },
  auth: {
    allowedVerbs: ["status"],
    maxArguments: 0,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it changes the account it is authenticated as"
  },
  issue: {
    allowedVerbs: ["list", "view", "status"],
    maxArguments: 1,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it creates, closes or edits an issue"
  },
  label: {
    allowedVerbs: ["list"],
    maxArguments: 0,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it creates, edits or deletes a label"
  },
  pr: {
    allowedVerbs: ["list", "view", "status", "diff", "checks"],
    maxArguments: 1,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it creates, merges or edits a pull request"
  },
  release: {
    allowedVerbs: ["list", "view"],
    maxArguments: 1,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it creates, edits or uploads a release"
  },
  repo: {
    allowedVerbs: ["list", "view"],
    maxArguments: 1,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it creates, edits, forks or clones a repository"
  },
  run: {
    allowedVerbs: ["list", "view"],
    maxArguments: 1,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it reruns, cancels or downloads a workflow run"
  },
  search: {
    allowedVerbs: [],
    maxArguments: 2,
    bareAllowed: true,
    verbsAreArguments: true,
    why: "it does not write"
  },
  secret: {
    allowedVerbs: ["list"],
    maxArguments: 0,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it sets or deletes a secret"
  },
  workflow: {
    allowedVerbs: ["list", "view"],
    maxArguments: 1,
    bareAllowed: false,
    verbsAreArguments: false,
    why: "it runs, enables or disables a workflow"
  }
};

/**
 * The `gh` flags that write.
 *
 * `-X`/`--method` choose the HTTP method and `-f`/`-F`/`--input` send a body,
 * so `gh api` with any of them writes to the API.
 */
const GH_WRITE_FLAGS: readonly string[] = [
  "-X",
  "--method",
  "-f",
  "--field",
  "-F",
  "--raw-field",
  "--input"
];

/**
 * The `curl` flags that write the response to a file.
 */
const CURL_OUTPUT_FLAGS: readonly string[] = [
  "-o",
  "--output",
  "-O",
  "--remote-name",
  "-T",
  "--upload-file",
  "-D",
  "--dump-header",
  "--output-dir",
  "--create-dirs",
  "--trace",
  "--trace-ascii",
  "-c",
  "--cookie-jar",
  "-K",
  "--config",
  "--dump-ca-cert",
  "--egd-file"
];

/**
 * The `curl` flags that send a body or choose a method that writes.
 *
 * `curl` writes to the remote when it is told to post, and a body flag
 * implies a POST. The read-only tier refuses both.
 */
const CURL_WRITE_FLAGS: readonly string[] = [
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "-d",
  "--form",
  "-F",
  "--json",
  "--upload-file",
  "-T"
];

/**
 * The HTTP methods that do not write.
 */
const READ_ONLY_HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS"
]);

/**
 * The paths a command may be run from.
 *
 * A command that is not a bare name has to live in a system directory the
 * agent cannot write to. The agent can write to the workspace and to the
 * temporary directory, so a script it drops there and runs by path would be
 * its own code running with the agent's authority.
 */
const TRUSTED_COMMAND_PREFIXES: readonly string[] = [
  "/bin/",
  "/sbin/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/local/bin/",
  "/usr/local/sbin/",
  "/opt/homebrew/bin/",
  "/opt/homebrew/sbin/",
  "/opt/local/bin/",
  "/opt/local/sbin/"
];

/**
 * The shape of an environment assignment at the start of a command.
 */
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * The shape of the flag that gives a shell its script.
 */
const SHELL_COMMAND_FLAG = /^-[a-z]*c$/u;

/**
 * The shape of the whitespace that separates a shell's words.
 */
const WHITESPACE = /\s/u;

/**
 * The boundary between two words of a camel-cased tool name.
 */
const CAMEL_CASE_BOUNDARY = /([a-z0-9])([A-Z])/gu;

/**
 * The boundary between the words of a tool name.
 */
const NON_WORD_BOUNDARY = /[^a-z0-9]+/iu;

/**
 * The shells whose `-c` argument is a script of its own.
 *
 * Codex runs a command through `/bin/zsh -lc <script>`, and a model that
 * reaches for a shell directly does the same with `bash -c`. The script is
 * what runs, so the script is what is judged.
 */
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish"
]);

/**
 * Split a shell command into the segments it runs.
 *
 * The separators are the ones that chain commands. A pipeline of read-only
 * commands is read-only, so each segment is judged on its own. The splitting
 * respects quotes, so a separator inside a quoted argument does not split.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const character of command) {
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (
      character === ";" ||
      character === "|" ||
      character === "&" ||
      character === "\n"
    ) {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Split one segment into its command and arguments.
 *
 * Quoting is honoured so that a quoted argument is one argument: a command
 * whose name is quoted is still the command it names.
 */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const character of segment) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (WHITESPACE.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** The tool name, normalized so that the spellings of one tool are one tool. */
export function normalizeToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/gu, "_");
}

/** Whether a tool, by its normalized name, runs a shell command. */
export function isShellToolName(normalizedName: string): boolean {
  return SHELL_TOOL_NAMES.has(normalizedName);
}

/**
 * The script a shell interpreter segment runs, when the segment is one:
 * `bash -c "git log"` runs `git log`. Null for any other command.
 */
export function shellInterpreterScript(
  name: string,
  args: readonly string[]
): string | null {
  if (!SHELL_INTERPRETERS.has(name)) return null;
  const flagIndex = args.findIndex((argument) =>
    SHELL_COMMAND_FLAG.test(argument)
  );
  return flagIndex === -1 ? null : (args[flagIndex + 1] ?? null);
}

/**
 * The command text a shell tool call carries.
 *
 * The tool input is the tool's own shape: `exec_command` takes `cmd`, and the
 * session-scoped `write_stdin` takes the text to send to the running shell.
 * A tool call whose command cannot be found is refused rather than assumed to
 * be harmless.
 *
 * A command given as an argument vector is the shape Codex's plain `shell`
 * tool uses, and its first element may be the shell itself: `["/bin/zsh",
 * "-lc", "ls"]` runs `ls`, so the script is what is judged.
 */
export function shellCommandFromToolInput(toolInput: unknown): string | null {
  if (typeof toolInput === "string") return toolInput;
  if (toolInput === null || typeof toolInput !== "object") return null;
  const record = toolInput as Record<string, unknown>;
  for (const key of ["cmd", "command", "input", "text", "chars"]) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      return shellScriptFromArgumentVector(value as string[]);
    }
  }
  return null;
}

/**
 * The script an argument vector runs.
 *
 * A vector that names a shell and a `-c` flag runs the script that follows
 * it; any other vector is the command itself, joined back into one line.
 */
function shellScriptFromArgumentVector(vector: readonly string[]): string {
  const [command, ...rest] = vector;
  if (command !== undefined) {
    const name = command.slice(command.lastIndexOf("/") + 1);
    if (SHELL_INTERPRETERS.has(name)) {
      const flagIndex = rest.findIndex((argument) =>
        SHELL_COMMAND_FLAG.test(argument)
      );
      if (flagIndex !== -1) {
        const script = rest[flagIndex + 1];
        if (script !== undefined) return script;
      }
    }
  }
  return vector.join(" ");
}

/**
 * Whether the command may be run by a path.
 *
 * A bare name is resolved through `PATH`, which the agent cannot change for
 * its own shell -- an environment override is refused separately -- and a path
 * has to be in a system directory the agent cannot write to.
 */
function commandPathIsTrusted(command: string): boolean {
  if (!command.includes("/")) return true;
  return TRUSTED_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix));
}

/**
 * Whether any of the command's arguments is one of the listed flags.
 *
 * A flag may carry its value attached (`--output=file`), so the flag name is
 * matched as a prefix of the argument up to the `=`.
 */
function hasFlag(
  args: readonly string[],
  flags: readonly string[] | ReadonlySet<string>
): boolean {
  const names = Array.isArray(flags) ? flags : [...flags];
  return args.some(
    (arg) =>
      names.includes(arg) || names.some((flag) => arg.startsWith(`${flag}=`))
  );
}

/**
 * Whether a positional argument list matches a subcommand's reading rule.
 *
 * The list is the arguments after the subcommand, with the flags removed.
 */
function positionalArgumentsMatch(
  positionals: readonly string[],
  rule: GitSubcommandRule | GhSubcommandRule
): boolean {
  if (rule.verbsAreArguments) {
    return (
      positionals.length <= rule.maxArguments &&
      (positionals.length > 0 || rule.bareAllowed)
    );
  }
  if (positionals.length === 0) return rule.bareAllowed;
  const verb = positionals[0];
  if (verb === undefined || !rule.allowedVerbs.includes(verb)) return false;
  return positionals.length - 1 <= rule.maxArguments;
}

/**
 * The flags that take a value, per subcommand.
 *
 * The value of such a flag is not a positional argument: `git branch --sort
 * refname` lists branches, and `refname` is the sort order rather than a
 * branch to create.
 */
const GIT_SUBCOMMAND_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> =
  {
    branch: [
      "--sort",
      "--format",
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "--points-at"
    ],
    tag: [
      "--sort",
      "--format",
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "--points-at"
    ],
    config: ["--file", "--type"],
    remote: ["--push", "--fetch"],
    stash: ["--message", "--include-untracked", "--keep-index", "--index"],
    notes: ["--ref", "--object"],
    worktree: [],
    submodule: [],
    reflog: ["--date", "--format"],
    "symbolic-ref": []
  };

/**
 * The `gh` flags that take a value.
 *
 * The value is not a positional argument: `gh pr list -R owner/repo` lists
 * the pull requests of one repository, and `owner/repo` names the repository
 * rather than the pull request.
 */
const GH_VALUE_FLAGS: readonly string[] = [
  "-R",
  "--repo",
  "-L",
  "--limit",
  "--json",
  "--jq",
  "--template",
  "-t",
  "--title",
  "-b",
  "--body",
  "-B",
  "-m",
  "--milestone",
  "-a",
  "--assignee",
  "--author",
  "-l",
  "--label",
  "--reviewer",
  "--team",
  "-p",
  "--project",
  "--notes",
  "--discussion",
  "--search",
  "-S",
  "--source"
];

/**
 * The positional arguments of a command, with the flags removed.
 *
 * A flag that takes a value consumes the next argument, so the value is not
 * a positional one.
 */
function positionalArguments(
  args: readonly string[],
  valueFlags: readonly string[] = []
): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument.startsWith("-")) {
      if (valueFlags.includes(argument)) index += 1;
      continue;
    }
    positionals.push(argument);
  }
  return positionals;
}

/**
 * The `git` options that precede the subcommand, and the arguments after it.
 *
 * `git -C /path log` is a global option with a value, and the subcommand is
 * `log`. A global option is separated from the subcommand because a global
 * option can change what git runs, which is a different question from what
 * the subcommand reads.
 */
function splitGitGlobalOptions(args: readonly string[]): {
  readonly globals: readonly string[];
  readonly rest: readonly string[];
} {
  const globals: string[] = [];
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined || !argument.startsWith("-")) break;
    globals.push(argument);
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const takesValue = GIT_VALUE_OPTIONS.has(name) && !argument.includes("=");
    index += takesValue ? 2 : 1;
  }
  return { globals, rest: args.slice(index) };
}

/**
 * Whether a `git` invocation only reads.
 *
 * The subcommand is the first argument that is not a flag. A subcommand that
 * only reads is allowed; one that reads only in its list form is allowed when
 * the invocation is that form.
 */
/**
 * The subcommand a `git` invocation runs: the first argument after the global
 * options that is not a flag. Undefined for a bare `git`.
 */
export function gitSubcommand(args: readonly string[]): string | undefined {
  return positionalArguments(splitGitGlobalOptions(args).rest)[0];
}

export function gitCommandIsReadOnly(args: readonly string[]): boolean {
  const { globals, rest } = splitGitGlobalOptions(args);
  for (const option of globals) {
    // An option may carry its value attached (`--exec-path=/tmp`), so the
    // option name is what is judged.
    const separator = option.indexOf("=");
    const name = separator === -1 ? option : option.slice(0, separator);
    if (GIT_UNSAFE_OPTIONS.has(name)) return false;
    // `-cname=value` sets configuration with the value attached.
    if (name.startsWith("-c") && name.length > 2) return false;
  }
  if (hasFlag(args, GIT_EXECUTING_OPTIONS)) return false;
  if (hasFlag(args, GIT_OUTPUT_OPTIONS)) return false;
  const positionals = positionalArguments(rest);
  const subcommand = positionals[0];
  if (subcommand === undefined) return false;
  const listOnly = LIST_ONLY_GIT_SUBCOMMANDS[subcommand];
  if (listOnly) {
    const valueFlags = GIT_SUBCOMMAND_VALUE_FLAGS[subcommand] ?? [];
    return positionalArgumentsMatch(
      positionalArguments(positionals.slice(1), valueFlags),
      listOnly
    );
  }
  return READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/**
 * Whether a `gh` invocation only reads.
 */
export function ghCommandIsReadOnly(args: readonly string[]): boolean {
  if (hasFlag(args, GH_WRITE_FLAGS)) return false;
  const positionals = positionalArguments(args, GH_VALUE_FLAGS);
  const subcommand = positionals[0];
  if (subcommand === undefined) return false;
  const rule = GH_SUBCOMMANDS[subcommand];
  if (!rule) return false;
  return positionalArgumentsMatch(positionals.slice(1), rule);
}

/**
 * Whether a `curl` invocation only reads.
 *
 * The request method decides whether it writes: a GET or a HEAD reads, and
 * anything else writes to the remote. A body flag implies a POST.
 */
export function curlCommandIsReadOnly(args: readonly string[]): boolean {
  if (hasFlag(args, CURL_OUTPUT_FLAGS)) return false;
  if (hasFlag(args, CURL_WRITE_FLAGS)) return false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-X" || argument === "--method") {
      const method = args[index + 1];
      if (method === undefined) return false;
      if (!READ_ONLY_HTTP_METHODS.has(method.toUpperCase())) return false;
      index += 1;
    }
  }
  return true;
}

/**
 * Whether one shell segment is read-only.
 */
function segmentIsReadOnly(
  segment: string,
  depth: number
): { ok: boolean; why: string } {
  const tokens = tokenize(segment);
  const command = tokens[0];
  if (command === undefined) return { ok: true, why: "" };
  const args = tokens.slice(1);

  // An environment override changes what the command resolves to or how it
  // runs -- `PATH` selects the binary, `GIT_PAGER` selects the program git
  // executes, `LD_PRELOAD` changes the process itself. A read-only role is
  // refused both.
  if (ENVIRONMENT_ASSIGNMENT.test(command))
    return {
      ok: false,
      why: "it sets an environment variable, which can change what the command runs"
    };

  if (!commandPathIsTrusted(command))
    return {
      ok: false,
      why: "it runs a program by path, and the agent can write the directories it may run from"
    };

  const name = command.slice(command.lastIndexOf("/") + 1);

  // A shell runs the script it is given, so the script is what runs.
  if (SHELL_INTERPRETERS.has(name)) {
    const script = shellInterpreterScript(name, args);
    if (script === null) {
      return {
        ok: false,
        why: "`${name}` was given no script to run"
      };
    }
    if (depth >= 2) {
      return {
        ok: false,
        why: "it nests shells more deeply than a read-only role may run"
      };
    }
    return segmentIsReadOnly(script, depth + 1);
  }

  if (name === "git")
    return { ok: gitCommandIsReadOnly(args), why: "git writes" };
  if (name === "gh") return { ok: ghCommandIsReadOnly(args), why: "gh writes" };
  if (name === "curl")
    return { ok: curlCommandIsReadOnly(args), why: "curl writes" };

  const flagged = FLAGGED_COMMANDS[name];
  if (flagged) {
    if (hasFlag(args, flagged.flags)) return { ok: false, why: flagged.why };
    return { ok: true, why: "" };
  }

  if (READ_ONLY_COMMANDS.has(name)) {
    // `less` runs a command when it is given one: `less +'!rm file'` is a
    // shell escape, and the escape is an argument.
    if (name === "less" && args.some((argument) => argument.startsWith("+")))
      return { ok: false, why: "it runs a command the pager is given" };
    return { ok: true, why: "" };
  }

  return {
    ok: false,
    why: "`${name}` is not a command a read-only role may run"
  };
}

/**
 * The shell constructs that let a command write or run something else.
 *
 * Redirection writes a file, command substitution runs another command, and
 * both are ways to smuggle a write past a list of readable commands.
 */
const WRITE_CONSTRUCTS: readonly {
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  { pattern: />/u, why: "it redirects output into a file" },
  { pattern: /`/u, why: "it substitutes the output of another command" },
  { pattern: /\$\(/u, why: "it substitutes the output of another command" }
];

/**
 * Whether a shell command may run in a read-only role.
 *
 * The command is allowed when it contains no write-capable construct and every
 * command it runs is one that cannot write.
 */
export function evaluateReadOnlyCommand(command: string): ReadOnlyDecision {
  const trimmed = command.trim();
  if (trimmed.length === 0) return ALLOWED;

  for (const construct of WRITE_CONSTRUCTS) {
    if (construct.pattern.test(trimmed))
      return {
        allowed: false,
        reason: `This role runs in a read-only sandbox, and the command ${construct.why}.`
      };
  }

  for (const segment of splitSegments(trimmed)) {
    const verdict = segmentIsReadOnly(segment, 0);
    if (!verdict.ok) {
      return {
        allowed: false,
        reason: `This role runs in a read-only sandbox, and the command ${verdict.why}. Report what you needed instead of running it.`
      };
    }
  }
  return ALLOWED;
}

/**
 * The words a tool name is made of.
 *
 * A camel-cased name and a separated one are the same name, so the name is
 * split on both: `replaceInFile` and `replace_in_file` are one shape.
 */
function toolNameTokens(name: string): string[] {
  return name
    .replaceAll(CAMEL_CASE_BOUNDARY, "$1_$2")
    .split(NON_WORD_BOUNDARY)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

/**
 * Whether a tool call may run in a read-only role.
 *
 * A tool that writes is refused by name. A tool that runs a shell is judged by
 * the command it carries. A tool that belongs to an MCP server is left to the
 * role's own contract, which is where the servers a role may reach are
 * decided. Every other tool -- reading a resource, searching the web, looking
 * at an image -- is left alone.
 */
export function evaluateReadOnlyToolCall(input: {
  readonly toolName: string;
  readonly toolInput: unknown;
}): ReadOnlyDecision {
  const toolName = normalizeToolName(input.toolName);
  // An MCP server's tools are the role's own contract: the execution contract
  // says which servers a role may reach, and the server says what its tools
  // do. The policy governs Codex's own tools, where the tool is the model's
  // own hand on the workspace.
  if (toolName.startsWith("mcp__")) return ALLOWED;
  if (WRITE_TOOL_NAMES.has(toolName)) {
    return {
      allowed: false,
      reason:
        "This role runs in a read-only sandbox and may not change files. Report what you found instead of editing."
    };
  }
  if (isShellToolName(toolName)) {
    const command = shellCommandFromToolInput(input.toolInput);
    if (command === null) {
      return {
        allowed: false,
        reason:
          "This role runs in a read-only sandbox, and the command it asked to run could not be read."
      };
    }
    return evaluateReadOnlyCommand(command);
  }
  // A native tool the policy does not know, whose name says it writes, is
  // refused: an unknown tool is not a tool the policy may let through. The
  // words are read from the name as it was written, because the camel case
  // carries the boundary between them.
  const nameTokens = toolNameTokens(input.toolName);
  if (nameTokens.some((token) => WRITE_TOOL_TOKENS.has(token))) {
    return {
      allowed: false,
      reason:
        "This role runs in a read-only sandbox and may not change files. Report what you found instead of editing."
    };
  }
  return ALLOWED;
}
