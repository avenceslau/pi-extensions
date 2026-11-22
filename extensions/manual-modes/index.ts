import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { loadConfig } from "../shared/config.ts";

const SUBAGENT_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

const REVIEW_AGENTS = new Set([
  "review",
  "code-restraint-review",
  "correctness-review",
  "refactor-review",
]);

export default function manualModes(pi: ExtensionAPI): void {
  let subagentsEnabled = true;
  let reviewEnabled = true;
  let autoAuditEnabled = true;

  function updateStatus(ctx: ExtensionContext): void {
    pi.events.emit("manual-modes:changed", {
      subagents: subagentsEnabled,
      review: reviewEnabled,
      autoAudit: autoAuditEnabled,
    });
    ctx.ui.setStatus(
      "manual-modes",
      [
        subagentsEnabled ? "subagents:on" : undefined,
        reviewEnabled ? "review:on" : undefined,
        "audit:ctrl+shift+r",
        `auto-audit:${autoAuditEnabled ? "on" : "off"}(ctrl+shift+s)`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  pi.registerCommand("subagents", {
    description:
      "Enable, disable, or show subagent mode: /subagents on|off|status",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase() || "status";

      if (mode !== "on" && mode !== "off" && mode !== "status") {
        ctx.ui.notify("Usage: /subagents on|off|status", "warning");

        return;
      }

      if (mode === "status") {
        ctx.ui.notify(
          `Subagent mode is ${subagentsEnabled ? "enabled" : "disabled"}.`,
          "info",
        );

        return;
      }

      subagentsEnabled = mode === "on";

      if (subagentsEnabled) {
        const available = new Set(pi.getAllTools().map((tool) => tool.name));
        const subagentTools = SUBAGENT_TOOLS.filter((name) =>
          available.has(name),
        );
        pi.setActiveTools([
          ...new Set([...pi.getActiveTools(), ...subagentTools]),
        ]);
      } else {
        pi.setActiveTools(
          pi.getActiveTools().filter((name) => !SUBAGENT_TOOLS.includes(name)),
        );
      }

      updateStatus(ctx);
      ctx.ui.notify(
        `Subagent mode ${subagentsEnabled ? "enabled" : "disabled"}.`,
        "info",
      );
    },
  });

  pi.registerCommand("review", {
    description:
      "Enable, disable, or show code-review mode: /review on|off|status",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase() || "status";

      if (mode !== "on" && mode !== "off" && mode !== "status") {
        ctx.ui.notify("Usage: /review on|off|status", "warning");

        return;
      }

      if (mode === "status") {
        ctx.ui.notify(
          `Code-review mode is ${reviewEnabled ? "enabled" : "disabled"}.`,
          "info",
        );

        return;
      }

      reviewEnabled = mode === "on";
      updateStatus(ctx);
      ctx.ui.notify(
        `Code-review mode ${reviewEnabled ? "enabled" : "disabled"}.`,
        "info",
      );
    },
  });

  pi.registerShortcut(Key.ctrlShift("a"), {
    description: "Toggle subagent and code-review modes",
    handler: async (ctx) => {
      const enabled = !subagentsEnabled || !reviewEnabled;
      subagentsEnabled = enabled;
      reviewEnabled = enabled;

      if (enabled) {
        const available = new Set(pi.getAllTools().map((tool) => tool.name));
        const subagentTools = SUBAGENT_TOOLS.filter((name) =>
          available.has(name),
        );
        pi.setActiveTools([
          ...new Set([...pi.getActiveTools(), ...subagentTools]),
        ]);
      } else {
        pi.setActiveTools(
          pi.getActiveTools().filter((name) => !SUBAGENT_TOOLS.includes(name)),
        );
      }

      updateStatus(ctx);
      ctx.ui.notify(
        `Subagent and code-review modes ${enabled ? "enabled" : "disabled"}.`,
        "info",
      );
    },
  });

  pi.registerShortcut(Key.ctrlShift("s"), {
    description:
      "Toggle the automatic audit that runs once the main session and its subagents finish",
    handler: async (ctx) => {
      autoAuditEnabled = !autoAuditEnabled;
      updateStatus(ctx);
      ctx.ui.notify(
        `Automatic audit ${autoAuditEnabled ? "enabled" : "disabled"}.`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    subagentsEnabled = true;
    reviewEnabled = true;
    autoAuditEnabled = true;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const subagentTools = SUBAGENT_TOOLS.filter((name) => available.has(name));
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...subagentTools])]);
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    const restrictions = [
      subagentsEnabled
        ? undefined
        : "Subagent mode is disabled. Do not launch or delegate to subagents unless the user runs /subagents on.",
      reviewEnabled
        ? undefined
        : "Code-review mode is disabled. Do not initiate code review or compliance audits unless the user runs /review on.",
    ].filter(Boolean);

    if (restrictions.length === 0) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${restrictions.join("\n")}`,
    };
  });

  const isReviewAgent = (agentType: string): boolean => {
    return (
      REVIEW_AGENTS.has(agentType) ||
      (loadConfig(pi).agentRoles?.review?.includes(agentType) ?? false)
    );
  };

  pi.on("tool_call", async (event) => {
    if (SUBAGENT_TOOLS.includes(event.toolName) && !subagentsEnabled) {
      return {
        block: true,
        reason:
          "Subagent mode is disabled. The user must run /subagents on first.",
      };
    }

    if (
      event.toolName === "Agent" &&
      !reviewEnabled &&
      isReviewAgent(String(event.input.subagent_type))
    ) {
      return {
        block: true,
        reason:
          "Code-review mode is disabled. The user must run /review on first.",
      };
    }
  });
}
