import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const MANAGED_PROFILE_MARKER = ".paperclip-managed.json";

export type PreparedManagedPiProfile = {
  agentDir: string;
  sessionsDir: string;
  sharedAgentDir: string;
  authLinked: boolean;
  notes: string[];
};

function assertPathSegment(label: string, value: string): void {
  if (!PATH_SEGMENT_RE.test(value)) {
    throw new Error(`Invalid ${label} '${value}' for managed Pi profile.`);
  }
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function ensureManagedSettings(settingsPath: string): Promise<void> {
  const existing = await fs.readFile(settingsPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  let settings: Record<string, unknown> = {};
  if (existing !== null) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("settings.json root must be an object");
      }
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Managed Pi profile settings at "${settingsPath}" are invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  settings.defaultProjectTrust = "never";
  const tempPath = `${settingsPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, settingsPath);
    await fs.chmod(settingsPath, 0o600);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function symlinkPointsTo(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;
  const linked = await fs.readlink(target).catch(() => null);
  return linked !== null && path.resolve(path.dirname(target), linked) === path.resolve(source);
}

async function ensureSharedAuthSymlink(target: string, source: string): Promise<boolean> {
  if (!(await pathExists(source))) return false;

  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await fs.symlink(source, target);
    return true;
  }
  if (!existing.isSymbolicLink()) {
    const replaceableEmptyAuth = existing.isFile() && await fs.readFile(target, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
      })
      .catch(() => false);
    if (!replaceableEmptyAuth) {
      throw new Error(
        `Managed Pi profile already contains a regular auth.json at "${target}"; refusing to replace dedicated credentials with the shared-auth symlink.`,
      );
    }
    await fs.unlink(target);
    await fs.symlink(source, target);
    return true;
  }
  if (await symlinkPointsTo(target, source)) return true;

  await fs.unlink(target);
  await fs.symlink(source, target);
  return true;
}

export function resolveSharedPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const effectiveEnv = env === process.env ? env : { ...process.env, ...env };
  const explicit = nonEmpty(effectiveEnv.PI_CODING_AGENT_DIR);
  if (explicit) return path.resolve(explicit);
  const home = nonEmpty(effectiveEnv.HOME) ?? os.homedir();
  return path.resolve(home, ".pi", "agent");
}

export function resolveManagedPiAgentDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  assertPathSegment("companyId", companyId);
  assertPathSegment("agentId", agentId);
  const effectiveEnv = { ...process.env, ...env };
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({ env: effectiveEnv });
  return path.resolve(
    instanceRoot,
    "companies",
    companyId,
    "agents",
    agentId,
    "pi-agent",
  );
}

/**
 * Creates the persistent, Paperclip-owned Pi profile for one agent.
 *
 * The profile intentionally starts from an empty allowlist rather than copying
 * the operator's settings, extensions, MCP config, packages, or skills. The
 * only shared entry is auth.json, and only when the source file already exists.
 * This shared-auth symlink is a compatibility mode: Pi locks the symlink path
 * rather than its real target, so concurrent OAuth refreshes from different
 * agent profiles are not serialized by Pi's own lock.
 */
export async function prepareManagedPiProfile(input: {
  env: NodeJS.ProcessEnv;
  companyId: string;
  agentId: string;
}): Promise<PreparedManagedPiProfile> {
  const agentDir = resolveManagedPiAgentDir(input.env, input.companyId, input.agentId);
  const sessionsDir = path.join(agentDir, "sessions", "paperclip");
  const sharedAgentDir = resolveSharedPiAgentDir(input.env);

  if (path.resolve(sharedAgentDir) === path.resolve(agentDir)) {
    throw new Error("Managed Pi profile cannot use itself as the shared Pi profile source.");
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.chmod(agentDir, 0o700);
  await fs.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(agentDir, "sessions"), 0o700);
  await fs.chmod(sessionsDir, 0o700);

  await ensureManagedSettings(path.join(agentDir, "settings.json"));

  const markerPath = path.join(agentDir, MANAGED_PROFILE_MARKER);
  await fs.writeFile(
    markerPath,
    `${JSON.stringify({
      version: 1,
      adapterType: "pi_local",
      companyId: input.companyId,
      agentId: input.agentId,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(markerPath, 0o600);

  const sharedAuthPath = path.join(sharedAgentDir, "auth.json");
  const authLinked = await ensureSharedAuthSymlink(
    path.join(agentDir, "auth.json"),
    sharedAuthPath,
  );

  return {
    agentDir,
    sessionsDir,
    sharedAgentDir,
    authLinked,
    notes: [
      `Using Paperclip-managed Pi profile "${agentDir}".`,
      authLinked
        ? `Sharing Pi credentials from "${sharedAuthPath}" through a compatibility symlink.`
        : `Shared Pi auth file "${sharedAuthPath}" does not exist; the managed profile will rely on environment credentials or its own future auth.json.`,
    ],
  };
}
