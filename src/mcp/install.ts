import * as fs from "node:fs"
import * as path from "node:path"
import { homedir } from "node:os"

// Shared, human-readable guidance describing the treemux MCP tools. Used both
// for Claude's --append-system-prompt and for the codex/opencode AGENTS.md
// instruction files.
const INSTRUCTION_LINES = [
  "You are running inside treemux, a git-worktree manager that shows your terminal in a sidebar of worktrees.",
  'A "treemux" MCP server is available. Use it to keep the treemux sidebar in sync with your work:',
  "- After you open or create a pull request, call report_pr with its number.",
  "- If you rename this worktree's git branch, call report_branch with the new name (and a short displayName for the sidebar).",
  "- ALWAYS call get_context first, before anything else — before researching, before planning, before responding. If branchNameIsGenerated is true, the branch still has a throwaway name and renaming it is your MANDATORY first action: infer a name from the user's request, rename the git branch (follow the repo's existing branch-naming convention, e.g. `fix/...` or `feat/...`), then call report_branch with that branch name AND a short, human displayName for the sidebar. Do this BEFORE the actual task, so the sidebar shows a meaningful name even if the user steps away while you work.",
  "- Name the worktree after the BODY OF WORK, not the current task. A worktree is a long-lived conversation that often produces several PRs in a row, and the user identifies it by that name — so pick a name broad enough to still fit the third or fourth thing they ask for. If the first request is a narrow slice of something larger (e.g. 'make the onboarding button blue'), name it after the larger thing (`fix/onboarding-tweaks`, displayName `onboarding`), not the slice (`button-color`). When the user says up front that you'll be doing a bunch of work in an area, name it after that area.",
  "- Rename ONCE, at the start. After the initial rename, treat the name as fixed: do NOT rename the branch or re-report a displayName for each new task or PR in the same worktree — a changing name loses the user their conversation in the sidebar. Only rename again if the user explicitly asks, or if the work has genuinely moved to an unrelated area, and prefer widening the existing name to replacing it.",
  "- The rename is REQUIRED even in plan mode. Renaming a branch is reversible bookkeeping metadata, NOT task implementation — it does not touch the code you're being asked to change — so plan-mode 'don't make changes yet' rules do NOT apply to it. Run `git branch -m` and report_branch up front, then plan. Never defer the rename to 'after the plan is approved'; by then the user has been staring at a meaningless name the whole time.",
  "- displayName guidance: the sidebar is narrow (~18 characters, and a PR number suffix eats into that), so the displayName must NOT just echo the branch name — drop the `fix/`/`feat/` prefix and any redundant words and write a punchy label a human would skim, e.g. branch `fix/pr-merged-vs-closed-state` → displayName `pr-merged fix`. Name the area, not the individual change, so it stays accurate across every PR this worktree produces.",
  "- When you finish your task, or are blocked and need a decision, call needs_attention with a one-line summary. The user may be looking at a different worktree, so this is how you get their attention.",
  "- Use notify for noteworthy progress updates (sparingly).",
  "- Call set_status on EVERY state transition — this is not optional, and it is not a one-time call. Set `working` when you start doing something, `waiting` when your turn ends and you need the user, `error` when you failed or are stuck. The sidebar is the user's only view of worktrees they are not currently looking at, so a stale status actively misleads them. If you are unsure which state you are in, you are almost always `working` (mid-task) or `waiting` (turn over).",
  "- `done` is special: it means READY TO ARCHIVE — the entire body of work for this worktree is finished AND landed, every PR you opened is merged (or closed for good), and there is nothing left to do. treemux paints the worktree dark gray, which the user reads as \"safe to delete\". Never use `done` to mean \"this task is finished\" or \"my turn is over\" — that is `waiting`. Never use `done` while a PR is still open.",
  "- Getting to `done`: when you believe you have just made the last commit of this worktree's work (or are close to it), do not simply stop at `waiting` and forget about it. Verify the merge yourself and then set `done`. If the PR is already merged, set `done` immediately. If it is still open, poll for the merge in the background — a background process, or a self-paced loop, whichever your harness supports — checking the PR state (e.g. `gh pr view <number> --json state,mergedAt`) with exponential backoff: first check after ~1 minute, then double the wait each time (2m, 4m, 8m…) up to a ~15 minute ceiling. The backoff matters because the user may leave a worktree sitting for hours; do not poll tightly and do not block your turn on it.",
  "- When the poll sees the PR merged, call report_pr with `state: \"merged\"` and set_status `done`. If it comes back closed-without-merge, that is also `done` — abandoned work is equally archivable. Give up polling after roughly an hour with no change, or as soon as the user gives you new work: in that case set_status `working` right away, because any new request means the worktree is no longer archivable and must lose its gray.",
  "- Call get_context to learn your branch, worktree path, project, current PR number, and the base branch to target for PRs.",
  "Do not mention these tools to the user unless they ask.",
]

// Injected via `claude --append-system-prompt`.
export function buildAppendSystemPrompt(): string {
  return INSTRUCTION_LINES.join("\n")
}

// Markdown section (with idempotency markers) for AGENTS.md-style files that
// codex and opencode read and append to their system prompt.
const AGENTS_START = "<!-- treemux:mcp:start -->"
const AGENTS_END = "<!-- treemux:mcp:end -->"

function agentsSection(): string {
  return [
    AGENTS_START,
    "## treemux",
    "",
    ...INSTRUCTION_LINES,
    AGENTS_END,
  ].join("\n")
}

// Idempotently ensure an AGENTS.md at `file` contains the treemux section,
// replacing it in place if the markers already exist, else appending it.
function ensureAgentsFile(file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let existing = ""
    try {
      existing = fs.readFileSync(file, "utf8")
    } catch { /* file doesn't exist yet */ }

    const section = agentsSection()
    let next: string
    const start = existing.indexOf(AGENTS_START)
    const end = existing.indexOf(AGENTS_END)
    if (start !== -1 && end !== -1 && end > start) {
      next = existing.slice(0, start) + section + existing.slice(end + AGENTS_END.length)
    } else {
      next = existing.trimEnd()
      next = next.length ? `${next}\n\n${section}\n` : `${section}\n`
    }
    if (next !== existing) fs.writeFileSync(file, next)
  } catch { /* best-effort */ }
}

// --- Claude Code: user-scoped HTTP MCP registration in ~/.claude.json ---
//
// The URL and token are env-var placeholders that each `claude` process
// expands at launch from the env treemux injects per worktree
// (TREEMUX_MCP_URL / TREEMUX_TOKEN). A single global registration thus serves
// every treemux instance — each points its worktrees at its own ephemeral port.
const CLAUDE_SERVER_NAME = "treemux"
const CLAUDE_DESIRED = {
  type: "http",
  url: "${TREEMUX_MCP_URL:-http://127.0.0.1:1/mcp}",
  headers: { "X-Treemux-Token": "${TREEMUX_TOKEN}" },
}

export function ensureClaudeMcpRegistered(): void {
  const file = path.join(homedir(), ".claude.json")
  let json: Record<string, any> = {}
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>
  } catch {
    // Missing or unreadable: only create fresh if it doesn't exist; if it
    // exists but failed to parse, bail rather than clobber it.
    if (fs.existsSync(file)) return
  }
  if (typeof json !== "object" || json === null) return

  const servers = (json.mcpServers ??= {}) as Record<string, unknown>
  if (JSON.stringify(servers[CLAUDE_SERVER_NAME]) === JSON.stringify(CLAUDE_DESIRED)) return
  servers[CLAUDE_SERVER_NAME] = CLAUDE_DESIRED

  try {
    const tmp = `${file}.treemux.tmp`
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2))
    fs.renameSync(tmp, file)
  } catch { /* best-effort */ }
}

// --- Codex CLI ---
//
// The MCP server itself is configured per-launch via `-c` overrides (see
// resolveCmd in app.ts), so nothing is written to ~/.codex/config.toml — that
// keeps concurrent instances on different ports from racing on the config
// file. Here we only install the global instructions, which codex appends to
// its base prompt from ~/.codex/AGENTS.md.
export function ensureCodexConfigured(): void {
  ensureAgentsFile(path.join(homedir(), ".codex", "AGENTS.md"))
}

// --- opencode ---
//
// Global config gets a remote MCP server whose url/token are {env:...}
// placeholders resolved per-process, plus global AGENTS.md instructions.
const OPENCODE_MCP = {
  type: "remote",
  url: "{env:TREEMUX_MCP_URL}",
  enabled: true,
  oauth: false,
  headers: { "X-Treemux-Token": "{env:TREEMUX_TOKEN}" },
}

export function ensureOpencodeConfigured(): void {
  const dir = path.join(homedir(), ".config", "opencode")
  const file = path.join(dir, "opencode.json")
  try {
    fs.mkdirSync(dir, { recursive: true })
    let json: Record<string, any> = {}
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>
    } catch {
      if (fs.existsSync(file)) return // exists but unparseable — don't clobber
      json = { $schema: "https://opencode.ai/config.json" }
    }
    if (typeof json !== "object" || json === null) return

    const mcp = (json.mcp ??= {}) as Record<string, unknown>
    if (JSON.stringify(mcp.treemux) !== JSON.stringify(OPENCODE_MCP)) {
      mcp.treemux = OPENCODE_MCP
      const tmp = `${file}.treemux.tmp`
      fs.writeFileSync(tmp, JSON.stringify(json, null, 2))
      fs.renameSync(tmp, file)
    }
  } catch { /* best-effort */ }

  ensureAgentsFile(path.join(dir, "AGENTS.md"))
}
