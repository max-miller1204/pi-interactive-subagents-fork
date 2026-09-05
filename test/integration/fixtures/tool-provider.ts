import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
  pi.on("resources_discover", () => ({
    skillPaths: process.env.PI_TEST_EXTENSION_SKILL ? [process.env.PI_TEST_EXTENSION_SKILL] : [],
  }));
  pi.on("input", () => {
    console.log(`SANDBOX_ACTIVE=${pi.getActiveTools().sort().join(",")}`);
    const commands = pi.getCommands();
    const skills = commands
      .filter((command) => command.source === "skill")
      .map((command) => command.name)
      .sort();
    console.log(`SANDBOX_SKILLS=${skills.join(",")}`);
    return { action: "handled" as const };
  });
}
