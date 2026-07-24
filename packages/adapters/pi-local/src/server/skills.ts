import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildPiSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "pi_local",
    availableEntries,
    desiredSkills,
    configuredDetail: "Will be mounted into a run-scoped Pi skills directory on the next run.",
  });
}

export async function listPiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildPiSkillSnapshot(ctx.config);
}

export async function syncPiSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Ephemeral Pi skills are mounted during execution. This hook only reports
  // the desired selection already persisted in the adapter config.
  return buildPiSkillSnapshot(ctx.config);
}

export function resolvePiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
