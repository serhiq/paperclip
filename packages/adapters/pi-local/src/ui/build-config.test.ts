import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildPiLocalConfig } from "./build-config.js";

describe("buildPiLocalConfig", () => {
  it("persists the managed Pi profile opt-in", () => {
    const config = buildPiLocalConfig({
      isolatePiProfile: true,
      envVars: "",
      envBindings: {},
    } as CreateConfigValues);

    expect(config.isolatePiProfile).toBe(true);
  });

  it("omits profile isolation when it is disabled", () => {
    const config = buildPiLocalConfig({
      isolatePiProfile: false,
      envVars: "",
      envBindings: {},
    } as CreateConfigValues);

    expect(config.isolatePiProfile).toBeUndefined();
  });
});
