import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function tool(name: string) {
  return {
    name,
    label: name,
    description: `${name} integration fixture`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: name }], details: {} };
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(tool("allowed_tool"));
  pi.registerTool(tool("other_tool"));
  pi.on("input", () => {
    console.log(`SANDBOX_ACTIVE=${pi.getActiveTools().sort().join(",")}`);
    return { action: "handled" as const };
  });
}
