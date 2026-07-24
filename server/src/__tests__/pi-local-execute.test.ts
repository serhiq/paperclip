import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";

async function writeFakePiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
console.log(JSON.stringify({
  type: "auto_retry_end",
  success: false,
  attempt: 3,
  finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"
}));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeEnvDumpPiCommand(commandPath: string, envDumpPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(envDumpPath)}, process.env.PATH || "");
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeSkillsInspectingPiCommand(
  commandPath: string,
  capturePath: string,
  options: { exitCode?: number; unknownSessionOnce?: boolean } = {},
): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
const args = process.argv.slice(2);
const skillFlagIndex = args.indexOf("--skill");
const skillsDir = skillFlagIndex >= 0 ? args[skillFlagIndex + 1] : null;
const entries = skillsDir ? fs.readdirSync(skillsDir).sort() : [];
const targets = Object.fromEntries(entries.map((entry) => [
  entry,
  fs.realpathSync(path.join(skillsDir, entry)),
]));
const capturePath = ${JSON.stringify(capturePath)};
const previous = fs.existsSync(capturePath)
  ? JSON.parse(fs.readFileSync(capturePath, "utf8"))
  : [];
previous.push({
  args,
  skillsDir,
  entries,
  targets,
  path: process.env.PATH || "",
  piAgentDir: process.env.PI_CODING_AGENT_DIR || null,
});
fs.writeFileSync(capturePath, JSON.stringify(previous));
if (${JSON.stringify(options.unknownSessionOnce === true)} && previous.length === 1) {
  console.error("unknown session id");
  process.exit(1);
}
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "done" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(${options.exitCode ?? 0});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type RuntimeSkillFixture = {
  key: string;
  runtimeName: string;
  source: string;
};

async function executeSkillsFixture(input: {
  runId: string;
  commandPath: string;
  workspace: string;
  home: string;
  skills: RuntimeSkillFixture[];
  desiredSkills: string[];
  runtime?: Parameters<typeof execute>[0]["runtime"];
  freshSession?: boolean;
  isolatePiProfile?: boolean;
  paperclipHome?: string;
  logs?: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
}) {
  const agentId = `agent-${input.runId}`;
  const testSessionPath = path.join(input.workspace, `.pi-session-${input.runId}.jsonl`);
  if (!input.runtime && !input.freshSession) {
    await fs.writeFile(
      testSessionPath,
      `${JSON.stringify({ type: "session", cwd: input.workspace })}\n`,
      "utf8",
    );
  }
  const runtime = input.runtime ?? (input.freshSession
    ? {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      }
    : {
        sessionId: testSessionPath,
        sessionParams: { sessionId: testSessionPath, cwd: input.workspace },
        sessionDisplayId: testSessionPath,
        taskKey: null,
      });

  return execute({
    runId: input.runId,
    agent: {
      id: agentId,
      companyId: "company-skills-isolation",
      name: "Pi Agent",
      adapterType: "pi_local",
      adapterConfig: {},
    },
    runtime,
    config: {
      command: input.commandPath,
      cwd: input.workspace,
      model: "google/gemini-3-flash-preview",
      promptTemplate: "Keep working.",
      env: {
        HOME: input.home,
        ...(input.paperclipHome ? { PAPERCLIP_HOME: input.paperclipHome } : {}),
      },
      ...(input.isolatePiProfile ? { isolatePiProfile: true } : {}),
      paperclipRuntimeSkills: input.skills,
      paperclipSkillSync: { desiredSkills: input.desiredSkills },
    },
    context: {},
    authToken: "run-jwt-token",
    onLog: async (stream, chunk) => {
      input.logs?.push({ stream, chunk });
    },
  });
}

describe("pi_local execute", () => {
  it("uses a persistent per-agent Pi profile with shared auth and isolated sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-profile-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const hostAgentDir = path.join(root, ".pi", "agent");
    const hostAuthPath = path.join(hostAgentDir, "auth.json");
    const paperclipHome = path.join(root, "paperclip-home");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(path.join(hostAgentDir, "extensions", "host-only"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(hostAuthPath, '{"openai-codex":{"type":"oauth"}}\n', "utf8"),
      fs.writeFile(path.join(hostAgentDir, "settings.json"), '{"packages":["host-only"]}\n', "utf8"),
      writeSkillsInspectingPiCommand(commandPath, capturePath),
    ]);

    try {
      const result = await executeSkillsFixture({
        runId: "profile-isolation",
        commandPath,
        workspace,
        home: root,
        paperclipHome,
        skills: [],
        desiredSkills: [],
        freshSession: true,
        isolatePiProfile: true,
      });

      const managedAgentDir = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-skills-isolation",
        "agents",
        "agent-profile-isolation",
        "pi-agent",
      );
      const captures = JSON.parse(await fs.readFile(capturePath, "utf8")) as Array<{
        args: string[];
        piAgentDir: string | null;
      }>;
      expect(captures).toHaveLength(1);
      expect(captures[0]?.piAgentDir).toBe(managedAgentDir);
      expect(captures[0]?.args).toContain("--no-extensions");
      expect(String(result.sessionId).startsWith(path.join(managedAgentDir, "sessions", "paperclip") + path.sep)).toBe(true);
      expect(await fs.realpath(path.join(managedAgentDir, "auth.json"))).toBe(
        await fs.realpath(hostAuthPath),
      );
      expect(JSON.parse(await fs.readFile(path.join(managedAgentDir, "settings.json"), "utf8"))).toEqual({
        defaultProjectTrust: "never",
      });
      expect(await fs.readFile(path.join(hostAgentDir, "settings.json"), "utf8")).toBe(
        '{"packages":["host-only"]}\n',
      );
      await expect(fs.access(path.join(managedAgentDir, "extensions"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loads only selected skills from a run-scoped directory without changing the host skills home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-isolation-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const selectedSkillDir = path.join(root, "runtime-skills", "selected-skill");
    const unselectedSkillDir = path.join(root, "runtime-skills", "unselected-skill");
    const hostSkillsDir = path.join(root, ".pi", "agent", "skills");
    const hostMarker = path.join(hostSkillsDir, "personal-skill");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(path.join(selectedSkillDir, "bin"), { recursive: true }),
      fs.mkdir(path.join(unselectedSkillDir, "bin"), { recursive: true }),
      fs.mkdir(hostMarker, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(selectedSkillDir, "SKILL.md"), "# selected\n", "utf8"),
      fs.writeFile(path.join(unselectedSkillDir, "SKILL.md"), "# unselected\n", "utf8"),
      fs.writeFile(path.join(hostMarker, "SKILL.md"), "# personal\n", "utf8"),
      writeSkillsInspectingPiCommand(commandPath, capturePath),
    ]);

    try {
      await executeSkillsFixture({
        runId: "skills-isolation",
        commandPath,
        workspace,
        home: root,
        skills: [
          { key: "selected", runtimeName: "selected-skill", source: selectedSkillDir },
          { key: "unselected", runtimeName: "unselected-skill", source: unselectedSkillDir },
        ],
        desiredSkills: ["selected"],
      });

      const captures = JSON.parse(await fs.readFile(capturePath, "utf8")) as Array<{
        args: string[];
        skillsDir: string;
        entries: string[];
        targets: Record<string, string>;
        path: string;
      }>;
      expect(captures).toHaveLength(1);
      expect(captures[0]?.args).toContain("--no-skills");
      expect(captures[0]?.skillsDir).not.toBe(hostSkillsDir);
      expect(captures[0]?.entries).toEqual(["selected-skill"]);
      expect(captures[0]?.targets["selected-skill"]).toBe(selectedSkillDir);
      expect(captures[0]?.path.split(path.delimiter)).toContain(path.join(selectedSkillDir, "bin"));
      expect(captures[0]?.path.split(path.delimiter)).not.toContain(path.join(unselectedSkillDir, "bin"));
      await expect(fs.stat(captures[0]!.skillsDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(hostMarker, "SKILL.md"), "utf8")).resolves.toBe("# personal\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses distinct scoped skills directories for concurrent runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-concurrent-"));
    const workspace = path.join(root, "workspace");
    const firstCommandPath = path.join(root, "pi-first");
    const secondCommandPath = path.join(root, "pi-second");
    const firstCapturePath = path.join(root, "capture-first.json");
    const secondCapturePath = path.join(root, "capture-second.json");
    const firstSkillDir = path.join(root, "runtime-skills", "first-skill");
    const secondSkillDir = path.join(root, "runtime-skills", "second-skill");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(firstSkillDir, { recursive: true }),
      fs.mkdir(secondSkillDir, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(firstSkillDir, "SKILL.md"), "# first\n", "utf8"),
      fs.writeFile(path.join(secondSkillDir, "SKILL.md"), "# second\n", "utf8"),
      writeSkillsInspectingPiCommand(firstCommandPath, firstCapturePath),
      writeSkillsInspectingPiCommand(secondCommandPath, secondCapturePath),
    ]);

    try {
      await Promise.all([
        executeSkillsFixture({
          runId: "skills-concurrent-first",
          commandPath: firstCommandPath,
          workspace,
          home: root,
          skills: [{ key: "first", runtimeName: "first-skill", source: firstSkillDir }],
          desiredSkills: ["first"],
        }),
        executeSkillsFixture({
          runId: "skills-concurrent-second",
          commandPath: secondCommandPath,
          workspace,
          home: root,
          skills: [{ key: "second", runtimeName: "second-skill", source: secondSkillDir }],
          desiredSkills: ["second"],
        }),
      ]);

      const [firstCaptures, secondCaptures] = await Promise.all([
        fs.readFile(firstCapturePath, "utf8").then(
          (raw) => JSON.parse(raw) as Array<{ skillsDir: string; entries: string[] }>,
        ),
        fs.readFile(secondCapturePath, "utf8").then(
          (raw) => JSON.parse(raw) as Array<{ skillsDir: string; entries: string[] }>,
        ),
      ]);
      expect(firstCaptures[0]?.skillsDir).not.toBe(secondCaptures[0]?.skillsDir);
      expect(firstCaptures[0]?.entries).toEqual(["first-skill"]);
      expect(secondCaptures[0]?.entries).toEqual(["second-skill"]);
      await expect(fs.stat(firstCaptures[0]!.skillsDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(secondCaptures[0]!.skillsDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up an empty scoped skills directory after a failed run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-failure-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeSkillsInspectingPiCommand(commandPath, capturePath, { exitCode: 1 });

    try {
      const result = await executeSkillsFixture({
        runId: "skills-failure",
        commandPath,
        workspace,
        home: root,
        skills: [],
        desiredSkills: [],
      });
      const captures = JSON.parse(await fs.readFile(capturePath, "utf8")) as Array<{
        args: string[];
        skillsDir: string;
        entries: string[];
      }>;
      expect(result.exitCode).toBe(1);
      expect(captures[0]?.args).toContain("--no-skills");
      expect(captures[0]?.entries).toEqual([]);
      await expect(fs.stat(captures[0]!.skillsDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the first selected skill when runtime names conflict and logs the skipped skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-duplicate-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const firstSkillDir = path.join(root, "runtime-skills", "first");
    const secondSkillDir = path.join(root, "runtime-skills", "second");
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(firstSkillDir, { recursive: true }),
      fs.mkdir(secondSkillDir, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(firstSkillDir, "SKILL.md"), "# first\n", "utf8"),
      fs.writeFile(path.join(secondSkillDir, "SKILL.md"), "# second\n", "utf8"),
      writeSkillsInspectingPiCommand(commandPath, capturePath),
    ]);

    try {
      const result = await executeSkillsFixture({
        runId: "skills-duplicate-name",
        commandPath,
        workspace,
        home: root,
        skills: [
          { key: "first", runtimeName: "duplicate-name", source: firstSkillDir },
          { key: "second", runtimeName: "duplicate-name", source: secondSkillDir },
        ],
        desiredSkills: ["first", "second"],
        logs,
      });

      const captures = JSON.parse(await fs.readFile(capturePath, "utf8")) as Array<{
        skillsDir: string;
        entries: string[];
        targets: Record<string, string>;
      }>;
      expect(result.exitCode).toBe(0);
      expect(captures[0]?.entries).toEqual(["duplicate-name"]);
      expect(captures[0]?.targets["duplicate-name"]).toBe(firstSkillDir);
      expect(logs).toContainEqual({
        stream: "stderr",
        chunk: '[paperclip] Skipping Pi skill "second" because runtime name "duplicate-name" is already provided by "first".\n',
      });
      expect(logs).toContainEqual({
        stream: "stderr",
        chunk: "[paperclip] Mounted 1 run-scoped Pi skill: duplicate-name.\n",
      });
      await expect(fs.stat(captures[0]!.skillsDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses one scoped skills directory for an unknown-session retry and cleans it afterward", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-retry-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    const skillDir = path.join(root, "runtime-skills", "retry-skill");
    const sessionPath = path.join(root, "saved-session.jsonl");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(skillDir, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(skillDir, "SKILL.md"), "# retry\n", "utf8"),
      fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", cwd: workspace })}\n`, "utf8"),
      writeSkillsInspectingPiCommand(commandPath, capturePath, { unknownSessionOnce: true }),
    ]);

    try {
      const result = await executeSkillsFixture({
        runId: "skills-retry",
        commandPath,
        workspace,
        home: root,
        skills: [{ key: "retry", runtimeName: "retry-skill", source: skillDir }],
        desiredSkills: ["retry"],
        runtime: {
          sessionId: sessionPath,
          sessionParams: { sessionId: sessionPath, cwd: workspace },
          sessionDisplayId: sessionPath,
          taskKey: null,
        },
      });
      const captures = JSON.parse(await fs.readFile(capturePath, "utf8")) as Array<{
        skillsDir: string;
        entries: string[];
      }>;
      expect(result.exitCode).toBe(0);
      expect(result.clearSession).toBe(true);
      expect(captures).toHaveLength(2);
      expect(captures[0]?.skillsDir).toBe(captures[1]?.skillsDir);
      expect(captures[0]?.entries).toEqual(["retry-skill"]);
      await expect(fs.stat(captures[0]!.skillsDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails the run when Pi exhausts automatic retries despite exiting 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-pi-quota-exhausted",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("RESOURCE_EXHAUSTED");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepends installed skill bin/ dirs to the spawned Pi child PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-path-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const skillDir = path.join(root, "skills", "demo-skill");
    const skillBinDir = path.join(skillDir, "bin");
    const envDumpPath = path.join(root, "captured-path.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(skillBinDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# demo-skill\n", "utf8");
    await writeEnvDumpPiCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-pi-skill-path",
        agent: {
          id: "agent-skill-path",
          companyId: "company-skill-path",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          paperclipRuntimeSkills: [
            { key: "demo-skill", runtimeName: "demo-skill", source: skillDir },
          ],
          paperclipSkillSync: {
            desiredSkills: ["demo-skill"],
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedPath = await fs.readFile(envDumpPath, "utf8");
      const entries = capturedPath.split(path.delimiter);
      expect(entries[0]).toBe(skillBinDir);
      expect(entries.filter((entry) => entry === skillBinDir)).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose bin/ dirs from skills that are not injected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-path-neg-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const nonInjectedSkillDir = path.join(root, "skills", "not-injected");
    const nonInjectedBinDir = path.join(nonInjectedSkillDir, "bin");
    const envDumpPath = path.join(root, "captured-path.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(nonInjectedBinDir, { recursive: true });
    await fs.writeFile(path.join(nonInjectedSkillDir, "SKILL.md"), "# not-injected\n", "utf8");
    await writeEnvDumpPiCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-pi-skill-path-neg",
        agent: {
          id: "agent-skill-path-neg",
          companyId: "company-skill-path-neg",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          // No explicit paperclipSkillSync preference →
          // resolvePaperclipDesiredSkillNames returns [] → skill is not injected.
          paperclipRuntimeSkills: [
            { key: "not-injected", runtimeName: "not-injected", source: nonInjectedSkillDir },
          ],
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedPath = await fs.readFile(envDumpPath, "utf8");
      expect(capturedPath.split(path.delimiter)).not.toContain(nonInjectedBinDir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
