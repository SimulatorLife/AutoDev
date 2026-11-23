import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { summarizeHookDenials } from "@simulatorlife/autodev-data/diagnostics";
import {
  observeOrchestrationCompliance,
  observeTranscriptCompliance
} from "@simulatorlife/autodev-runtime/hooks";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hookModule = fileURLToPath(
  new URL("../../runtime/src/hooks/root-delegation.ts", import.meta.url)
);

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function responseItem(payload: Record<string, unknown>): string {
  return line({ type: "response_item", payload });
}

function eventMessage(payload: Record<string, unknown>): string {
  return line({ type: "event_msg", payload });
}

function assistantMessage(text: string): string {
  return responseItem({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }]
  });
}

function developerBootstrap(): string {
  return responseItem({
    type: "message",
    role: "developer",
    content: [
      {
        type: "input_text",
        text: "# Root orchestrator bootstrap\n\nTask classification: Standard\nComplexity: High-risk/cross-cutting"
      }
    ]
  });
}

function execSpawnCall(callId: string): string {
  return responseItem({
    type: "custom_tool_call",
    name: "exec",
    call_id: callId,
    input:
      'const child = await tools.multi_agent_v1__spawn_agent({ agent_type: "worker", message: "implement fix" });'
  });
}

function toolOutput(callId: string, output: unknown): string {
  return responseItem({
    type: "custom_tool_call_output",
    call_id: callId,
    output
  });
}

function installOrchestrationSkill(home: string): void {
  const skills = join(home, ".agents", "skills");
  if (existsSync(join(skills, "orchestration"))) return;
  mkdirSync(skills, { recursive: true });
  symlinkSync(
    join(repositoryRoot, ".rulesync", "skills", "orchestration"),
    join(skills, "orchestration")
  );
}

function runRootHook(
  home: string,
  payload: Record<string, unknown>
): { stdout: string; logRecords: Array<Record<string, unknown>> } {
  const codexHome = join(home, ".codex");
  const promptRoot = join(codexHome, "hooks", "codex", "prompts");
  mkdirSync(promptRoot, { recursive: true });
  installOrchestrationSkill(home);
  writeFileSync(
    join(promptRoot, "orchestrator.md"),
    "# Root orchestrator bootstrap\n"
  );
  writeFileSync(
    join(promptRoot, "code-search.md"),
    "## Shared codebase navigation\n"
  );
  const stdout = execFileSync(process.execPath, [hookModule], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      AUTODEV_REPO_ROOT: repositoryRoot
    },
    input: JSON.stringify(payload),
    encoding: "utf8"
  });
  const logPath = join(codexHome, "hooks", "hooks.log");
  const logRecords = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    : [];
  return { stdout, logRecords };
}

test("trivial classification without delegation is compliant", () => {
  const transcript =
    developerBootstrap() +
    assistantMessage(
      "Task classification: Trivial/atomic\nApplying the one-line lint fix directly."
    );
  const observation = observeTranscriptCompliance(transcript);
  assert.deepEqual(observation, {
    classification: "trivial",
    classificationSource: "assistant_message",
    spawn: { attempted: 0, succeeded: 0, failed: 0, unresolved: 0 },
    telemetryStatus: "complete",
    telemetryGaps: [],
    status: "compliant"
  });
});

test("standard classification with successful code-mode spawn is compliant", () => {
  const transcript =
    developerBootstrap() +
    assistantMessage("Task classification: Standard\nDelegating to a worker.") +
    execSpawnCall("call-spawn-1") +
    toolOutput("call-spawn-1", 'Script completed\n{"agent_id":"child-1"}');
  const observation = observeTranscriptCompliance(transcript);
  assert.deepEqual(observation, {
    classification: "standard",
    classificationSource: "assistant_message",
    spawn: { attempted: 1, succeeded: 1, failed: 0, unresolved: 0 },
    telemetryStatus: "complete",
    telemetryGaps: [],
    status: "compliant"
  });
});

test("standard classification without observed delegation reports no_delegation_observed", () => {
  const transcript =
    developerBootstrap() +
    assistantMessage("Complexity: Standard\nImplementing directly.");
  const observation = observeTranscriptCompliance(transcript);
  assert.equal(observation.classification, "standard");
  assert.equal(observation.telemetryStatus, "complete");
  assert.equal(observation.status, "no_delegation_observed");
  assert.deepEqual(observation.spawn, {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    unresolved: 0
  });
});

test("high-risk classification observes successful delegation, missing delegation, and re-sizing", () => {
  const withSpawn =
    assistantMessage("Task classification: Trivial/atomic") +
    assistantMessage(
      "Evidence broadened scope. **Task classification:** High-risk/cross-cutting"
    ) +
    responseItem({
      type: "function_call",
      name: "multi_agent_v1__spawn_agent",
      call_id: "fc-1",
      arguments: '{"agent_type":"validator"}'
    }) +
    responseItem({
      type: "function_call_output",
      call_id: "fc-1",
      output: '{"agent_id":"val-1"}'
    });
  assert.deepEqual(observeTranscriptCompliance(withSpawn), {
    classification: "high-risk",
    classificationSource: "assistant_message",
    spawn: { attempted: 1, succeeded: 1, failed: 0, unresolved: 0 },
    telemetryStatus: "complete",
    telemetryGaps: [],
    status: "compliant"
  });

  const structuredWithoutSpawn = eventMessage({
    type: "orchestration_classification",
    classification: "high-risk/cross-cutting"
  });
  assert.deepEqual(observeTranscriptCompliance(structuredWithoutSpawn), {
    classification: "high-risk",
    classificationSource: "structured_event",
    spawn: { attempted: 0, succeeded: 0, failed: 0, unresolved: 0 },
    telemetryStatus: "complete",
    telemetryGaps: [],
    status: "no_delegation_observed"
  });
});

test("absent classification reports unknown and never infers Standard from file counts or missing spawns", () => {
  const multiFileEdits = [1, 2, 3, 4, 5, 6]
    .map(
      (index) =>
        responseItem({
          type: "function_call",
          name: "edit_file",
          call_id: `edit-${index}`,
          arguments: JSON.stringify({ path: `/repo/src/file-${index}.ts` })
        }) +
        responseItem({
          type: "function_call_output",
          call_id: `edit-${index}`,
          output: "ok"
        })
    )
    .join("");
  const transcript =
    developerBootstrap() +
    toolOutput(
      "cat-1",
      "Task classification: Standard\nComplexity: High-risk"
    ) +
    multiFileEdits +
    assistantMessage(
      "Updated 6 files directly using the standard library without spawning children."
    );
  const observation = observeTranscriptCompliance(transcript);
  assert.deepEqual(observation, {
    classification: "unknown",
    classificationSource: "none",
    spawn: { attempted: 0, succeeded: 0, failed: 0, unresolved: 0 },
    telemetryStatus: "complete",
    telemetryGaps: [],
    status: "classification_unknown"
  });
});

test("failed spawn reports delegation_failed while retry recovery reports compliant", () => {
  const failedOnly =
    assistantMessage("Task classification: Standard") +
    execSpawnCall("spawn-fail-1") +
    toolOutput(
      "spawn-fail-1",
      "Script failed\nError: capacity limit reached for active subagents"
    );
  assert.deepEqual(observeTranscriptCompliance(failedOnly), {
    classification: "standard",
    classificationSource: "assistant_message",
    spawn: { attempted: 1, succeeded: 0, failed: 1, unresolved: 0 },
    telemetryStatus: "complete",
    telemetryGaps: [],
    status: "delegation_failed"
  });

  const failedThenRecovered =
    failedOnly +
    execSpawnCall("spawn-ok-2") +
    toolOutput("spawn-ok-2", 'Script completed\n{"agent_id":"child-2"}');
  assert.deepEqual(observeTranscriptCompliance(failedThenRecovered), {
    classification: "standard",
    classificationSource: "assistant_message",
    spawn: { attempted: 2, succeeded: 1, failed: 1, unresolved: 0 },
    telemetryStatus: "complete",
    telemetryGaps: [],
    status: "compliant"
  });

  const claudeFailedSpawn =
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Task classification: Standard" },
          { type: "tool_use", id: "toolu_1", name: "Agent", input: {} }
        ]
      }
    }) +
    line({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: true,
            content: "subagent admission denied"
          }
        ]
      }
    });
  assert.equal(
    observeTranscriptCompliance(claudeFailedSpawn).status,
    "delegation_failed"
  );
});

test("a rejected code-mode spawn result is not counted as successful delegation", () => {
  const transcript =
    assistantMessage("Task classification: Standard") +
    execSpawnCall("rejected-spawn") +
    toolOutput(
      "rejected-spawn",
      'Script completed\n{"spawn_status":"rejected","reason":"agent thread limit reached"}'
    );
  const observation = observeTranscriptCompliance(transcript);
  assert.deepEqual(observation.spawn, {
    attempted: 1,
    succeeded: 0,
    failed: 1,
    unresolved: 0
  });
  assert.equal(observation.status, "delegation_failed");
});

test("incomplete telemetry is reported explicitly without fabricating non-compliance", () => {
  assert.deepEqual(
    observeOrchestrationCompliance({
      session_id: "s-1",
      turn_id: "t-1"
    }),
    {
      classification: "unknown",
      classificationSource: "none",
      spawn: { attempted: 0, succeeded: 0, failed: 0, unresolved: 0 },
      telemetryStatus: "incomplete",
      telemetryGaps: ["missing_transcript_path"],
      status: "incomplete_telemetry"
    }
  );

  assert.deepEqual(
    observeOrchestrationCompliance({
      session_id: "s-1",
      turn_id: "t-1",
      transcript_path: "/nonexistent/path/rollout.jsonl"
    }),
    {
      classification: "unknown",
      classificationSource: "none",
      spawn: { attempted: 0, succeeded: 0, failed: 0, unresolved: 0 },
      telemetryStatus: "incomplete",
      telemetryGaps: ["unreadable_transcript"],
      status: "incomplete_telemetry"
    }
  );

  const malformedTranscript =
    assistantMessage("Complexity: Standard") + "{not-valid-json\n";
  assert.deepEqual(observeTranscriptCompliance(malformedTranscript), {
    classification: "standard",
    classificationSource: "assistant_message",
    spawn: { attempted: 0, succeeded: 0, failed: 0, unresolved: 0 },
    telemetryStatus: "incomplete",
    telemetryGaps: ["malformed_transcript_lines"],
    status: "incomplete_telemetry"
  });

  const unresolvedSpawn =
    assistantMessage("Complexity: Standard") + execSpawnCall("pending-call-1");
  assert.deepEqual(observeTranscriptCompliance(unresolvedSpawn), {
    classification: "standard",
    classificationSource: "assistant_message",
    spawn: { attempted: 1, succeeded: 0, failed: 0, unresolved: 1 },
    telemetryStatus: "incomplete",
    telemetryGaps: ["unresolved_spawn_output"],
    status: "incomplete_telemetry"
  });

  const missingTurnIdentity = observeTranscriptCompliance(
    assistantMessage("Task classification: Trivial"),
    true
  );
  assert.equal(missingTurnIdentity.telemetryStatus, "incomplete");
  assert.deepEqual(missingTurnIdentity.telemetryGaps, [
    "missing_turn_identity"
  ]);
  assert.equal(missingTurnIdentity.status, "incomplete_telemetry");
});

test("compaction resets observed classification and spawn state to the current window", () => {
  const transcript =
    assistantMessage("Task classification: Standard") +
    execSpawnCall("pre-compact-spawn") +
    toolOutput("pre-compact-spawn", "Script completed") +
    line({ type: "compacted", payload: { replacement_history: [] } }) +
    assistantMessage("Continuing after compaction.");
  const observation = observeTranscriptCompliance(transcript);
  assert.deepEqual(observation, {
    classification: "unknown",
    classificationSource: "none",
    spawn: { attempted: 0, succeeded: 0, failed: 0, unresolved: 0 },
    telemetryStatus: "complete",
    telemetryGaps: [],
    status: "classification_unknown"
  });
});

test("root-delegation hook emits non-blocking OrchestrationCompliance telemetry without altering bootstrap or hook denial counts", () => {
  const home = mkdtempSync(join(tmpdir(), "autodev-compliance-hook-"));
  const transcriptPath = join(home, "rollout.jsonl");
  try {
    writeFileSync(
      transcriptPath,
      developerBootstrap() +
        assistantMessage("Task classification: Standard") +
        execSpawnCall("call-1") +
        toolOutput("call-1", 'Script completed\n{"agent_id":"worker-1"}')
    );

    // Follow-up turn where bootstrap is already in the current window:
    // stdout remains empty (bootstrap suppression preserved), while compliance
    // telemetry is recorded to hooks.log.
    const followUp = runRootHook(home, {
      model: "autodev/orchestrator",
      session_id: "compliance-session-1",
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-2",
      transcript_path: transcriptPath
    });
    assert.equal(followUp.stdout, "");

    // Leaf model does not emit OrchestrationCompliance records.
    runRootHook(home, {
      model: "autodev/worker",
      session_id: "compliance-session-1",
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-3",
      transcript_path: transcriptPath
    });

    const complianceRecords = followUp.logRecords.filter(
      (record) => record.event === "OrchestrationCompliance"
    );
    assert.equal(complianceRecords.length, 1);
    assert.equal(complianceRecords[0]?.hook, "root-delegation");
    assert.equal(complianceRecords[0]?.decision, "observe");
    assert.equal(complianceRecords[0]?.classification, "standard");
    assert.equal(complianceRecords[0]?.status, "compliant");
    assert.equal(complianceRecords[0]?.telemetryStatus, "complete");
    assert.deepEqual(complianceRecords[0]?.spawn, {
      attempted: 1,
      succeeded: 1,
      failed: 0,
      unresolved: 0
    });

    const summary = summarizeHookDenials(join(home, ".codex"));
    // 2 UserPromptSubmit invocations (root + leaf); OrchestrationCompliance
    // must not inflate userPromptSubmits or preToolUseDenials.
    assert.equal(summary.userPromptSubmits, 2);
    assert.equal(summary.preToolUseDenials, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
