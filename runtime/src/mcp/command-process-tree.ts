/**
Track the command's descendants across process groups and terminate them
when the command ends. A process group is a signal-delivery mechanism,
not a lifetime boundary: pnpm starts ordinary non-interactive lifecycle
scripts in their own groups. All descendants inherit the command's
Seatbelt profile regardless of their group.
*/
import { execFileSync } from "node:child_process";

const PROCESS_LIST = "/bin/ps";
const FREEZE_ROUNDS = 8;
const FREEZE_INTERVAL_MS = 25;
const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u;

interface ProcessRecord {
  readonly parent: number;
  readonly started: string;
}

interface CommandProcessNode {
  readonly pid: number;
  readonly started: string;
  readonly depth: number;
}

/**
Use one OS snapshot per observation. The start timestamp distinguishes
a previously observed process from a later occupant of its PID.
*/
function readProcesses(): Map<number, ProcessRecord> {
  const processes = new Map<number, ProcessRecord>();
  const output = execFileSync(
    PROCESS_LIST,
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "stat=", "-o", "lstart="],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024
    }
  );
  for (const line of output.split("\n")) {
    const match = PROCESS_LINE.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const state = match[3];
    const started = match[4];
    // A zombie has already exited and cannot execute or fork.
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parent) ||
      !state ||
      state.startsWith("Z") ||
      !started
    )
      continue;
    processes.set(pid, { parent, started });
  }
  if (!processes.has(process.pid))
    throw new Error("Host process snapshot is unavailable.");
  return processes;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
A command-lifetime observation ledger. Keep live observed descendants even
if they are reparented, and follow their children as well. Never treat an
independent process group as evidence of an escape. A descendant that forks
and is orphaned entirely between observations is not discoverable by ps;
that residual remains confined by Seatbelt.
*/
export class CommandProcessTree {
  private readonly rootPid: number | undefined;
  private rootExited = false;
  private rootStarted: string | undefined;
  private readonly tracked = new Map<number, CommandProcessNode>();

  constructor(rootPid: number | undefined) {
    this.rootPid = rootPid;
  }

  markRootExited(): void {
    this.rootExited = true;
    if (this.rootPid !== undefined) this.tracked.delete(this.rootPid);
  }

  observe(): CommandProcessNode[] {
    const processes = readProcesses();
    for (const [pid, node] of this.tracked) {
      if (processes.get(pid)?.started !== node.started)
        this.tracked.delete(pid);
    }
    if (!this.rootExited && this.rootPid !== undefined) {
      const root = processes.get(this.rootPid);
      if (
        root?.parent === process.pid &&
        (this.rootStarted === undefined || this.rootStarted === root.started)
      ) {
        this.rootStarted = root.started;
        this.tracked.set(this.rootPid, {
          pid: this.rootPid,
          started: root.started,
          depth: 0
        });
      }
    }
    const children = new Map<number, number[]>();
    for (const [pid, record] of processes) {
      const siblings = children.get(record.parent);
      if (siblings) siblings.push(pid);
      else children.set(record.parent, [pid]);
    }
    const frontier = [...this.tracked.values()];
    for (let index = 0; index < frontier.length; index++) {
      const parent = frontier[index];
      if (!parent) continue;
      for (const pid of children.get(parent.pid) ?? []) {
        if (this.tracked.has(pid)) continue;
        const record = processes.get(pid);
        if (!record) continue;
        const node = { pid, started: record.started, depth: parent.depth + 1 };
        this.tracked.set(pid, node);
        frontier.push(node);
      }
    }
    return [...this.tracked.values()];
  }

  /**
  Freeze every observed live process before killing deepest first. Refresh
  while frozen to find children forked immediately before the stop. Keep
  the root last so no known live child loses its parent before termination.
  */
  async terminate(): Promise<void> {
    const frozen = new Map<number, string>();
    let failure: unknown;
    try {
      for (let round = 0; round < FREEZE_ROUNDS; round++) {
        const fresh = this.observe().filter(
          (node) => frozen.get(node.pid) !== node.started
        );
        if (fresh.length === 0) break;
        for (const node of fresh.sort(
          (left, right) => left.depth - right.depth
        )) {
          signalProcess(node.pid, "SIGSTOP");
          frozen.set(node.pid, node.started);
        }
        await delay(FREEZE_INTERVAL_MS);
      }
    } catch (error) {
      failure = error;
    }
    // Revalidate retained PIDs even if they have been reparented. Continue
    // cleanup after an inspection or signaling failure, but report it.
    for (let round = 0; round < FREEZE_ROUNDS; round++) {
      try {
        const live = this.observe().sort(
          (left, right) => right.depth - left.depth
        );
        if (live.length === 0) break;
        for (const node of live) {
          try {
            signalProcess(node.pid, "SIGKILL");
          } catch (error) {
            failure ??= error;
          }
        }
      } catch (error) {
        failure ??= error;
      }
      await delay(FREEZE_INTERVAL_MS);
    }
    if (this.observe().length > 0)
      throw new Error("Command descendants did not exit after termination.");
    if (failure) throw failure;
  }
}
