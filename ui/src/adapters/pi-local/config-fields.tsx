import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  ToggleField,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";
const isolatedProfileHint =
  "Use a persistent Paperclip-managed Pi profile scoped to this company and agent. Host settings, extensions, MCP config, packages, and sessions are not inherited. Existing host Pi auth.json is shared through a compatibility symlink; simultaneous OAuth refreshes from different agents can still race.";

export function PiLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <ToggleField
        label="Isolate Pi profile"
        hint={isolatedProfileHint}
        checked={
          isCreate
            ? !!values!.isolatePiProfile
            : eff(
                "adapterConfig",
                "isolatePiProfile",
                !!config.isolatePiProfile,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ isolatePiProfile: v })
            : mark("adapterConfig", "isolatePiProfile", v || undefined)
        }
      />
    </>
  );
}
