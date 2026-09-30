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
  readonly totalWorkspaces: number;
  readonly inserted: readonly string[];
  readonly unchanged: readonly string[];
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
  const org = await prisma.organisation.findFirst();
  if (!org) throw new Error("No organisation found in OpenLIT");

  const user = await prisma.user.findFirst();
  const orgUser = user ? await prisma.organisationUser.findFirst({ where: { userId: user.id, organisationId: org.id } }) : null;
  const defaultDb =
    (await prisma.databaseConfig.findFirst({ where: { projectId: "cmuog7ig20004fipedpz3n1og" } })) ||
    (await prisma.databaseConfig.findFirst());
  const existing = await prisma.project.findMany({ where: { organisationId: org.id } });
  const existingByName = new Map(existing.map(p => [p.name, p]));

  const inserted = [];
  const unchanged = [];
  const repos = ${JSON.stringify(repoList)};

  for (const repo of repos) {
    let project = existingByName.get(repo.name);
    if (!project) {
      const baseSlug = repo.slug || "project";
      const suffix = Math.random().toString(36).substring(2, 8);
      project = await prisma.project.create({
        data: {
          organisationId: org.id,
          name: repo.name,
          slug: baseSlug + "-" + suffix
        }
      });
      inserted.push(repo.name);
    } else {
      unchanged.push(repo.name);
    }

    if (user && orgUser) {
      const pu = await prisma.projectUser.findFirst({ where: { projectId: project.id, userId: user.id } });
      if (!pu) {
        await prisma.projectUser.create({
          data: {
            projectId: project.id,
            userId: user.id,
            organisationUserId: orgUser.id,
          }
        });
      }
    }

    const pe = await prisma.projectEnvironment.findFirst({ where: { projectId: project.id, name: "production" } });
    if (!pe) {
      await prisma.projectEnvironment.create({
        data: {
          projectId: project.id,
          name: "production",
        }
      });
    }

    if (defaultDb) {
      let db = await prisma.databaseConfig.findFirst({ where: { projectId: project.id } });
      if (!db) {
        db = await prisma.databaseConfig.create({
          data: {
            name: defaultDb.name,
            environment: defaultDb.environment,
            username: defaultDb.username,
            password: defaultDb.password,
            host: defaultDb.host,
            port: defaultDb.port,
            database: defaultDb.database,
            createdByUserId: defaultDb.createdByUserId,
            projectId: project.id
          }
        });
      }

      if (user) {
        const dbu = await prisma.databaseConfigUser.findFirst({
          where: {
            userId: user.id,
            databaseConfigId: db.id,
          }
        });
        if (!dbu) {
          await prisma.databaseConfigUser.create({
            data: {
              userId: user.id,
              databaseConfigId: db.id,
              isCurrent: true,
              canEdit: true,
              canShare: true,
              canDelete: true,
            }
          });
        }
      }

      for (const signal of ["traces", "logs", "metrics", "intelligence"]) {
        const binding = await prisma.telemetrySourceBinding.findUnique({
          where: {
            projectId_signal_environment: {
              projectId: project.id,
              signal,
              environment: "production",
            }
          }
        });
        if (!binding) {
          await prisma.telemetrySourceBinding.create({
            data: {
              projectId: project.id,
              signal,
              environment: "production",
              databaseConfigId: db.id,
            }
          });
        }
      }
    }
  }

  console.log(JSON.stringify({ inserted, unchanged }));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
`;
}

/**
 * Synchronize rulesync workspaces into OpenLIT's projects and databaseconfig tables.
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
    inserted?: string[];
    unchanged?: string[];
  };

  return {
    totalWorkspaces: catalog.size,
    inserted: parsed.inserted ?? [],
    unchanged: parsed.unchanged ?? []
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncRulesyncWorkspaces()
    .then((result) => {
      writeLine(
        `Synchronized ${result.totalWorkspaces} rulesync workspaces to OpenLIT Projects:`
      );
      writeLine(`  Inserted:  ${result.inserted.length}`);
      writeLine(`  Unchanged: ${result.unchanged.length}`);
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
