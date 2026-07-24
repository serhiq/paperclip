import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareManagedPiProfile,
  resolveManagedPiAgentDir,
  resolveSharedPiAgentDir,
} from "./pi-profile.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }),
  );
});

describe("managed Pi profiles", () => {
  it("resolves company- and agent-scoped paths inside the Paperclip instance", () => {
    const root = path.join(os.tmpdir(), "paperclip-pi-profile-path");
    const env = {
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "instance-1",
    };

    expect(resolveManagedPiAgentDir(env, "company-1", "agent-1")).toBe(
      path.resolve(
        root,
        "instances",
        "instance-1",
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "pi-agent",
      ),
    );
  });

  it("resolves the shared Pi profile from an explicit override, then HOME", () => {
    const root = path.join(os.tmpdir(), "paperclip-pi-shared-profile");
    expect(
      resolveSharedPiAgentDir({
        HOME: path.join(root, "home"),
        PI_CODING_AGENT_DIR: path.join(root, "explicit"),
      }),
    ).toBe(path.resolve(root, "explicit"));
    expect(resolveSharedPiAgentDir({ HOME: path.join(root, "home") })).toBe(
      path.resolve(root, "home", ".pi", "agent"),
    );
  });

  it("creates an isolated profile and symlinks the shared auth file without inheriting host resources", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-profile-"));
    cleanupDirs.add(root);
    const sharedDir = path.join(root, "host-pi-agent");
    const sharedAuth = path.join(sharedDir, "auth.json");
    await fs.mkdir(path.join(sharedDir, "extensions"), { recursive: true });
    await fs.writeFile(sharedAuth, '{"openai-codex":{"type":"oauth"}}\n', { mode: 0o600 });
    await fs.writeFile(path.join(sharedDir, "settings.json"), '{"packages":["host-only"]}\n');

    const prepared = await prepareManagedPiProfile({
      env: {
        PAPERCLIP_HOME: path.join(root, "paperclip"),
        PAPERCLIP_INSTANCE_ID: "test",
        PI_CODING_AGENT_DIR: sharedDir,
      },
      companyId: "company-1",
      agentId: "agent-1",
    });

    const expectedDir = path.join(
      root,
      "paperclip",
      "instances",
      "test",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "pi-agent",
    );
    expect(prepared.agentDir).toBe(expectedDir);
    expect(prepared.sessionsDir).toBe(path.join(expectedDir, "sessions", "paperclip"));
    expect(await fs.realpath(path.join(expectedDir, "auth.json"))).toBe(await fs.realpath(sharedAuth));
    expect(JSON.parse(await fs.readFile(path.join(expectedDir, "settings.json"), "utf8"))).toEqual({
      defaultProjectTrust: "never",
    });
    await expect(fs.access(path.join(expectedDir, "extensions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(expectedDir, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await fs.readFile(path.join(expectedDir, ".paperclip-managed.json"), "utf8")),
    ).toMatchObject({
      adapterType: "pi_local",
      companyId: "company-1",
      agentId: "agent-1",
    });
  });

  it("is idempotent, preserves per-agent settings, and enforces project trust isolation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-profile-idempotent-"));
    cleanupDirs.add(root);
    const env = {
      PAPERCLIP_HOME: path.join(root, "paperclip"),
      PAPERCLIP_INSTANCE_ID: "test",
      HOME: path.join(root, "home"),
    };
    const agentDir = resolveManagedPiAgentDir(env, "company-1", "agent-1");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"defaultProjectTrust":"always","theme":"custom"}\n');

    await prepareManagedPiProfile({ env, companyId: "company-1", agentId: "agent-1" });
    await prepareManagedPiProfile({ env, companyId: "company-1", agentId: "agent-1" });

    expect(JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"))).toEqual({
      defaultProjectTrust: "never",
      theme: "custom",
    });
  });

  it("replaces only an empty Pi-created auth file when shared auth becomes available", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-profile-empty-auth-"));
    cleanupDirs.add(root);
    const sharedDir = path.join(root, "shared");
    const env = {
      PAPERCLIP_HOME: path.join(root, "paperclip"),
      PAPERCLIP_INSTANCE_ID: "test",
      PI_CODING_AGENT_DIR: sharedDir,
    };
    const agentDir = resolveManagedPiAgentDir(env, "company-1", "agent-1");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "auth.json"), '{"shared":true}\n');

    const prepared = await prepareManagedPiProfile({
      env,
      companyId: "company-1",
      agentId: "agent-1",
    });

    expect(prepared.authLinked).toBe(true);
    expect(await fs.realpath(path.join(agentDir, "auth.json"))).toBe(
      await fs.realpath(path.join(sharedDir, "auth.json")),
    );
  });

  it("does not overwrite an existing dedicated auth file with a shared-auth symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-profile-auth-conflict-"));
    cleanupDirs.add(root);
    const sharedDir = path.join(root, "shared");
    const env = {
      PAPERCLIP_HOME: path.join(root, "paperclip"),
      PAPERCLIP_INSTANCE_ID: "test",
      PI_CODING_AGENT_DIR: sharedDir,
    };
    const agentDir = resolveManagedPiAgentDir(env, "company-1", "agent-1");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "auth.json"), '{"shared":true}\n');
    await fs.writeFile(path.join(agentDir, "auth.json"), '{"dedicated":true}\n');

    await expect(
      prepareManagedPiProfile({ env, companyId: "company-1", agentId: "agent-1" }),
    ).rejects.toThrow(/already contains a regular auth\.json/);
    expect(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")).toBe('{"dedicated":true}\n');
  });
});
