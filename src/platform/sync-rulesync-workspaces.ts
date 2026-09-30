import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeErrorLine, writeLine } from "../shared/output.ts";

const execFileAsync = promisify(execFile);

export interface RulesyncWorkspaceData {
  readonly name: string;
  readonly baseBranch: string;
  readonly weight: number;
  readonly slug: string;
}

export interface SyncWorkspacesOptions {
  readonly repositoryRoot?: string;
  readonly containerName?: string;
}

export interface SyncWorkspacesResult {
  readonly organisation: string;
  readonly project: string;
  readonly environment: string;
  readonly totalWorkspaces: number;
  readonly workspaces: readonly string[];
  readonly collapsedProjects: readonly string[];
}

interface WeightsRepositoriesJson {
  readonly repositories?: Array<{
    readonly name?: string;
    readonly baseBranch?: string;
    readonly weight?: number;
  }>;
}

const SLUG_CLEAN_REGEX = /[^a-z0-9]+/gu;
const SLUG_TRIM_REGEX = /^-|-$/gu;

/**
 * Generate a clean URL slug from a workspace/repository name.
 */
export function slugifyWorkspace(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(SLUG_CLEAN_REGEX, "-")
    .replaceAll(SLUG_TRIM_REGEX, "");
}

/**
 * Load all canonical workspaces from .github/workflows/weights.json.
 */
export function loadRulesyncWorkspaces(
  repositoryRoot: string
): Map<string, RulesyncWorkspaceData> {
  const weightsPath = path.join(
    repositoryRoot,
    ".github",
    "workflows",
    "weights.json"
  );
  if (!existsSync(weightsPath)) {
    throw new Error(`weights.json not found: ${weightsPath}`);
  }
  const raw = JSON.parse(
    readFileSync(weightsPath, "utf8")
  ) as WeightsRepositoriesJson;
  const map = new Map<string, RulesyncWorkspaceData>();
  for (const repo of raw.repositories ?? []) {
    if (!repo.name) continue;
    map.set(repo.name, {
      name: repo.name,
      baseBranch: repo.baseBranch ?? "main",
      weight: repo.weight ?? 0,
      slug: slugifyWorkspace(repo.name)
    });
  }
  return map;
}

function buildPrismaSyncScript(
  repoList: readonly RulesyncWorkspaceData[]
): string {
  return `
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function run() {
  let org = await prisma.organisation.findFirst();
  if (!org) {
    const user = await prisma.user.findFirst();
    org = await prisma.organisation.create({
      data: {
        name: "SimulatorLife",
        slug: "simulatorlife",
        createdByUserId: user ? user.id : "system"
      }
    });
  } else if (org.name !== "SimulatorLife" || org.slug !== "simulatorlife") {
    org = await prisma.organisation.update({
      where: { id: org.id },
      data: { name: "SimulatorLife", slug: "simulatorlife" }
    });
  }

  const user = await prisma.user.findFirst();
  const orgUser = user
    ? await prisma.organisationUser.findFirst({
        where: { userId: user.id, organisationId: org.id }
      })
    : null;

  // Locate the canonical AutoDev project
  let autoDevProject =
    (await prisma.project.findFirst({
      where: { organisationId: org.id, isDefault: true }
    })) ||
    (await prisma.project.findFirst({
      where: { organisationId: org.id, slug: "autodev" }
    })) ||
    (await prisma.project.findFirst({
      where: { organisationId: org.id }
    }));

  if (autoDevProject) {
    if (
      autoDevProject.name !== "AutoDev" ||
      autoDevProject.slug !== "autodev" ||
      !autoDevProject.isDefault
    ) {
      autoDevProject = await prisma.project.update({
        where: { id: autoDevProject.id },
        data: { name: "AutoDev", slug: "autodev", isDefault: true }
      });
    }
  } else {
    autoDevProject = await prisma.project.create({
      data: {
        organisationId: org.id,
        name: "AutoDev",
        slug: "autodev",
        isDefault: true
      }
    });
  }

  // Collapse / prune obsolete per-workspace projects to eliminate isolation silos
  const obsoleteProjects = await prisma.project.findMany({
    where: {
      organisationId: org.id,
      id: { not: autoDevProject.id }
    }
  });
  const collapsedProjects = obsoleteProjects.map((p) => p.name);
  if (obsoleteProjects.length > 0) {
    await prisma.project.deleteMany({
      where: {
        id: { in: obsoleteProjects.map((p) => p.id) }
      }
    });
  }

  // Ensure organisationUser points to canonical project
  if (orgUser) {
    await prisma.organisationUser.update({
      where: { id: orgUser.id },
      data: { currentProjectId: autoDevProject.id, isCurrent: true }
    });
  }

  // Ensure projectUser exists
  if (user && orgUser) {
    const pu = await prisma.projectUser.findFirst({
      where: { projectId: autoDevProject.id, userId: user.id }
    });
    if (!pu) {
      await prisma.projectUser.create({
        data: {
          projectId: autoDevProject.id,
          userId: user.id,
          organisationUserId: orgUser.id
        }
      });
    }
  }

  // Ensure projectEnvironment 'production'
  const pe = await prisma.projectEnvironment.findFirst({
    where: { projectId: autoDevProject.id, name: "production" }
  });
  if (!pe) {
    await prisma.projectEnvironment.create({
      data: {
        projectId: autoDevProject.id,
        name: "production"
      }
    });
  }

  // Ensure databaseConfig
  let db = await prisma.databaseConfig.findFirst({
    where: { projectId: autoDevProject.id }
  });
  if (!db) {
    const defaultDb = await prisma.databaseConfig.findFirst();
    db = await prisma.databaseConfig.create({
      data: {
        name: "Default DB",
        environment: "production",
        username: defaultDb ? defaultDb.username : "default",
        password: defaultDb
          ? defaultDb.password
          : "50713f4c7f6e8a62551d3ae64ac800e8d0a0b0cb1ec7a99cbd43e04979840a89",
        host: defaultDb ? defaultDb.host : "clickhouse",
        port: defaultDb ? defaultDb.port : "8123",
        database: defaultDb ? defaultDb.database : "openlit",
        createdByUserId: user ? user.id : "",
        projectId: autoDevProject.id
      }
    });
  }

  // Ensure databaseConfigUser
  if (user && db) {
    const dbu = await prisma.databaseConfigUser.findFirst({
      where: { userId: user.id, databaseConfigId: db.id }
    });
    if (!dbu) {
      await prisma.databaseConfigUser.create({
        data: {
          userId: user.id,
          databaseConfigId: db.id,
          isCurrent: true,
          canEdit: true,
          canShare: true,
          canDelete: true
        }
      });
    }
  }

  // Ensure telemetry bindings
  if (db) {
    for (const signal of ["traces", "logs", "metrics", "intelligence"]) {
      const binding = await prisma.telemetrySourceBinding.findUnique({
        where: {
          projectId_signal_environment: {
            projectId: autoDevProject.id,
            signal,
            environment: "production"
          }
        }
      });
      if (!binding) {
        await prisma.telemetrySourceBinding.create({
          data: {
            projectId: autoDevProject.id,
            signal,
            environment: "production",
            databaseConfigId: db.id
          }
        });
      }
    }

    // Ensure API Key for local health/telemetry probes
    if (user) {
      const key = await prisma.aPIKeys.findFirst({
        where: { databaseConfigId: db.id, isDeleted: false }
      });
      if (!key) {
        await prisma.aPIKeys.create({
          data: {
            name: "AutoDev",
            apiKey: "openlit-test-api-key-1234567890",
            databaseConfigId: db.id,
            createdByUserId: user.id
          }
        });
      }
    }
  }

  const repos = ${JSON.stringify(repoList)};
  console.log(
    JSON.stringify({
      organisation: org.name,
      project: autoDevProject.name,
      environment: "production",
      collapsedProjects,
      workspaces: repos.map((r) => r.name)
    })
  );
}

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
`;
}

/**
 * Synchronize the canonical SimulatorLife/AutoDev OpenLIT project and rulesync workspace architecture.
 */
export async function syncRulesyncWorkspaces(
  options: SyncWorkspacesOptions = {}
): Promise<SyncWorkspacesResult> {
  const repositoryRoot =
    options.repositoryRoot || fileURLToPath(new URL("../..", import.meta.url));
  const containerName = options.containerName || "openlit";

  const catalog = loadRulesyncWorkspaces(repositoryRoot);
  const repoList = [...catalog.values()];
  const script = buildPrismaSyncScript(repoList);

  const { stdout } = await execFileAsync(
    "docker",
    ["exec", containerName, "node", "-e", script],
    { encoding: "utf8" }
  );

  const parsed = JSON.parse(stdout.trim()) as {
    organisation?: string;
    project?: string;
    environment?: string;
    collapsedProjects?: string[];
    workspaces?: string[];
  };

  return {
    organisation: parsed.organisation ?? "SimulatorLife",
    project: parsed.project ?? "AutoDev",
    environment: parsed.environment ?? "production",
    totalWorkspaces: catalog.size,
    workspaces: parsed.workspaces ?? [...catalog.keys()],
    collapsedProjects: parsed.collapsedProjects ?? []
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncRulesyncWorkspaces()
    .then((result) => {
      writeLine("Synchronized OpenLIT project architecture for AutoDev:");
      writeLine(`  Organisation:      ${result.organisation}`);
      writeLine(`  Project:           ${result.project}`);
      writeLine(`  Environment:       ${result.environment}`);
      writeLine(`  Total Workspaces:  ${result.totalWorkspaces}`);
      if (result.collapsedProjects.length > 0) {
        writeLine(
          `  Collapsed Silos:   ${result.collapsedProjects.join(", ")}`
        );
      }
      process.exitCode = 0;
      return result;
    })
    .catch((error) => {
      writeErrorLine(
        `Rulesync workspace synchronization failed: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return null;
    });
}
