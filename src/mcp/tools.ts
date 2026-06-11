import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

// Status the agent reports about itself; drives the sidebar marker color.
export type AgentStatus = "working" | "waiting" | "done" | "error"
export type PrState = "open" | "merged" | "closed" | "draft"
export type NotifyLevel = "info" | "warn" | "error"

// Agent -> treemux signals. Each MCP tool call (except get_context) is turned
// into one of these and handed to the handler app.ts registers via onEvent.
export type McpEvent =
  | { kind: "report_pr"; worktreeId: string; number: number; url?: string; state?: PrState }
  | { kind: "report_branch"; worktreeId: string; name: string }
  | { kind: "needs_attention"; worktreeId: string; summary: string }
  | { kind: "notify"; worktreeId: string; message: string; level: NotifyLevel }
  | { kind: "set_status"; worktreeId: string; status: AgentStatus }

// treemux -> agent context, read through the provider app.ts registers.
export interface WorktreeContext {
  worktreeId: string
  branchName: string
  worktreePath: string
  projectName: string
  prNumber: number | null
  hasPR: boolean
  baseBranch: string
  defaultCommand: string
  // Free-form, project-specific PR conventions (set via `project add
  // --pr-instructions`); folded into the create_pr prompt when present.
  prInstructions?: string
}

export interface ToolDeps {
  worktreeId: string
  emit: (e: McpEvent) => void
  getContext: (worktreeId: string) => WorktreeContext | null
}

const ok = () => ({ content: [{ type: "text" as const, text: "ok" }] })

// The text injected as a user turn when the operator triggers the `create_pr`
// prompt (the Ctrl+K hotkey, or `/mcp__treemux__create_pr` typed by hand).
// Context-aware: targets the right base branch, updates an existing PR instead
// of creating a duplicate, and folds in any project-specific conventions.
function buildCreatePrPrompt(ctx: WorktreeContext | null): string {
  const base = ctx?.baseBranch ?? "the default branch"
  const lines: string[] = []

  if (ctx?.hasPR && ctx.prNumber !== null) {
    lines.push(
      `Update the existing pull request (#${ctx.prNumber}) for this worktree's branch.`,
      `Push any new commits, then refresh its title/description if the changes warrant it.`,
    )
  } else {
    lines.push(
      `Create a pull request for this worktree's branch, targeting \`${base}\`.`,
      `Push the branch first if it isn't pushed yet, then open the PR with \`gh pr create\`.`,
    )
  }

  lines.push(
    "",
    "Follow this repository's conventions:",
    "- Match the title format and description structure of recent PRs — check `gh pr list --state merged --limit 10` and any CLAUDE.md / CONTRIBUTING guidance.",
    "- Write a clear title and a description with a Summary and a Test plan.",
  )

  if (ctx?.prInstructions && ctx.prInstructions.trim().length > 0) {
    lines.push("", "Project-specific conventions (these take precedence):", ctx.prInstructions.trim())
  }

  lines.push("", "After the PR is open, call the treemux `report_pr` tool with its number so the sidebar updates.")
  return lines.join("\n")
}

// Registers every treemux tool on a fresh McpServer bound to one worktree.
// In stateless mode we build a new server per request, so `deps.worktreeId`
// is already resolved from the request's auth token by the time we get here.
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { worktreeId, emit, getContext } = deps

  server.registerTool(
    "report_pr",
    {
      title: "Report pull request",
      description:
        "Report the pull request for this worktree's branch. Call this right after you open or update a PR so treemux can show it in the sidebar. This is authoritative and replaces treemux's own PR detection.",
      inputSchema: {
        number: z.number().int().positive(),
        url: z.string().optional(),
        state: z.enum(["open", "merged", "closed", "draft"]).optional(),
      },
    },
    async ({ number, url, state }) => {
      emit({ kind: "report_pr", worktreeId, number, url, state: state as PrState | undefined })
      return ok()
    },
  )

  server.registerTool(
    "report_branch",
    {
      title: "Report branch rename",
      description:
        "Report that you renamed this worktree's git branch. treemux updates its label to match. The on-disk worktree directory does not move.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => {
      emit({ kind: "report_branch", worktreeId, name })
      return ok()
    },
  )

  server.registerTool(
    "needs_attention",
    {
      title: "Request the user's attention",
      description:
        "Signal that you have finished, are blocked, or need a decision from the user. treemux flags this worktree as unread in the sidebar and notifies the user, who may be looking at a different worktree. Pass a one-line summary of what you need.",
      inputSchema: { summary: z.string().min(1) },
    },
    async ({ summary }) => {
      emit({ kind: "needs_attention", worktreeId, summary })
      return ok()
    },
  )

  server.registerTool(
    "notify",
    {
      title: "Send a notification",
      description:
        "Send a noteworthy progress update to the user. Use sparingly for things worth surfacing; for 'I need you' use needs_attention instead.",
      inputSchema: {
        message: z.string().min(1),
        level: z.enum(["info", "warn", "error"]).optional(),
      },
    },
    async ({ message, level }) => {
      emit({ kind: "notify", worktreeId, message, level: (level as NotifyLevel) ?? "info" })
      return ok()
    },
  )

  server.registerTool(
    "set_status",
    {
      title: "Set agent status",
      description:
        "Reflect your current state so treemux can color this worktree: working (busy), waiting (need input), done (finished), error (failed).",
      inputSchema: { status: z.enum(["working", "waiting", "done", "error"]) },
    },
    async ({ status }) => {
      emit({ kind: "set_status", worktreeId, status: status as AgentStatus })
      return ok()
    },
  )

  server.registerTool(
    "get_context",
    {
      title: "Get worktree context",
      description:
        "Get treemux's context for this worktree: branch name, worktree path, project name, current PR number (if any), and the base branch to target for PRs.",
      inputSchema: {},
    },
    async () => {
      const ctx = getContext(worktreeId)
      if (!ctx) {
        return {
          content: [{ type: "text" as const, text: "treemux has no context for this worktree." }],
          isError: true,
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(ctx, null, 2) }] }
    },
  )

  // Operator-invoked prompt: surfaces as `/mcp__treemux__create_pr` in the
  // client and is what treemux's "create a PR" hotkey injects. The trigger is
  // the operator (a keypress / typed command), not the server — MCP can't
  // self-initiate a turn — but the prompt text lives here so it stays one
  // place to evolve and can be tailored per project.
  server.registerPrompt(
    "create_pr",
    {
      title: "Create a PR following our conventions",
      description:
        "Open (or update) the pull request for this worktree's branch, following this repository's and project's conventions, then report it back to treemux.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: buildCreatePrPrompt(getContext(worktreeId)) },
        },
      ],
    }),
  )
}
