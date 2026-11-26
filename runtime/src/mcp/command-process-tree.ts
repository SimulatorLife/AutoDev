/**
Terminate a confined command together with everything it started.

A process group is not the whole story. The command runs in its own group, so
a group signal reaches the ordinary tree -- but a descendant that detached
into its own session left that group behind: the group signal does not reach
it, and macOS reparents it to the system, so its parent relationship is gone
as well.

A detached descendant is still reachable while its parent is alive. This
module walks the parent-child relationship from the command's own process, so
a descendant that changed its group or its session is still found, and it
terminates the tree from the deepest descendant upwards.

The tree is frozen before it is terminated. A stopped process cannot create
another descendant, so the walk converges on the real tree instead of chasing
a command that keeps forking, and no descendant is reparented away between
the walk and the signal that reaches it.
*/
import { execFileSync } from "node:child_process";

const PROCESS_LIST = "/bin/ps";
/**
How many times the tree is walked while it is frozen. A descendant that was
forked just before its parent was stopped is found in the next round, and a
parent that is already stopped cannot fork again.
*/
const FREEZE_ROUNDS = 8;
/**
The pause between two freeze rounds, so a stopped process has settled before
the next walk.
*/
const FREEZE_INTERVAL_MS = 25;
const PROCESS_LINE = /\s+/u;

export interface CommandProcessNode {
  readonly pid: number;
  /**
  How far the process is from the command's own process. A descendant is
  always deeper than the process that started it.
  */
  readonly depth: number;
  /**
  The process group the process belongs to. A descendant that detached into
  its own session is in a group of its own.
  */
  readonly group: number;
}

interface ProcessRecord {
  readonly parent: number;
  readonly group: number;
}

/**
Every process the operating system reports, with its parent and its group.

The list is the operating system's own view, not the command's: a command
cannot hide a descendant by reporting it differently.
*/
function readProcesses(): Map<number, ProcessRecord> {
  const processes = new Map<number, ProcessRecord>();
  let output: string;
  try {
    output = execFileSync(
      PROCESS_LIST,
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="],
      { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch {
    return processes;
  }
  for (const line of output.split("\n")) {
    const [pidText, parentText, groupText] = line.trim().split(PROCESS_LINE, 3);
    if (!pidText || !parentText || !groupText) continue;
    const pid = Number(pidText);
    const parent = Number(parentText);
    const group = Number(groupText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    processes.set(pid, {
      parent,
      group: Number.isSafeInteger(group) ? group : parent
    });
  }
  return processes;
}

/**
Every descendant of a process, as the operating system reports them.

A descendant that detached into its own session is included: it left the
process group, not the parent-child relationship, and this walk follows the
parent-child relationship.
*/
export function collectCommandDescendants(
  rootPid: number | undefined
): CommandProcessNode[] {
  if (rootPid === undefined) return [];
  const processes = readProcesses();
  const children = new Map<number, number[]>();
  for (const [pid, record] of processes) {
    const siblings = children.get(record.parent);
    if (siblings) siblings.push(pid);
    else children.set(record.parent, [pid]);
  }
  const nodes: CommandProcessNode[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: number[] = [];
    for (const parent of frontier) {
      const descendants = children.get(parent) ?? [];
      for (const child of descendants) {
        if (seen.has(child)) continue;
        seen.add(child);
        nodes.push({
          pid: child,
          depth,
          group: processes.get(child)?.group ?? child
        });
        next.push(child);
      }
    }
    frontier = next;
  }
  return nodes;
}

/**
The descendants that left the command's own process group.

A descendant that detached into its own session is in a group of its own, and
a group signal never reaches it. These are the descendants that have to be
terminated by their own pid.
*/
export function findDetachedCommandDescendants(
  rootPid: number | undefined
): CommandProcessNode[] {
  if (rootPid === undefined) return [];
  const root = readProcesses().get(rootPid)?.group ?? rootPid;
  return collectCommandDescendants(rootPid).filter(
    (node) => node.group !== root
  );
}

/**
Terminate the descendants that left the command's own process group.

A descendant that detached into its own session is in a group of its own, and
a group signal never reaches it. These are the descendants that have to be
terminated by their own pid, and they are terminated as soon as they are
seen: macOS reparents an orphan to the system, so a descendant whose parent
has already exited can no longer be identified afterwards.
*/
export function terminateDetachedCommandDescendants(
  rootPid: number | undefined
): number[] {
  if (rootPid === undefined) return [];
  const terminated: number[] = [];
  for (const node of findDetachedCommandDescendants(rootPid)) {
    signalProcess(node.pid, "SIGKILL");
    terminated.push(node.pid);
  }
  return terminated;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process is already gone, or it may not be signalled. Either way it
    // is not something this module can act on.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
Stop the descendants of a process, so the tree cannot grow while it is torn
down.

A stopped process cannot create another descendant, so the walk converges on
the real tree instead of chasing a command that keeps forking.
*/
async function freezeCommandTree(
  rootPid: number,
  frozen: Set<number>,
  round: number
): Promise<void> {
  if (round >= FREEZE_ROUNDS) return;
  const fresh = collectCommandDescendants(rootPid).filter(
    (node) => !frozen.has(node.pid)
  );
  if (fresh.length === 0) return;
  for (const node of fresh) signalProcess(node.pid, "SIGSTOP");
  for (const node of fresh) frozen.add(node.pid);
  await delay(FREEZE_INTERVAL_MS);
  await freezeCommandTree(rootPid, frozen, round + 1);
}

/**
Terminate a command's process tree, including a descendant that detached into
its own session.

The command is stopped rather than asked to finish: a cancelled or expired
command is terminated, not given the chance to leave more work behind. The
tree is frozen first, so it cannot grow while it is torn down, and the
deepest descendant is killed first, so no live descendant is reparented away
before it is reached. The command's own process is killed last, for the same
reason.
*/
export async function terminateCommandProcessTree(
  rootPid: number | undefined
): Promise<void> {
  // A process that never started has no tree to terminate.
  if (rootPid === undefined) return;
  // The command itself is stopped first, so it cannot create one more
  // descendant between the last walk and the signal that reaches it.
  signalProcess(rootPid, "SIGSTOP");
  await freezeCommandTree(rootPid, new Set<number>(), 0);
  const descendants = collectCommandDescendants(rootPid).sort(
    (left, right) => right.depth - left.depth
  );
  for (const node of descendants) signalProcess(node.pid, "SIGKILL");
  signalProcess(rootPid, "SIGKILL");
}
