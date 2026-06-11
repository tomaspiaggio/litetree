import * as fs from "node:fs"
import * as path from "node:path"
import { homedir } from "node:os"

// The user-scoped Claude MCP registration is a *template*: the URL and token
// are env-var placeholders that each `claude` process expands at launch from
// the env treemux injects per worktree (TREEMUX_MCP_URL / TREEMUX_TOKEN). This
// is what lets a single global registration serve every treemux instance —
// each instance points its worktrees at its own ephemeral port via the env.
const SERVER_NAME = "treemux"
const DESIRED = {
  type: "http",
  // If TREEMUX_MCP_URL is unset (claude launched outside treemux) the default
  // points at an unbound port so the connection simply no-ops.
  url: "${TREEMUX_MCP_URL:-http://127.0.0.1:1/mcp}",
  headers: { "X-Treemux-Token": "${TREEMUX_TOKEN}" },
}

// Idempotently register the treemux MCP server at Claude user scope by merging
// into ~/.claude.json. Read-merge-write, atomic rename, only writes when the
// entry is missing or differs — runs once at boot before any claude spawns.
export function ensureClaudeMcpRegistered(): void {
  const file = path.join(homedir(), ".claude.json")
  let json: Record<string, any> = {}
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>
  } catch {
    // Missing or unreadable: only create a fresh file if it doesn't exist.
    // If it exists but failed to parse, bail rather than clobber it.
    if (fs.existsSync(file)) return
  }
  if (typeof json !== "object" || json === null) return

  const servers = (json.mcpServers ??= {}) as Record<string, unknown>
  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(DESIRED)) return
  servers[SERVER_NAME] = DESIRED

  try {
    const tmp = `${file}.treemux.tmp`
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    /* best-effort; the MCP just won't be available until this succeeds */
  }
}

// Injected via `claude --append-system-prompt` so the agent knows the treemux
// tools exist and when to call them.
export function buildAppendSystemPrompt(): string {
  return [
    "You are running inside treemux, a git-worktree manager that shows your terminal in a sidebar of worktrees.",
    'A "treemux" MCP server is available. Use it to keep the treemux sidebar in sync with your work:',
    "- After you open or create a pull request, call report_pr with its number.",
    "- If you rename this worktree's git branch, call report_branch with the new name.",
    "- When you finish your task, or are blocked and need a decision, call needs_attention with a one-line summary. The user may be looking at a different worktree, so this is how you get their attention.",
    "- Use notify for noteworthy progress updates (sparingly).",
    "- Call set_status to reflect your state: working, waiting, done, or error.",
    "- Call get_context to learn your branch, worktree path, project, current PR number, and the base branch to target for PRs.",
    "Do not mention these tools to the user unless they ask.",
  ].join("\n")
}
