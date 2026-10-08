import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { WorkspaceEntry } from "@simulatorlife/autodev-core";

import { ConfigRepository } from "../config/config-repository.ts";

const execFileAsync = promisify(execFile);

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

/** Read the validated Data-owned workspace catalog for OpenLIT projection. */
export function loadRulesyncWorkspaces(
  repositoryRoot: string
): readonly WorkspaceEntry[] {
  const catalog = new ConfigRepository(repositoryRoot).readWorkspaceCatalog();
  if (catalog.status !== "valid") {
    throw new Error(`Workspace catalog is ${catalog.status}.`);
  }
  return catalog.workspaces;
}

export function buildPrismaSyncScript(workspaceIds: readonly string[]): string {
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
          isCurrent: true
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

  const workspaceIds = ${JSON.stringify(workspaceIds)};
  console.log(
    JSON.stringify({
      organisation: org.name,
      project: autoDevProject.name,
      environment: "production",
      collapsedProjects,
      workspaces: workspaceIds
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
    options.repositoryRoot || path.resolve(import.meta.dirname, "../../..");
  const containerName = options.containerName || "openlit";

  const workspaces = loadRulesyncWorkspaces(repositoryRoot);
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const script = buildPrismaSyncScript(workspaceIds);

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
    totalWorkspaces: workspaces.length,
    workspaces: parsed.workspaces ?? workspaceIds,
    collapsedProjects: parsed.collapsedProjects ?? []
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncRulesyncWorkspaces()
    .then((result) => {
      process.stdout.write(
        "Synchronized AutoDev Console project architecture for AutoDev:"
      );
      process.stdout.write(`  Organisation:      ${result.organisation}\n`);
      process.stdout.write(`  Project:           ${result.project}\n`);
      process.stdout.write(`  Environment:       ${result.environment}\n`);
      process.stdout.write(`  Total Workspaces:  ${result.totalWorkspaces}\n`);
      if (result.collapsedProjects.length > 0) {
        process.stdout.write(
          `  Collapsed Silos:   ${result.collapsedProjects.join(", ")}`
        );
      }
      process.exitCode = 0;
      return result;
    })
    .catch((error) => {
      process.stderr.write(
        `Rulesync workspace synchronization failed: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return null;
    });
}
