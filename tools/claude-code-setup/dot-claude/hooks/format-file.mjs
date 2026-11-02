// Claude Code PostToolUse hook: formats the file Claude just edited with Prettier.
// Receives the hook event as JSON on stdin. Never fails the tool call: formatting problems
// are reported by `npm run check` instead.
import { execFileSync } from "node:child_process";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input);
    const file = event?.tool_input?.file_path;
    if (
      typeof file === "string" &&
      /\.(ts|tsx|mjs|js|json|css|md)$/.test(file) &&
      !file.includes("node_modules")
    ) {
      execFileSync("npx", ["prettier", "--write", "--ignore-unknown", file], { stdio: "ignore" });
    }
  } catch {
    // ignore — formatting is best effort here
  }
  process.exit(0);
});
