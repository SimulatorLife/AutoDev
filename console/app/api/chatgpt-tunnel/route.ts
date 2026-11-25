import { CHATGPT_TUNNEL_CONTROL_PATH, type ChatgptTunnelMutation } from "@simulatorlife/autodev-core";
import type { NextRequest, NextResponse } from "next/server.js";
import { postControlApi, readControlApiConfig } from "../../../src/lib/server/control-api.ts";
import { isSameOriginMutation, readStrictUrlEncodedFormBody } from "../../../src/lib/server/form-mutation.ts";
import { redirectTo } from "../../../src/lib/server/mutation-rejection.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: NextRequest): Promise<NextResponse> {
  const redirect = (result: string) => redirectTo("/mcps?tunnel=" + result);
  if (!isSameOriginMutation(request)) return redirect("failed");
  const form = await readStrictUrlEncodedFormBody(request, 32_768);
  if (!form || form.getAll("action").length !== 1 || form.getAll("expectedRevision").length !== 1) return redirect("failed");
  const action = form.get("action");
  const expectedRevision = form.get("expectedRevision") ?? "";
  if (!/^[a-f0-9]{64}$/u.test(expectedRevision)) return redirect("failed");
  let mutation: ChatgptTunnelMutation;
  if (action === "enable" || action === "disable" || action === "forget") {
    if (form.size !== 2) return redirect("failed");
    mutation = { action, expectedRevision };
  } else if (action === "configure") {
    const workspace = form.get("workspace");
    if (!workspace || form.getAll("workspace").length !== 1) return redirect("failed");
    const roleValues = form.getAll("role");
    if (roleValues.length > 1) return redirect("failed");
    const role = roleValues[0]?.trim();
    if (role !== undefined && (!role || !/^[a-z0-9_-]+$/u.test(role))) return redirect("failed");
    const grants = new Map<string, string[]>();
    for (const entry of form.getAll("grant")) {
      const parts = entry.split(":");
      const [server, tool] = parts;
      if (parts.length !== 2 || !server || !tool || !/^[a-zA-Z0-9_-]+$/u.test(server) || !/^[a-zA-Z0-9_.-]+$/u.test(tool)) return redirect("failed");
      grants.set(server, [...(grants.get(server) ?? []), tool]);
    }
    if (form.size !== 3 + roleValues.length + form.getAll("grant").length) return redirect("failed");
    mutation = { action, expectedRevision, workspace, ...(role ? { role } : {}), grants: Object.fromEntries(grants) };
  } else if (action === "rotate") {
    const runtimeKey = form.get("runtimeKey");
    if (!runtimeKey || form.size !== 3 || form.getAll("runtimeKey").length !== 1) return redirect("failed");
    mutation = { action, expectedRevision, runtimeKey };
  } else return redirect("failed");
  const config = readControlApiConfig();
  if (!config) return redirect("failed");
  const result = await postControlApi(CHATGPT_TUNNEL_CONTROL_PATH, mutation, config, { timeoutMs: 250_000 });
  return redirect(result.kind === "ok" ? "ok" : "failed");
}
