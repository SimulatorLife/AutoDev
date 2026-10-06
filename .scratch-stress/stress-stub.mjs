import http from "node:http";
import { createHash } from "node:crypto";

// Adversarial-but-legal payloads, to check the Console's wrapping and
// containment rather than its data handling.
const LONG_ID = "a".repeat(88);                      // one unbreakable token
const UNICODE_ID = "café-naïve-日本語-\u{1F50D}-ok"; // multibyte + astral
const RTL_ID = "\u0645\u0648\u0633\u064a\u0639";              // RTL script
const prompt = [
  "UNBREAKED: " + "x".repeat(300),
  "PATH: /Users/" + "verylongdirectoryname/".repeat(8) + "file.md",
  "JSON: {\"key\":\"" + "v".repeat(160) + "\"}",
  "MIXED: " + "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 " + "\u65e5\u672c\u8a9e\u3067\u306e\u30c6\u30ad\u30b9\u30c8",
  "EMOJI: \u{1F680}\u{1F9EA}\u{1F4E1}\u{1F6E0}\uFE0F",
  "COMBINING: e\u0301a\u0300o\u0308u\u0327",
  "TABS:\tcol1\tcol2\tcol3",
  "TIGHT:WWWWWWWWWWWWWWWWWWWW i",
  "".padEnd(90, "-") + " RULE BREAKER",
  "".padEnd(30, "=") + " END"
].join("\n");

const agent = (id) => ({
  schema: "autodev-control-agent-detail-v2",
  id, role: id,
  kind: "leaf",
  readOnly: false,
  configured: true,
  valid: null,
  status: "configured",
  convergence: "not-observed",
  primaryModel: "provider/" + "m".repeat(120) + "-latest",
  allowedProviders: ["codex"],
  mcps: ["m".repeat(70)],
  skills: ["s".repeat(70)],
  promptPath: "agents/prompts/roles/" + "p".repeat(80) + ".md",
  systemPrompt: prompt,
  reconciliation: {
    status: {
      convergence: "not-observed",
      desiredGeneration: createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 12),
      observedGeneration: null,
      lastApplyAt: null,
      lastObservationAt: null,
      lastError: null,
      explanation: "No runtime observation has been recorded for this agent yet."
    },
    history: []
  }
});

const ids = [LONG_ID, UNICODE_ID, RTL_ID];

http.createServer((req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  const m = /^\/control\/agents\/([^/]+)$/.exec(req.url ?? "");
  if (m) {
    res.end(JSON.stringify(agent(decodeURIComponent(m[1]))));
    return;
  }
  if (req.url === "/control/agents") {
    res.end(JSON.stringify({
      schema: "autodev-control-agents-v1",
      source: ".codex/agents",
      totalAgents: ids.length,
      agents: ids.map((id) => ({
        id, role: id, kind: "leaf", readOnly: false, configured: true, valid: null,
        status: "configured", convergence: "not-observed",
        primaryModel: "provider/" + "m".repeat(120),
        allowedProviders: ["codex"], mcps: [], skills: [], hasPrompt: true
      }))
    }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: "autodev_control_api_not_found" } }));
}).listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log("stress stub up"));
