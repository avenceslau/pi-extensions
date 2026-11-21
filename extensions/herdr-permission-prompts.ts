import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Custom components are excluded because long-lived overlays would pin the pane as blocked.
const promptKinds = new Set(["select", "confirm", "input", "editor"]);

export default function (pi: ExtensionAPI) {
  pi.on("ui_prompt_start", (event) => {
    if (!promptKinds.has(event.kind)) {
      return;
    }

    pi.events.emit("herdr:blocked", {
      active: true,
      label: event.title ?? "Waiting for approval",
    });
  });

  pi.on("ui_prompt_end", (event) => {
    if (!promptKinds.has(event.kind)) {
      return;
    }

    pi.events.emit("herdr:blocked", { active: false });
  });
}
