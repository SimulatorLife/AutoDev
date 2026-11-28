/**
Track command descendants across process groups without blocking the broker.
A process group is not a lifetime boundary. All command descendants inherit
the command's Seatbelt profile, regardless of their process group.
*/
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const listProcesses = promisify(execFile);
const PROCESS_LIST = "/bin/ps";
const SNAPSHOT_TIMEOUT_MS = 1000;
const CLEANUP_BUDGET_MS = 5000;
const FREEZE_ROUNDS = 8;
const FREEZE_INTERVAL_MS = 25;
const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u;

export interface ProcessRecord {
  readonly parent: number;
  readonly group: number;
  readonly state: string;
  readonly started: string;
}

interface CommandProcessNode {
  readonly pid: number;
  readonly started: string;
  readonly depth: number;
}

/**
Reject malformed snapshots rather than treating an unreadable process as
absent. Keep zombie records for ancestry; never signal a zombie.
*/
export function parseCommandProcessSnapshot(
  output: string,
  brokerPid: number
): Map<number, ProcessRecord> {
  const processes = new Map<number, ProcessRecord>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = PROCESS_LINE.exec(line);
    if (!match) throw new Error("Invalid host process snapshot.");
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const group = Number(match[3]);
    const state = match[4];
    const started = match[5];
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parent) ||
      !Number.isSafeInteger(group) ||
      !state ||
      !started ||
      processes.has(pid)
    )
      throw new Error("Invalid host process snapshot.");
    if (pid === 0) continue;
    processes.set(pid, { parent, group, state, started });
  }
  if (!processes.has(brokerPid))
    throw new Error("Host process snapshot is unavailable.");
  return processes;
}

async function readProcesses(): Promise<Map<number, ProcessRecord>> {
  const { stdout } = await listProcesses(
    PROCESS_LIST,
    [
      "-A",
      "-o", "pid=",
      "-o", "ppid=",
      "-o", "pgid=",
      "-o", "stat=",
      "-o", "lstart="
    ],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      killSignal: "SIGKILL"
    }
  );
  return parseCommandProcessSnapshot(stdout, process.pid);
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isZombie(record: ProcessRecord): boolean {
  return record.state.startsWith("Z");
}

/**
Pure ownership ledger. Known descendants remain anchors across reparenting
and group changes. An independently launched root group can recover a
previously unseen member only while a matching known member still anchors
that group. Never rediscover an empty group by its numeric ID alone.
*/
export class CommandProcessLedger {
  private readonly tracked = new Map<number, CommandProcessNode>();
  private rootStarted: string | undefined;
  private rootGroup: number | undefined;

  observe(
    processes: ReadonlyMap<number, ProcessRecord>,
    rootPid: number | undefined,
    brokerPid: number,
    rootExited: boolean
  ): CommandProcessNode[] {
    for (const [pid, node] of this.tracked) {
      if (processes.get(pid)?.started !== node.started)
        this.tracked.delete(pid);
    }
    if (rootExited && rootPid !== undefined) this.tracked.delete(rootPid);
    if (!rootExited && rootPid !== undefined) {
      const root = processes.get(rootPid);
      if (
        root?.parent === brokerPid &&
        (this.rootStarted === undefined || this.rootStarted === root.started)
      ) {
        this.rootStarted = root.started;
        this.tracked.set(rootPid, {
          pid: rootPid,
          started: root.started,
          depth: 0
        });
        // Execa starts the command in an independent session/group. Only
        // a directly observed root can establish that group's ownership.
        if (root.group === rootPid) this.rootGroup = root.group;
      }
    }

    const children = new Map<number, number[]>();
    for (const [pid, record] of processes) {
      const siblings = children.get(record.parent);
      if (siblings) siblings.push(pid);
      else children.set(record.parent, [pid]);
    }
    const frontier = [...this.tracked.values()];
    const add = (pid: number, depth: number): void => {
      if (
        pid === brokerPid ||
        (rootExited && pid === rootPid) ||
        this.tracked.has(pid)
      )
        return;
      const record = processes.get(pid);
      if (!record) return;
      const node = { pid, started: record.started, depth };
      this.tracked.set(pid, node);
      frontier.push(node);
    };
    const expandChildren = (start: number): void => {
      for (let index = start; index < frontier.length; index++) {
        const parent = frontier[index];
        if (!parent) continue;
        for (const pid of children.get(parent.pid) ?? [])
          add(pid, parent.depth + 1);
      }
    };
    expandChildren(0);
    const rootGroup = this.rootGroup;
    if (rootGroup !== undefined) {
      const anchored = frontier.some(
        (node) => processes.get(node.pid)?.group === rootGroup
      );
      if (anchored) {
        const start = frontier.length;
        for (const [pid, record] of processes) {
          if (record.group === rootGroup) add(pid, 1);
        }
        expandChildren(start);
      } else {
        this.rootGroup = undefined;
      }
    }
    // Use zombies as ancestry anchors but never signal them. A root that
    // the ChildProcess exit event has reaped is not a signal target.
    return frontier.filter((node) => {
      const record = processes.get(node.pid);
      return record && !isZombie(record) && !(rootExited && node.pid === rootPid);
    });
  }
}

/**
One in-flight OS snapshot per command, shared by periodic observation and
cleanup. Snapshot-based tracking still cannot prove ownership of a child
that changes group and is fully orphaned between observations.
*/
export class CommandProcessTree {
  private readonly rootPid: number | undefined;
  private readonly ledger = new CommandProcessLedger();
  private rootExited = false;
  private pending: Promise<CommandProcessNode[]> | undefined;

  constructor(rootPid: number | undefined) {
    this.rootPid = rootPid;
  }

  markRootExited(): void {
    this.rootExited = true;
  }

  observe(): Promise<CommandProcessNode[]> {
    if (!this.pending) {
      // A snapshot already in flight at root exit may still contain its
      // final descendants. Use its original observation phase for discovery
      // but exclude the reaped root from the returned signal targets.
      const rootExitedAtStart = this.rootExited;
      this.pending = readProcesses()
        .then((processes) =>
          this.ledger
            .observe(
              processes,
              this.rootPid,
              process.pid,
              rootExitedAtStart
            )
            .filter((node) => !(this.rootExited && node.pid === this.rootPid))
        )
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  /**
  Freeze observed live processes before killing deepest first. Reinspect
  during cleanup, including descendants reparented after initial discovery.
  Bound host-inspection latency; inability to establish exit fails closed.
  */
  async terminate(): Promise<void> {
    if (this.rootPid === undefined) return;
    const deadline = performance.now() + CLEANUP_BUDGET_MS;
    const inspect = async (): Promise<CommandProcessNode[]> => {
      if (performance.now() >= deadline)
        throw new Error("Command process cleanup exceeded its observation budget.");
      return this.observe();
    };
    const frozen = new Map<number, string>();
    let failure: unknown;
    try {
      for (let round = 0; round < FREEZE_ROUNDS; round++) {
        const fresh = (await inspect()).filter(
          (node) => frozen.get(node.pid) !== node.started
        );
        if (fresh.length === 0) break;
        for (const node of fresh.sort(
          (left, right) => left.depth - right.depth
        )) {
          if (this.rootExited && node.pid === this.rootPid) continue;
          signalProcess(node.pid, "SIGSTOP");
          frozen.set(node.pid, node.started);
        }
        await delay(FREEZE_INTERVAL_MS);
      }
    } catch (error) {
      failure = error;
    }
    for (
      let round = 0;
      round < FREEZE_ROUNDS && performance.now() < deadline;
      round++
    ) {
      try {
        const live = (await inspect()).sort(
          (left, right) => right.depth - left.depth
        );
        if (live.length === 0) break;
        for (const node of live) {
          if (this.rootExited && node.pid === this.rootPid) continue;
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
    if ((await inspect()).length > 0)
      throw new Error("Command descendants did not exit after termination.");
    if (failure) throw failure;
  }
}
