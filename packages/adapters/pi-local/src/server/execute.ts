import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetFile,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { isPiUnknownSessionError, parsePiJsonl } from "./parse.js";
import { createPiStdoutCompactor, resolvePiStdoutLogMode } from "./stdout-compaction.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";
import { prepareManagedPiProfile } from "./pi-profile.js";
import { preparePiRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PAPERCLIP_SESSIONS_DIR = path.join(os.homedir(), ".pi", "paperclips");

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

type PiSkillsDir = {
  rootDir: string;
  skillsDir: string;
};

async function buildPiSkillsDir(selectedEntries: PaperclipSkillEntry[]): Promise<PiSkillsDir> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-"));
  const skillsDir = path.join(rootDir, "skills");

  try {
    await fs.mkdir(skillsDir, { recursive: true });
    for (const entry of selectedEntries) {
      await fs.symlink(entry.source, path.join(skillsDir, entry.runtimeName));
    }
    return { rootDir, skillsDir };
  } catch (error) {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

async function ensureSessionsDir(sessionsDir: string): Promise<string> {
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

function buildSessionPath(sessionsDir: string, agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(sessionsDir, `${safeTimestamp}-${agentId}.jsonl`);
}

function buildRemoteSessionPath(runtimeRootDir: string, agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.posix.join(runtimeRootDir, "sessions", `${safeTimestamp}-${agentId}.jsonl`);
}

function normalizeExecutionCwd(candidate: string, remote: boolean): string {
  return remote ? path.posix.normalize(candidate) : path.resolve(candidate);
}

function executionCwdsMatch(saved: string, current: string, remote: boolean): boolean {
  return normalizeExecutionCwd(saved, remote) === normalizeExecutionCwd(current, remote);
}

function readSessionHeaderCwd(raw: string): string | null {
  const headerLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!headerLine) return null;
  try {
    const parsed = JSON.parse(headerLine) as Record<string, unknown>;
    if (parsed.type !== "session") return null;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    return cwd.length > 0 ? cwd : null;
  } catch {
    return null;
  }
}

async function readSavedSessionCwd(input: {
  runId: string;
  sessionPath: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  if (!input.sessionPath.trim()) return null;

  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    try {
      return readSessionHeaderCwd(await fs.readFile(input.sessionPath, "utf8"));
    } catch {
      return null;
    }
  }

  try {
    const sessionHeader = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `if [ -f ${shellQuote(input.sessionPath)} ]; then head -n 1 ${shellQuote(input.sessionPath)}; fi`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    if (sessionHeader.timedOut || (sessionHeader.exitCode ?? 0) !== 0) return null;
    return readSessionHeaderCwd(sessionHeader.stdout);
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const isolatePiProfile = asBoolean(config.isolatePiProfile, false);
  if (isolatePiProfile && executionTargetIsRemote) {
    throw new Error(
      "Managed Pi profile isolation currently supports local execution targets only; disable isolatePiProfile for this remote environment.",
    );
  }

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "pi");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();
  const stdoutLogMode = resolvePiStdoutLogMode(config);

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const piSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredPiSkillNames = resolvePaperclipDesiredSkillNames(config, piSkillEntries);
  const desiredPiSkillKeys = new Set(desiredPiSkillNames);
  const selectedPiSkillEntries: PaperclipSkillEntry[] = [];
  const selectedPiSkillByRuntimeName = new Map<string, PaperclipSkillEntry>();
  const skippedPiSkillEntries: Array<{
    skipped: PaperclipSkillEntry;
    selected: PaperclipSkillEntry;
  }> = [];
  for (const entry of piSkillEntries) {
    if (!desiredPiSkillKeys.has(entry.key)) continue;
    const selected = selectedPiSkillByRuntimeName.get(entry.runtimeName);
    if (selected) {
      skippedPiSkillEntries.push({ skipped: entry, selected });
      continue;
    }
    selectedPiSkillByRuntimeName.set(entry.runtimeName, entry);
    selectedPiSkillEntries.push(entry);
  }

  // Build environment
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  // A managed profile starts empty except for its own trust policy, sessions,
  // and the explicitly selected shared-auth compatibility symlink. Runtime
  // provider configuration is composed on top without persisting provider
  // secrets into the profile.
  const preparedManagedProfile = isolatePiProfile
    ? await prepareManagedPiProfile({
        env,
        companyId: agent.companyId,
        agentId: agent.id,
      })
    : null;
  const localSessionsDir = preparedManagedProfile?.sessionsDir ?? PAPERCLIP_SESSIONS_DIR;
  if (!executionTargetIsRemote) {
    await ensureSessionsDir(localSessionsDir);
  }
  const preparedRuntimeConfig = await preparePiRuntimeConfig({
    env,
    baseAgentConfigDir: preparedManagedProfile?.agentDir,
  });
  const localAgentConfigDir = preparedRuntimeConfig.agentConfigDir ?? "";
  if (localAgentConfigDir) {
    env.PI_CODING_AGENT_DIR = localAgentConfigDir;
  }
  let localSkillsRootDir: string | null = null;
  try {
    for (const { skipped, selected } of skippedPiSkillEntries) {
      await onLog(
        "stderr",
        `[paperclip] Skipping Pi skill "${skipped.key}" because runtime name "${skipped.runtimeName}" is already provided by "${selected.key}".\n`,
      );
    }

    // Prepend selected skill `bin/` dirs to PATH so an agent's bash tool can
    // invoke skill binaries (e.g. `paperclip-get-issue`) by name. Derive PATH
    // additions from the same entries mounted into the run-scoped skills dir.
    const skillBinDirs = selectedPiSkillEntries
      .filter((entry) => entry.source.length > 0)
      .map((entry) => path.join(entry.source, "bin"));
    const mergedEnv = ensurePathInEnv({ ...process.env, ...env });
    const pathKey =
      typeof mergedEnv.Path === "string" && mergedEnv.Path.length > 0 && !mergedEnv.PATH
        ? "Path"
        : "PATH";
    const basePath = mergedEnv[pathKey] ?? "";
    if (skillBinDirs.length > 0) {
      const existing = basePath.split(path.delimiter).filter(Boolean);
      const additions = skillBinDirs.filter((dir) => !existing.includes(dir));
      if (additions.length > 0) {
        mergedEnv[pathKey] = [...additions, basePath].filter(Boolean).join(path.delimiter);
      }
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME", "PI_CODING_AGENT_DIR"],
      resolvedCommand,
    });

    if (!executionTargetIsRemote) {
      await ensurePiModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let remoteSkillsDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    const localSkills = await buildPiSkillsDir(selectedPiSkillEntries);
    localSkillsRootDir = localSkills.rootDir;
    const localSkillsDir = localSkills.skillsDir;
    const mountedSkillNames = selectedPiSkillEntries.map((entry) => entry.runtimeName);
    await onLog(
      "stderr",
      `[paperclip] Mounted ${mountedSkillNames.length} run-scoped Pi skill${mountedSkillNames.length === 1 ? "" : "s"}${mountedSkillNames.length > 0 ? `: ${mountedSkillNames.join(", ")}` : ""}.\n`,
    );

    if (executionTargetIsRemote) {
      try {
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Pi runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "pi",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [
            {
              key: "skills",
              localDir: localSkillsDir,
              followSymlinks: true,
            },
            ...(localAgentConfigDir
              ? [{
                key: "agentConfig",
                localDir: localAgentConfigDir,
              }]
              : []),
          ],
        });
        restoreRemoteWorkspace = () =>
          preparedRemoteRuntime.restoreWorkspace((line) => onLog("stdout", line));
        effectiveExecutionCwd = preparedRemoteRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
        refreshPaperclipWorkspaceEnvForExecution({
          env,
          envConfig,
          workspaceCwd: effectiveWorkspaceCwd,
          workspaceSource,
          workspaceId,
          workspaceRepoUrl,
          workspaceRepoRef,
          workspaceHints,
          agentHome,
          executionTargetIsRemote,
          executionCwd: effectiveExecutionCwd,
        });
        if (adapterExecutionTargetUsesManagedHome(executionTarget) && preparedRemoteRuntime.runtimeRootDir) {
          env.HOME = preparedRemoteRuntime.runtimeRootDir;
        }
        remoteRuntimeRootDir = preparedRemoteRuntime.runtimeRootDir;
        remoteSkillsDir = preparedRemoteRuntime.assetDirs.skills ?? null;
        if (localAgentConfigDir && preparedRemoteRuntime.assetDirs.agentConfig) {
          env.PI_CODING_AGENT_DIR = preparedRemoteRuntime.assetDirs.agentConfig;
        }
      } catch (error) {
        await Promise.allSettled([restoreRemoteWorkspace?.()]);
        throw error;
      }
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "pi",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME", "PI_CODING_AGENT_DIR"],
          resolvedCommand,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const sessionTargetMatches = adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionParamsCwdMatches =
      runtimeSessionCwd.length === 0 ||
      executionCwdsMatch(runtimeSessionCwd, effectiveExecutionCwd, executionTargetIsRemote);
    const savedSessionCwd =
      runtimeSessionId.length > 0
        ? await readSavedSessionCwd({
            runId,
            sessionPath: runtimeSessionId,
            executionTarget: runtimeExecutionTarget ?? null,
            cwd,
            env,
            timeoutSec,
            graceSec,
          })
        : null;
    const sessionHeaderCwdMatches =
      runtimeSessionId.length === 0 ||
      (savedSessionCwd !== null &&
        executionCwdsMatch(savedSessionCwd, effectiveExecutionCwd, executionTargetIsRemote));
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      sessionTargetMatches &&
      sessionParamsCwdMatches &&
      sessionHeaderCwdMatches;
    const sessionPath = canResumeSession
      ? runtimeSessionId
      : executionTargetIsRemote && remoteRuntimeRootDir
        ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
        : buildSessionPath(localSessionsDir, agent.id, new Date().toISOString());

    if (runtimeSessionId && !canResumeSession) {
      const staleSessionCwdNote =
        savedSessionCwd !== null && !sessionHeaderCwdMatches
          ? ` Pi stored cwd "${savedSessionCwd}" in the session header, so Paperclip will start a fresh session for "${effectiveExecutionCwd}".`
          : "";
      await onLog(
        "stdout",
        executionTargetIsRemote
          ? `[paperclip] Pi session "${runtimeSessionId}" does not match the current remote execution state and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote} Starting a fresh remote session.\n`
          : `[paperclip] Pi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote}\n`,
      );
    }

    if (!canResumeSession) {
      if (executionTargetIsRemote) {
        await ensureAdapterExecutionTargetFile(runId, runtimeExecutionTarget, sessionPath, {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog,
        });
      } else {
        try {
          await fs.writeFile(sessionPath, "", { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            throw err;
          }
        }
      }
    }

    // Handle instructions file and build system prompt extension
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

    let systemPromptExtension = "";
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        systemPromptExtension =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
          DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
      } catch (err) {
        instructionsReadFailed = true;
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
        // Fall back to base prompt template
        systemPromptExtension = promptTemplate;
      }
    } else {
      systemPromptExtension = promptTemplate;
    }

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
    const renderedBootstrapPrompt =
      !canResumeSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canResumeSession });
    const shouldUseResumeDeltaPrompt = canResumeSession && wakePrompt.length > 0;
    const renderedHeartbeatPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const userPrompt = joinPromptSections([
      renderedBootstrapPrompt,
      wakePrompt,
      sessionHandoffNote,
      renderedHeartbeatPrompt,
    ]);
    const promptMetrics = {
      systemPromptChars: renderedSystemPromptExtension.length,
      promptChars: userPrompt.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedHeartbeatPrompt.length,
    };

    const commandNotes = (() => {
      const notes = [
        ...(preparedManagedProfile?.notes ?? []),
        ...preparedRuntimeConfig.notes,
      ];
      if (stdoutLogMode !== "raw") {
        notes.push(`Pi stdout run-log compaction mode: ${stdoutLogMode}`);
      }
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsReadFailed) {
        notes.push(
          `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        );
        return notes;
      }
      notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      notes.push(
        `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
      );
      return notes;
    })();

    const runtimeSkillsDir = executionTargetIsRemote ? remoteSkillsDir : localSkillsDir;
    if (!runtimeSkillsDir) {
      throw new Error("Remote Pi runtime did not provide the staged skills directory.");
    }

    const buildArgs = (sessionFile: string): string[] => {
      const args: string[] = [];

      // Use JSON mode for structured output with print mode (non-interactive)
      args.push("--mode", "json");
      args.push("-p"); // Non-interactive mode: process prompt and exit

      // Use --append-system-prompt to extend Pi's default system prompt
      args.push("--append-system-prompt", renderedSystemPromptExtension);

      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (thinking) args.push("--thinking", thinking);

      args.push("--tools", "read,bash,edit,write,grep,find,ls");
      args.push("--session", sessionFile);
      args.push("--no-skills");
      args.push("--skill", runtimeSkillsDir);
      if (isolatePiProfile) args.push("--no-extensions");

      if (extraArgs.length > 0) args.push(...extraArgs);

      // Add the user prompt as the last argument
      args.push(userPrompt);

      return args;
    };

    const runAttempt = async (sessionFile: string) => {
      const args = buildArgs(sessionFile);
      if (onMeta) {
        await onMeta({
          adapterType: "pi_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: args,
          env: loggedEnv,
          prompt: userPrompt,
          promptMetrics,
          context,
        });
      }

      // Buffer stdout by lines to handle partial JSON chunks
      let stdoutBuffer = "";
      const compactStdoutLine = createPiStdoutCompactor(stdoutLogMode);
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr") {
          // Pass stderr through immediately (not JSONL)
          await onLog(stream, chunk);
          return;
        }

        // Buffer stdout and emit only complete lines
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        stdoutBuffer = lines.pop() || "";

        // Emit complete lines, compacted per the configured run-log mode.
        // Note: compaction affects ONLY the persisted run log; result parsing
        // (parsePiJsonl) consumes the unfiltered proc.stdout.
        for (const line of lines) {
          if (line) {
            const compacted = compactStdoutLine(line);
            if (compacted !== null) {
              await onLog(stream, compacted + "\n");
            }
          }
        }
      };

      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        cwd,
        env: executionTargetIsRemote ? env : runtimeEnv,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: bufferedOnLog,
        runLogTail: paperclipBridge?.runLogTail,
      });

      // Flush any remaining buffer content
      if (stdoutBuffer) {
        const compacted = compactStdoutLine(stdoutBuffer);
        if (compacted !== null) {
          await onLog("stdout", compacted);
        }
      }

      return {
        proc,
        rawStderr: proc.stderr,
        parsed: parsePiJsonl(proc.stdout),
      };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
        rawStderr: string;
        parsed: ReturnType<typeof parsePiJsonl>;
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId = clearSessionOnMissingSession ? null : sessionPath;
      const resolvedSessionParams = resolvedSessionId
        ? {
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          }
        : null;

      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const parsedError = attempt.parsed.errors.find((error) => error.trim().length > 0) ?? "";
      const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
      const fallbackErrorMessage = parsedError || stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;

      return {
        exitCode: effectiveExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: (effectiveExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: provider,
        biller: resolvePiBiller(runtimeEnv, provider),
        model: model,
        billingType: "unknown",
        costUsd: attempt.parsed.usage.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
        clearSession: Boolean(clearSessionOnMissingSession),
      };
    };

    try {
      const initial = await runAttempt(sessionPath);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);

      if (
        canResumeSession &&
        initialFailed &&
        isPiUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Pi session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const newSessionPath = executionTargetIsRemote && remoteRuntimeRootDir
          ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
          : buildSessionPath(localSessionsDir, agent.id, new Date().toISOString());
        if (executionTargetIsRemote) {
          await ensureAdapterExecutionTargetFile(runId, executionTarget, newSessionPath, {
            cwd,
            env,
            timeoutSec: 15,
            graceSec: 5,
            onLog,
          });
        } else {
          try {
            await fs.writeFile(newSessionPath, "", { flag: "wx" });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
              throw err;
            }
          }
        }
        const retry = await runAttempt(newSessionPath);
        return toResult(retry, true);
      }

      return toResult(initial);
    } finally {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
      ]);
    }
  } finally {
    await Promise.all([
      localSkillsRootDir
        ? fs.rm(localSkillsRootDir, { recursive: true, force: true }).catch(() => undefined)
        : Promise.resolve(),
      preparedRuntimeConfig.cleanup(),
    ]);
  }
}
