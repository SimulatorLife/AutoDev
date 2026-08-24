#!/usr/bin/env bash

set -euo pipefail

input="$(cat)"

printf '%s' "$input" | node -e '
  const fs = require("node:fs");

  const input = JSON.parse(fs.readFileSync(0, "utf8"));

  const entry = {
    time: new Date().toISOString(),
    event: input.hook_event_name,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    model: input.model,
    session: input.session_id,
    turn: input.turn_id
  };

  fs.appendFileSync(
    `${process.env.HOME}/.codex/hooks/subagents.log`,
    `${JSON.stringify(entry)}\n`
  );

  process.stdout.write(JSON.stringify({
    systemMessage:
      `Subagent started: ${input.agent_type} → ${input.model}`
  }));
'