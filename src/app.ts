import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import { homedir } from "node:os"
import { ProjectService } from "./services/ProjectService.js"
import { WorktreeService } from "./services/WorktreeService.js"
import { PtyService } from "./services/PtyService.js"
import { SetupService } from "./services/SetupService.js"
import { DatabaseService } from "./services/DatabaseService.js"
import { McpService } from "./services/McpService.js"
import type { McpEvent, WorktreeContext, AgentStatus } from "./mcp/tools.js"
import type { ReportedPr } from "./renderer.js"
import {
  ensureClaudeMcpRegistered,
  ensureCodexConfigured,
  ensureOpencodeConfigured,
  buildAppendSystemPrompt,
} from "./mcp/install.js"
import { generateBranchName } from "./utils/names.js"
import { detectEditors, openEditor, type EditorOption } from "./utils/editors.js"
import { sampleMemory } from "./utils/memory.js"
import type { Project, CommandType } from "./models/Config.js"
import { WorktreeEntry } from "./models/Config.js"
import {
  paintFrame,
  ALT_SCREEN_ON,
  ALT_SCREEN_OFF,
  SHOW_CURSOR,
  SGR_RESET,
  MOUSE_ON,
  MOUSE_OFF,
  BPASTE_ON,
  BPASTE_OFF,
  SIDEBAR_WIDTH,
  type ModalState,
} from "./renderer.js"

export const startApp = Effect.gen(function* () {
  const projectSvc = yield* ProjectService
  const worktreeSvc = yield* WorktreeService
  const ptySvc = yield* PtyService
  const setupSvc = yield* SetupService
  const dbSvc = yield* DatabaseService
  const mcpSvc = yield* McpService

  yield* Effect.tryPromise({
    try: () => bootstrap(projectSvc, worktreeSvc, ptySvc, setupSvc, dbSvc, mcpSvc),
    catch: (e) => new Error(`Failed to start: ${e}`),
  })

  yield* Effect.never
})

type Svc<T> = T extends import("effect").Context.Tag<any, infer S> ? S : never
type ProjSvc = Svc<typeof ProjectService>
type WtSvc = Svc<typeof WorktreeService>
type PtySvc = Svc<typeof PtyService>
type SetSvc = Svc<typeof SetupService>
type DbSvc = Svc<typeof DatabaseService>
type McpSvc = Svc<typeof McpService>

async function bootstrap(
  projectSvc: ProjSvc,
  worktreeSvc: WtSvc,
  ptySvc: PtySvc,
  setupSvc: SetSvc,
  dbSvc: DbSvc,
  mcpSvc: McpSvc,
) {
  const SETTING_LAST_ACTIVE = "last_active_worktree_id"

  const expandTilde = (input: string): string =>
    input.startsWith("~/") ? path.join(homedir(), input.slice(2)) : input

  // Filesystem tab-completion: completes the common prefix of matching
  // entries in the indicated directory. Appends "/" when the unique match
  // is a directory so users can keep tabbing deeper.
  const completePath = (input: string): string => {
    if (!input) return input
    const lookup = expandTilde(input)
    const endsWithSlash = lookup.endsWith("/")
    const dir = endsWithSlash ? lookup : path.dirname(lookup)
    const prefix = endsWithSlash ? "" : path.basename(lookup)
    const head = endsWithSlash ? input : input.slice(0, input.length - prefix.length)
    try {
      const entries = fs.readdirSync(dir).filter(e => e.startsWith(prefix))
      if (entries.length === 0) return input
      let common = entries[0]!
      for (const e of entries.slice(1)) {
        let i = 0
        while (i < common.length && i < e.length && common[i] === e[i]) i++
        common = common.slice(0, i)
      }
      let completed = head + common
      if (entries.length === 1) {
        try {
          if (fs.statSync(path.join(dir, entries[0]!)).isDirectory() && !completed.endsWith("/")) {
            completed += "/"
          }
        } catch {}
      }
      return completed
    } catch {
      return input
    }
  }

  // Strip control characters so pasted text doesn't smuggle in escapes.
  const filterPrintable = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, "")

  const getSetting = (key: string): string | null => {
    const row = dbSvc.db.query("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | null
    return row?.value ?? null
  }

  const setSetting = (key: string, value: string) => {
    dbSvc.db.query("INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
  }

  const acquireLock = (worktreeId: string, ptyPid: number) => {
    dbSvc.db.query(
      "INSERT INTO worktree_locks(worktree_id, pid, pty_pid) VALUES(?, ?, ?) ON CONFLICT(worktree_id) DO UPDATE SET pid = excluded.pid, pty_pid = excluded.pty_pid, locked_at = datetime('now')"
    ).run(worktreeId, process.pid, ptyPid)
  }

  const releaseLock = (worktreeId: string) => {
    dbSvc.db.query("DELETE FROM worktree_locks WHERE worktree_id = ? AND pid = ?").run(worktreeId, process.pid)
  }

  const releaseAllLocks = () => {
    dbSvc.db.query("DELETE FROM worktree_locks WHERE pid = ?").run(process.pid)
  }

  const getLock = (worktreeId: string): { pid: number; pty_pid: number } | null => {
    return dbSvc.db.query("SELECT pid, pty_pid FROM worktree_locks WHERE worktree_id = ?").get(worktreeId) as { pid: number; pty_pid: number } | null
  }

  const isProcessAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  const killProcess = (pid: number) => {
    try { process.kill(pid, "SIGTERM") } catch {}
  }
  let focus: "sidebar" | "terminal" | "modal" = "sidebar"
  let selectedIndex = 0
  let activeWorktreeId: string | null = null
  let modal: ModalState = { type: "none" }
  let projects: Project[] = []
  let activeWorktrees: WorktreeEntry[] = []
  let archivedWorktrees: WorktreeEntry[] = []
  let worktrees: WorktreeEntry[] = []
  let viewMode: "active" | "archived" = "active"
  let availableEditors: EditorOption[] = []
  let running = true
  let dirty = true
  let inlineEdit: { worktreeId: string; value: string } | null = null
  let lastSidebarClick: { y: number; time: number } | null = null
  let sidebarHidden = false
  let ptyPasting = false
  // Wheel-as-arrows detector: see onTerminalInput for the rationale.
  let pendingArrow: { dir: "up" | "down"; str: string; timer: ReturnType<typeof setTimeout> } | null = null
  const WHEEL_WINDOW_MS = 150
  const scrollOffsets = new Map<string, number>()
  // PR detection (via `gh pr list`). null = checked, no PR; undefined = not checked yet.
  const prNumbers = new Map<string, number | null>()
  const prFetchedAt = new Map<string, number>()
  // Found PRs are stable, but null-results (no PR yet) need to recheck often
  // so newly created PRs show up quickly.
  const PR_CACHE_FOUND_MS = 5 * 60 * 1000
  const PR_CACHE_NULL_MS = 30 * 1000
  let ghAvailable: boolean | null = null
  // MCP-driven per-worktree state (agent reports these via the treemux MCP
  // server). All persisted in app_settings so they survive a restart.
  const reportedPr = new Map<string, ReportedPr>()      // authoritative PR, wins over gh poll
  const attention = new Map<string, { summary: string; at: number }>() // unread / needs-you
  const notifications = new Map<string, { message: string; level: string; at: number }>()
  const agentStatus = new Map<string, AgentStatus>()
  const mcpPrKey = (id: string) => `mcp_pr_${id}`
  const mcpAttentionKey = (id: string) => `mcp_attention_${id}`
  const mcpNotifyKey = (id: string) => `mcp_notify_${id}`
  const mcpStatusKey = (id: string) => `mcp_status_${id}`
  // Setup script status per worktree. "running" while scripts execute,
  // dropped from the map when finished.
  const setupRunning = new Set<string>()
  // Worktrees whose git fetch + worktree add is still in flight. These are
  // optimistic placeholders shown in the sidebar with a "cloning" spinner so a
  // slow fetch on a big repo (lots of images/videos) gives immediate feedback.
  const cloning = new Set<string>()
  let cloningWorktrees: WorktreeEntry[] = []
  // RSS per worktree (bytes), sampled from `ps` every couple of seconds.
  let memoryByWorktree: Map<string, number> = new Map()
  let memoryTotal = 0

  const showErrorModal = (title: string, message: string) => {
    focus = "modal"
    modal = { type: "error", title, message }
    markDirty()
  }

  // Brief status message shown in the detail bar; auto-clears after 2s.
  let toastMessage: string | null = null
  let toastUntil = 0
  const showToast = (msg: string, durationMs = 2000) => {
    toastMessage = msg
    toastUntil = Date.now() + durationMs
    markDirty()
    setTimeout(() => {
      if (Date.now() >= toastUntil) {
        toastMessage = null
        markDirty()
      }
    }, durationMs + 50)
  }

  // OSC 52: universal terminal clipboard escape. Works in iTerm2,
  // Terminal.app, kitty, alacritty, wezterm — no external command needed.
  const copyToClipboard = (text: string) => {
    const b64 = Buffer.from(text, "utf-8").toString("base64")
    process.stdout.write(`\x1b]52;c;${b64}\x07`)
  }

  const markDirty = () => { dirty = true }

  const cols = () => process.stdout.columns || 80
  const rows = () => process.stdout.rows || 24
  const termCols = () => sidebarHidden ? cols() : cols() - SIDEBAR_WIDTH - 1
  const termRows = () => rows() - 2

  // A worktree is "awake" when it has a running PTY; "asleep" otherwise.
  const isAwake = (w: WorktreeEntry) => !!ptySvc.get(w.id)

  // Stable sort: awake worktrees first, asleep last, preserving relative order
  // within each group so the list doesn't shuffle arbitrarily.
  const sortByAwake = (list: WorktreeEntry[]): WorktreeEntry[] =>
    list
      .map((w, i) => ({ w, i }))
      .sort((a, b) => (isAwake(b.w) ? 1 : 0) - (isAwake(a.w) ? 1 : 0) || a.i - b.i)
      .map(x => x.w)

  const applyView = () => {
    // Keep the highlighted worktree highlighted across a re-sort.
    const prevSelectedId = worktrees[selectedIndex]?.id
    if (viewMode === "active") {
      activeWorktrees = sortByAwake(activeWorktrees)
      // In-flight clone placeholders sit on top until the real entry lands.
      worktrees = cloningWorktrees.length > 0
        ? [...cloningWorktrees, ...activeWorktrees]
        : activeWorktrees
    } else {
      worktrees = archivedWorktrees
    }
    const idx = prevSelectedId ? worktrees.findIndex(w => w.id === prevSelectedId) : -1
    if (idx >= 0) selectedIndex = idx
    selectedIndex = Math.min(selectedIndex, Math.max(0, worktrees.length - 1))
  }

  const refresh = async () => {
    projects = [...await Effect.runPromise(projectSvc.list())]
    activeWorktrees = [...await Effect.runPromise(worktreeSvc.list())]
    archivedWorktrees = [...await Effect.runPromise(worktreeSvc.listArchived())]
    applyView()
    // Kick off PR checks in the background; don't block UI.
    fetchAllPRs()
  }

  const checkGhAvailable = async (): Promise<boolean> => {
    if (ghAvailable !== null) return ghAvailable
    try {
      const proc = Bun.spawn(["which", "gh"], { stdout: "ignore", stderr: "ignore" })
      ghAvailable = (await proc.exited) === 0
    } catch {
      ghAvailable = false
    }
    return ghAvailable
  }

  const fetchPR = async (wt: WorktreeEntry) => {
    if (!(await checkGhAvailable())) return
    const now = Date.now()
    const last = prFetchedAt.get(wt.id) ?? 0
    const cached = prNumbers.get(wt.id)
    const ttl =
      cached === undefined ? 0 :
      cached === null ? PR_CACHE_NULL_MS :
      PR_CACHE_FOUND_MS
    if (now - last < ttl) return
    prFetchedAt.set(wt.id, now)
    try {
      const proc = Bun.spawn(
        ["gh", "pr", "list", "--head", wt.branchName, "--json", "number", "--limit", "1", "--state", "all"],
        { cwd: wt.path, stdout: "pipe", stderr: "pipe" },
      )
      const exit = await proc.exited
      if (exit !== 0) {
        // Not a github repo, gh not authed, or branch has no PR — record null.
        if (prNumbers.get(wt.id) !== null) {
          prNumbers.set(wt.id, null)
          markDirty()
        }
        return
      }
      const stdout = await new Response(proc.stdout).text()
      const arr = JSON.parse(stdout) as { number: number }[]
      const num = arr[0]?.number ?? null
      if (prNumbers.get(wt.id) !== num) {
        prNumbers.set(wt.id, num)
        markDirty()
      }
    } catch {
      /* ignore */
    }
  }

  const fetchAllPRs = () => {
    for (const wt of worktrees) {
      // The agent's reported PR is authoritative; don't let the gh poll
      // override it.
      if (wt.status === "active" && !reportedPr.has(wt.id)) void fetchPR(wt)
    }
  }

  // --- MCP bridge (agent <-> treemux) ---

  const findWorktree = (id: string): WorktreeEntry | undefined =>
    activeWorktrees.find(w => w.id === id) ?? archivedWorktrees.find(w => w.id === id)

  const desktopNotify = (title: string, message: string) => {
    if (process.platform !== "darwin") return
    const esc = (s: string) => s.replace(/["\\]/g, "\\$&")
    try {
      Bun.spawn(
        ["osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
        { stdout: "ignore", stderr: "ignore" },
      )
    } catch { /* ignore */ }
  }

  const bellAndNotify = (wtId: string, summary: string) => {
    // Terminal bell flags the host tab. Desktop notification only if the user
    // isn't already looking at this worktree's terminal.
    process.stdout.write("\x07")
    const lookingAtIt = activeWorktreeId === wtId && focus === "terminal"
    if (!lookingAtIt) {
      const wt = findWorktree(wtId)
      desktopNotify(`treemux: ${wt?.displayName ?? "worktree"}`, summary)
    }
  }

  const handleMcpEvent = (e: McpEvent) => {
    switch (e.kind) {
      case "report_pr": {
        reportedPr.set(e.worktreeId, { number: e.number, state: e.state })
        setSetting(mcpPrKey(e.worktreeId), JSON.stringify({ number: e.number, url: e.url, state: e.state }))
        markDirty()
        break
      }
      case "report_branch": {
        void Effect.runPromise(
          worktreeSvc.renameBranch(e.worktreeId, e.name, e.displayName).pipe(Effect.catchAll(() => Effect.void)),
        ).then(() => refresh()).then(markDirty)
        break
      }
      case "needs_attention": {
        const rec = { summary: e.summary, at: Date.now() }
        attention.set(e.worktreeId, rec)
        setSetting(mcpAttentionKey(e.worktreeId), JSON.stringify(rec))
        bellAndNotify(e.worktreeId, e.summary)
        markDirty()
        break
      }
      case "notify": {
        const rec = { message: e.message, level: e.level, at: Date.now() }
        notifications.set(e.worktreeId, rec)
        setSetting(mcpNotifyKey(e.worktreeId), JSON.stringify(rec))
        // A notification also marks the worktree unread so it gets noticed.
        const att = { summary: e.message, at: rec.at }
        attention.set(e.worktreeId, att)
        setSetting(mcpAttentionKey(e.worktreeId), JSON.stringify(att))
        bellAndNotify(e.worktreeId, e.message)
        markDirty()
        break
      }
      case "set_status": {
        agentStatus.set(e.worktreeId, e.status)
        setSetting(mcpStatusKey(e.worktreeId), e.status)
        markDirty()
        break
      }
    }
  }

  const provideContext = (worktreeId: string): WorktreeContext | null => {
    const wt = findWorktree(worktreeId)
    if (!wt) return null
    const project = projects.find(p => p.id === wt.projectId)
    const prNum = reportedPr.get(worktreeId)?.number ?? prNumbers.get(worktreeId) ?? null
    return {
      worktreeId,
      branchName: wt.branchName,
      worktreePath: wt.path,
      projectName: project?.name ?? "",
      prNumber: prNum,
      hasPR: prNum !== null,
      baseBranch: "origin/main",
      branchNameIsGenerated: wt.branchNameGenerated,
      defaultCommand: project?.defaultCommand ?? "claude",
      prInstructions: project?.prInstructions,
    }
  }

  // Restore persisted MCP state for all known worktrees on boot.
  const hydrateMcpState = () => {
    for (const wt of [...activeWorktrees, ...archivedWorktrees]) {
      const prRaw = getSetting(mcpPrKey(wt.id))
      if (prRaw) {
        try {
          const p = JSON.parse(prRaw) as { number?: number; state?: string }
          if (p?.number) reportedPr.set(wt.id, { number: p.number, state: p.state })
        } catch { /* ignore */ }
      }
      const atRaw = getSetting(mcpAttentionKey(wt.id))
      if (atRaw) {
        try {
          const a = JSON.parse(atRaw) as { summary?: string; at?: number }
          if (a?.summary) attention.set(wt.id, { summary: a.summary, at: a.at ?? 0 })
        } catch { /* ignore */ }
      }
      const nRaw = getSetting(mcpNotifyKey(wt.id))
      if (nRaw) {
        try {
          const n = JSON.parse(nRaw) as { message?: string; level?: string; at?: number }
          if (n?.message) notifications.set(wt.id, { message: n.message, level: n.level ?? "info", at: n.at ?? 0 })
        } catch { /* ignore */ }
      }
      const st = getSetting(mcpStatusKey(wt.id))
      if (st === "working" || st === "waiting" || st === "done" || st === "error") {
        agentStatus.set(wt.id, st)
      }
    }
  }

  const activeHandle = () => activeWorktreeId ? ptySvc.get(activeWorktreeId) ?? null : null

  // Install each client's MCP config lazily, the first time we launch that
  // client this run — so a Claude-only user never gets codex/opencode files
  // written, and vice versa. Idempotent + cheap; runs before the spawn.
  const ensuredClients = new Set<string>()
  const ensureClientConfigured = (cmd: Project["defaultCommand"]) => {
    if (ensuredClients.has(cmd)) return
    ensuredClients.add(cmd)
    if (cmd === "claude") ensureClaudeMcpRegistered()
    else if (cmd === "codex") ensureCodexConfigured()
    else if (cmd === "opencode") ensureOpencodeConfigured()
  }

  const sessionStartedKey = (worktreeId: string) => `session_started_${worktreeId}`

  const resolveCmd = (p: Project, worktreeId: string): [string, string[]] => {
    const resumed = getSetting(sessionStartedKey(worktreeId)) === "1"
    switch (p.defaultCommand) {
      case "claude": {
        // --continue picks up the most recent conversation in the worktree
        // directory. Skip on first spawn (no session exists yet).
        const args = ["--dangerously-skip-permissions"]
        if (resumed) args.push("--continue")
        // Tell Claude about the treemux MCP tools and when to use them.
        // --append-system-prompt applies per-invocation, so pass it every time.
        args.push("--append-system-prompt", buildAppendSystemPrompt())
        return ["claude", args]
      }
      case "codex": {
        // Point codex at this instance's MCP server and map the per-worktree
        // token (TREEMUX_TOKEN env) to the X-Treemux-Token header, all via
        // per-launch -c overrides so nothing is written to ~/.codex/config.toml
        // (keeps concurrent instances on different ports from colliding).
        return ["codex", [
          "--full-auto",
          "-c", `mcp_servers.treemux.url="${mcpSvc.url}"`,
          "-c", `mcp_servers.treemux.env_http_headers={ "X-Treemux-Token" = "TREEMUX_TOKEN" }`,
        ]]
      }
      case "opencode": return ["opencode", []]
      case "custom":
        if (p.customCommand) {
          const parts = p.customCommand.split(" ")
          return [parts[0]!, parts.slice(1)]
        }
        return ["bash", []]
      default: return ["bash", []]
    }
  }

  const spawnPty = async (worktreeId: string) => {
    if (ptySvc.get(worktreeId)) return
    const wt = worktrees.find(w => w.id === worktreeId)
    if (!wt) return
    const project = projects.find(p => p.id === wt.projectId)
    if (!project) return

    // Make sure this client's MCP config is in place before we launch it.
    ensureClientConfigured(project.defaultCommand)

    const existingLock = getLock(worktreeId)
    if (existingLock && existingLock.pid !== process.pid && existingLock.pty_pid > 0) {
      if (isProcessAlive(existingLock.pty_pid)) {
        killProcess(existingLock.pty_pid)
      }
    }

    const [cmd, args] = resolveCmd(project, worktreeId)
    // Per-worktree MCP identity: the token + this instance's server URL are
    // injected into the child env. Claude's user-scoped MCP registration
    // interpolates ${TREEMUX_TOKEN}/${TREEMUX_MCP_URL} from these, so each
    // worktree connects back to this instance and is identified by its token.
    const mcpEnv: Record<string, string> = {
      TREEMUX_MCP_URL: mcpSvc.url,
      TREEMUX_TOKEN: mcpSvc.tokenFor(worktreeId),
      TREEMUX_WORKTREE_ID: worktreeId,
    }
    const handle = await Effect.runPromise(
      ptySvc.spawn({
        worktreeId,
        command: cmd,
        args,
        cols: termCols(),
        rows: termRows(),
        cwd: wt.path,
        env: mcpEnv,
        onExit: () => {
          releaseLock(worktreeId)
          if (activeWorktreeId === worktreeId && focus === "terminal") {
            if (sidebarHidden) toggleSidebar()
            focus = "sidebar"
            showToast("Session ended")
            markDirty()
          }
        },
        onData: () => {
          // Paint immediately when this worktree is the active one — skips
          // up to ~16ms of paint-loop wait per keystroke.
          if (activeWorktreeId === worktreeId) {
            dirty = true
            paint()
          } else {
            markDirty()
          }
        },
      })
    )
    acquireLock(worktreeId, handle.pid)
    setSetting(sessionStartedKey(worktreeId), "1")
  }

  const currentScrollOffset = () =>
    activeWorktreeId ? scrollOffsets.get(activeWorktreeId) ?? 0 : 0

  const setScrollOffset = (v: number) => {
    if (!activeWorktreeId) return
    const h = activeHandle()
    const max = h ? Math.max(0, ((h.terminal.buffer.active as any).baseY ?? 0)) : 0
    const clamped = Math.max(0, Math.min(max, v))
    scrollOffsets.set(activeWorktreeId, clamped)
  }

  let mouseModeEnabled = false
  const syncMouseMode = () => {
    // Mouse reporting is OFF in terminal focus so the host terminal's native
    // drag-to-select / Cmd+Click on URLs work without a modifier. The host
    // converts the wheel into arrow-key sequences (alt-screen fallback); we
    // detect wheel bursts in onTerminalInput and translate them to PgUp/PgDn
    // so the embedded app (Claude) scrolls its own scrollback.
    const shouldEnable = focus !== "terminal" || modal.type !== "none"
    if (shouldEnable && !mouseModeEnabled) {
      process.stdout.write(MOUSE_ON)
      mouseModeEnabled = true
    } else if (!shouldEnable && mouseModeEnabled) {
      process.stdout.write(MOUSE_OFF)
      mouseModeEnabled = false
    }
  }

  const paint = () => {
    if (!running) return
    const h = activeHandle()
    if (h && h.dirtyLines.size > 0) dirty = true
    // Keep painting while any setup script or clone is running so its spinner animates.
    if (setupRunning.size > 0 || cloning.size > 0) dirty = true
    if (!dirty) return
    dirty = false

    syncMouseMode()

    const frame = paintFrame({
      worktrees,
      projects,
      selectedIndex,
      activeWorktreeId,
      focus: modal.type !== "none" ? "modal" : focus,
      modal,
      handle: h,
      availableEditors,
      cols: cols(),
      rows: rows(),
      scrollOffset: currentScrollOffset(),
      inlineEdit,
      prNumbers,
      reportedPr,
      attention,
      agentStatus,
      setupRunning,
      cloning,
      toast: toastMessage && Date.now() < toastUntil ? toastMessage : null,
      sidebarHidden,
      viewMode,
      archivedCount: archivedWorktrees.length,
      memoryByWorktree,
      memoryTotal,
    })
    process.stdout.write(frame)
  }

  const cleanup = () => {
    running = false
    clearInterval(paintLoop)
    releaseAllLocks()
    for (const id of ptySvc.listActive()) {
      Effect.runSync(ptySvc.kill(id))
    }
    process.stdout.write(BPASTE_OFF + (mouseModeEnabled ? MOUSE_OFF : "") + ALT_SCREEN_OFF + SHOW_CURSOR + SGR_RESET)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
  }

  const quit = () => {
    cleanup()
    process.exit(0)
  }

  const createWorktree = async (projectId: string) => {
    const branch = generateBranchName()
    const project = projects.find(p => p.id === projectId)
    if (!project) return

    // Optimistic "cloning" placeholder: a slow git fetch on a big repo (lots of
    // images/videos) would otherwise show nothing until the worktree exists.
    const now = new Date().toISOString()
    const placeholder = new WorktreeEntry({
      id: `cloning-${branch}`,
      projectId,
      branchName: branch,
      path: "",
      displayName: "cloning…",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    cloningWorktrees = [placeholder, ...cloningWorktrees]
    cloning.add(placeholder.id)
    applyView()
    if (viewMode === "active") selectedIndex = 0
    markDirty()

    let newId: string | null = null
    try {
      await Effect.runPromise(
        worktreeSvc.create({ projectId, branchName: branch, branchNameGenerated: true })
          .pipe(
            Effect.tap((entry: WorktreeEntry) => Effect.sync(() => { newId = entry.id })),
            Effect.catchAll(() => Effect.void),
          )
      )
    } finally {
      cloningWorktrees = cloningWorktrees.filter(w => w.id !== placeholder.id)
      cloning.delete(placeholder.id)
    }
    if (!newId) {
      applyView()
      markDirty()
      return
    }

    await refresh()
    selectedIndex = worktrees.findIndex(w => w.id === newId)
    if (selectedIndex < 0) selectedIndex = 0

    // Open the newly-created worktree (hides sidebar, focuses terminal).
    try { await openWorktree(newId) } catch {}

    if (project.setupScript.length > 0) {
      const wtId = newId
      const wtPath = worktrees.find(w => w.id === wtId)!.path
      setupRunning.add(wtId)
      markDirty()
      // Run scripts in background; show error modal on failure.
      Effect.runPromise(setupSvc.runSetup(wtPath, project.setupScript))
        .then(() => {
          setupRunning.delete(wtId)
          markDirty()
        })
        .catch((err) => {
          setupRunning.delete(wtId)
          const msg = err?.message ?? String(err)
          showErrorModal(
            `Setup script failed for ${project.name}`,
            `Path: ${wtPath}\n\n${msg}`,
          )
        })
    }
  }

  const startOnboarding = () => {
    focus = "modal"
    modal = {
      type: "input",
      title: "Local path to git repo on your machine (Tab to complete, ~ supported)",
      placeholder: "/Users/you/code/myrepo",
      value: "",
      onSubmit: (rawPath) => {
        const repoPath = expandTilde(rawPath)
        const defaultName = path.basename(repoPath)
        const defaultCmd = getGlobalDefaultCommand()
        const defaultSetupScripts = getGlobalSetupScripts()
        modal = {
          type: "input",
          title: "Project name",
          placeholder: defaultName || "my-project",
          value: defaultName,
          onSubmit: (name) => {
            const finalName = name || defaultName
            const cmdOptions: CommandType[] = ["claude", "codex", "opencode", "custom"]
            modal = {
              type: "select",
              title: `Default command (global default: ${defaultCmd})`,
              options: cmdOptions as unknown as string[],
              selectedIndex: Math.max(0, cmdOptions.indexOf(defaultCmd)),
              onSelect: (command) => {
                modal = {
                  type: "textarea",
                  title: "Setup scripts (one per line)",
                  placeholder: defaultSetupScripts.join("\n") || "pnpm i\ncp .env .env.local",
                  value: defaultSetupScripts.join("\n"),
                  onSubmit: (setup) => {
                    modal = { type: "none" }
                    focus = "sidebar"
                    const name = finalName
                    const setupScript = setup
                      ? setup.split("\n").map(s => s.trim()).filter(Boolean)
                      : []
                    Effect.runPromise(
                      projectSvc.add({
                        name,
                        repoPath,
                        setupScript,
                        defaultCommand: command as CommandType,
                      }).pipe(Effect.catchAll(() => Effect.succeed(null)))
                    ).then(async (project: Project | null) => {
                      if (project) {
                        await refresh()
                        await createWorktree(project.id)
                      }
                    })
                  },
                }
              },
            }
          },
        }
      },
    }
  }

  const NEW_PROJECT_OPTION = "+ New project…"

  const openProjectPicker = (selectedIndex = 0) => {
    if (projects.length === 0) {
      startOnboarding()
      return
    }
    focus = "modal"
    modal = {
      type: "select",
      title: "Select project (or add new)",
      options: [...projects.map(p => p.name), NEW_PROJECT_OPTION],
      selectedIndex: Math.min(selectedIndex, projects.length),
      deletableCount: projects.length,
      onSelect: (name) => {
        modal = { type: "none" }
        focus = "sidebar"
        if (name === NEW_PROJECT_OPTION) {
          startOnboarding()
          return
        }
        const project = projects.find(p => p.name === name)
        if (project) createWorktree(project.id)
      },
      onDelete: (idx) => {
        const project = projects[idx]
        if (!project) return
        const activeCount = activeWorktrees.filter(w => w.projectId === project.id).length
        const archivedCount = archivedWorktrees.filter(w => w.projectId === project.id).length
        const orphanSuffix =
          activeCount + archivedCount === 0
            ? ""
            : ` (${activeCount} active, ${archivedCount} archived worktrees will be orphaned)`
        focus = "modal"
        modal = {
          type: "confirm",
          title: "Delete project",
          message: `Delete project "${project.name}"?${orphanSuffix} (y/n)`,
          onConfirm: async () => {
            modal = { type: "none" }
            try {
              await Effect.runPromise(projectSvc.remove(project.id))
              await refresh()
              showToast(`Deleted project ${project.name}`)
              markDirty()
              if (projects.length === 0) {
                focus = "sidebar"
              } else {
                openProjectPicker(Math.min(idx, projects.length - 1))
              }
            } catch (e) {
              modal = {
                type: "error",
                title: "Delete failed",
                message: `Could not delete project: ${String(e)}`,
              }
              markDirty()
            }
          },
        }
        markDirty()
      },
    }
  }

  const handleNew = () => openProjectPicker()

  const handleSleep = () => {
    const wt = worktrees[selectedIndex]
    if (!wt) return
    if (!ptySvc.get(wt.id)) {
      showToast("Already sleeping")
      return
    }
    focus = "modal"
    modal = {
      type: "confirm",
      title: "Sleep worktree",
      message: `Kill the running process for "${wt.displayName}"? It'll resume on next open. (y/n)`,
      onConfirm: async () => {
        modal = { type: "none" }
        focus = "sidebar"
        await Effect.runPromise(ptySvc.kill(wt.id).pipe(Effect.catchAll(() => Effect.void)))
        releaseLock(wt.id)
        if (activeWorktreeId === wt.id) {
          activeWorktreeId = null
          if (sidebarHidden) toggleSidebar()
        }
        applyView() // re-sort: the now-asleep worktree drops to the bottom
        showToast(`Slept ${wt.displayName}`)
        markDirty()
      },
    }
  }

  const handleArchive = () => {
    const wt = worktrees[selectedIndex]
    if (!wt) return
    focus = "modal"
    modal = {
      type: "confirm",
      title: "Archive worktree",
      message: `Archive "${wt.displayName}"? (y/n)`,
      onConfirm: async () => {
        modal = { type: "none" }
        focus = "sidebar"
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* ptySvc.kill(wt.id)
            releaseLock(wt.id)
            yield* worktreeSvc.archive(wt.id)
          }).pipe(Effect.catchAll(() => Effect.void))
        )
        if (activeWorktreeId === wt.id) activeWorktreeId = null
        await refresh()
        selectedIndex = Math.max(0, Math.min(selectedIndex, worktrees.length - 1))
        if (worktrees.length > 0 && !activeWorktreeId) {
          activeWorktreeId = worktrees[0]!.id
        }
      },
    }
  }

  const handleEditorPicker = () => {
    const wt = worktrees[selectedIndex]
    if (!wt || availableEditors.length === 0) return
    focus = "modal"
    modal = { type: "editor-picker", worktreeId: wt.id, selectedIndex: 0 }
  }

  const prNumberFor = (wtId: string): number | null =>
    reportedPr.get(wtId)?.number ?? prNumbers.get(wtId) ?? null

  // Open the active worktree's GitHub PR in the browser (Ctrl+P). No-op when
  // there's no PR — the hotkey is only advertised in that case anyway.
  // `gh pr view --web` is GitHub-only and works for open/merged/closed PRs.
  const openActivePR = () => {
    if (!activeWorktreeId) return
    const wt = findWorktree(activeWorktreeId)
    if (!wt || prNumberFor(activeWorktreeId) === null) return
    try {
      Bun.spawn(["gh", "pr", "view", wt.branchName, "--web"], {
        cwd: wt.path,
        stdout: "ignore",
        stderr: "ignore",
      })
    } catch { /* ignore */ }
  }

  // --- Settings ---

  const GLOBAL_DEFAULT_COMMAND = "global_default_command"
  const GLOBAL_SETUP_SCRIPTS = "global_setup_scripts"

  const getGlobalDefaultCommand = (): CommandType =>
    (getSetting(GLOBAL_DEFAULT_COMMAND) as CommandType | null) ?? "claude"

  const getGlobalSetupScripts = (): string[] => {
    const v = getSetting(GLOBAL_SETUP_SCRIPTS)
    try { return v ? (JSON.parse(v) as string[]) : [] } catch { return [] }
  }

  const editCommandModal = (
    title: string,
    current: CommandType,
    onPick: (cmd: CommandType) => void,
  ) => {
    const options: CommandType[] = ["claude", "codex", "opencode", "custom"]
    const startIdx = Math.max(0, options.indexOf(current))
    focus = "modal"
    modal = {
      type: "select",
      title,
      options: options as unknown as string[],
      selectedIndex: startIdx,
      onSelect: (name) => {
        modal = { type: "none" }
        focus = "sidebar"
        onPick(name as CommandType)
        markDirty()
      },
    }
  }

  const editSetupModal = (
    title: string,
    current: readonly string[],
    onSubmit: (scripts: string[]) => void,
  ) => {
    focus = "modal"
    modal = {
      type: "textarea",
      title,
      placeholder: "pnpm i\ncp .env .env.local",
      value: current.join("\n"),
      onSubmit: (text) => {
        modal = { type: "none" }
        focus = "sidebar"
        const scripts = text ? text.split("\n").map(s => s.trim()).filter(Boolean) : []
        onSubmit(scripts)
        markDirty()
      },
    }
  }

  const handleProjectSettings = () => {
    const wt = worktrees[selectedIndex]
    if (!wt) return
    const project = projects.find(p => p.id === wt.projectId)
    if (!project) return

    focus = "modal"
    modal = {
      type: "select",
      title: `Settings for project: ${project.name}`,
      options: ["Default command", "Setup scripts", "Cancel"],
      selectedIndex: 0,
      onSelect: (choice) => {
        if (choice === "Default command") {
          editCommandModal(`Default command for ${project.name}`, project.defaultCommand, (cmd) => {
            Effect.runPromise(
              projectSvc.update(project.id, { defaultCommand: cmd })
                .pipe(Effect.catchAll(() => Effect.succeed(null as any)))
            ).then(() => refresh()).then(markDirty)
          })
        } else if (choice === "Setup scripts") {
          editSetupModal(`Setup scripts for ${project.name}`, project.setupScript, (scripts) => {
            Effect.runPromise(
              projectSvc.update(project.id, { setupScript: scripts })
                .pipe(Effect.catchAll(() => Effect.succeed(null as any)))
            ).then(() => refresh()).then(markDirty)
          })
        } else {
          modal = { type: "none" }
          focus = "sidebar"
        }
      },
    }
  }

  const handleGlobalSettings = () => {
    focus = "modal"
    modal = {
      type: "select",
      title: "Global defaults (apply to new projects)",
      options: ["Default command", "Setup scripts", "Cancel"],
      selectedIndex: 0,
      onSelect: (choice) => {
        if (choice === "Default command") {
          editCommandModal("Global default command", getGlobalDefaultCommand(), (cmd) => {
            setSetting(GLOBAL_DEFAULT_COMMAND, cmd)
          })
        } else if (choice === "Setup scripts") {
          editSetupModal("Global default setup scripts", getGlobalSetupScripts(), (scripts) => {
            setSetting(GLOBAL_SETUP_SCRIPTS, JSON.stringify(scripts))
          })
        } else {
          modal = { type: "none" }
          focus = "sidebar"
        }
      },
    }
  }

  // --- Input handling ---

  // SGR mouse: \x1b[<button;col;row(M|m).  M = press/motion, m = release.
  // Buttons: 0/1/2 = left/middle/right press, 64/65 = wheel up/down, 32+ = drag.
  const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/

  const startInlineEdit = (worktreeId: string) => {
    const wt = worktrees.find(w => w.id === worktreeId)
    if (!wt) return
    inlineEdit = { worktreeId, value: wt.displayName }
    focus = "sidebar"
    markDirty()
  }

  const commitInlineEdit = async () => {
    if (!inlineEdit) return
    const { worktreeId, value } = inlineEdit
    const trimmed = value.trim()
    inlineEdit = null
    if (trimmed) {
      await Effect.runPromise(
        worktreeSvc.rename(worktreeId, trimmed).pipe(Effect.catchAll(() => Effect.void))
      )
      await refresh()
    }
    markDirty()
  }

  const cancelInlineEdit = () => {
    inlineEdit = null
    markDirty()
  }

  const handleMouse = (button: number, x: number, y: number, press: boolean): "handled" | "forward" | "drop" => {
    // Wheel events: always handled locally to scroll the terminal panel
    if (button === 64 || button === 65) {
      if (activeHandle() && (sidebarHidden || x > SIDEBAR_WIDTH + 1)) {
        const cur = currentScrollOffset()
        setScrollOffset(button === 64 ? cur + 3 : cur - 3)
        return "handled"
      }
      return "drop"
    }
    // Sidebar clicks: single = select+open, double = rename.
    // Each worktree now spans two rows (primary + project line).
    if (!sidebarHidden && x <= SIDEBAR_WIDTH && press && button === 0) {
      const i = Math.floor((y - 3) / 2)
      if (i < 0 || i >= worktrees.length) return "handled"

      const now = Date.now()
      const isDouble = lastSidebarClick && lastSidebarClick.y === y && now - lastSidebarClick.time < 400
      lastSidebarClick = { y, time: now }

      const wt = worktrees[i]!
      if (isDouble) {
        startInlineEdit(wt.id)
      } else {
        selectedIndex = i
        openWorktree(wt.id)
      }
      return "handled"
    }
    // Terminal area: forward to PTY with adjusted coords
    if ((sidebarHidden || x > SIDEBAR_WIDTH + 1) && activeHandle()) {
      return "forward"
    }
    return "drop"
  }

  const onInput = (rawData: Buffer) => {
    let str = rawData.toString("utf-8")
    markDirty()


    // Large pastes arrive across multiple stdin chunks. Track state so
    // every chunk between \x1b[200~ and \x1b[201~ is forwarded to the PTY.
    const hasOpen = str.includes("\x1b[200~")
    const hasClose = str.includes("\x1b[201~")

    if (hasOpen && focus === "terminal" && !inlineEdit && modal.type === "none") {
      ptyPasting = true
    }

    if (ptyPasting) {
      const h = activeHandle()
      if (h) h.write(str)
      if (hasClose) ptyPasting = false
      return
    }

    // Strip bracketed-paste markers for treemux's own input handling
    // (sidebar, modals, inline edit).
    if (hasOpen || hasClose) {
      str = str.replace(/\x1b\[2(00|01)~/g, "")
      if (str.length === 0) return
    }

    if (str === "\x03") { quit(); return }

    // F1..F9: jump directly to that worktree from any focus.
    if (FKEY_TO_NUM[str] !== undefined) {
      jumpToWorktree(FKEY_TO_NUM[str]! - 1)
      return
    }

    // Mouse events: parse and dispatch
    const m = str.match(MOUSE_RE)
    if (m) {
      const button = parseInt(m[1]!, 10)
      const x = parseInt(m[2]!, 10)
      const y = parseInt(m[3]!, 10)
      const press = m[4] === "M"
      const decision = handleMouse(button, x, y, press)
      if (decision === "forward") {
        const h = activeHandle()
        if (h) {
          const newX = sidebarHidden ? x : x - (SIDEBAR_WIDTH + 1)
          h.write(`\x1b[<${button};${newX};${y}${m[4]}`)
        }
      }
      return
    }

    if (inlineEdit) { onInlineEditInput(str); return }
    if (modal.type !== "none") { onModalInput(str); return }
    if (focus === "terminal") { onTerminalInput(str); return }
    onSidebarInput(str)
  }

  const onInlineEditInput = (str: string) => {
    if (!inlineEdit) return
    if (str === "\r") { commitInlineEdit(); return }
    if (str === "\x1b") { cancelInlineEdit(); return }
    // Cmd+Backspace on macOS → terminals send Ctrl+U (\x15) = kill line
    if (str === "\x15") {
      inlineEdit = { ...inlineEdit, value: "" }
      return
    }
    // Option+Backspace on macOS → terminals send Ctrl+W (\x17) = kill last word
    if (str === "\x17") {
      const trimmed = inlineEdit.value.replace(/\S+\s*$/, "").replace(/\s+$/, "")
      inlineEdit = { ...inlineEdit, value: trimmed }
      return
    }
    if (str === "\x7f") {
      inlineEdit = { ...inlineEdit, value: inlineEdit.value.slice(0, -1) }
      return
    }
    if (str.startsWith("\x1b") && str !== "\x1b") {
      // Unhandled escape sequence — ignore.
      return
    }
    // Accept typed chars AND multi-char pastes; strip control bytes.
    const text = filterPrintable(str)
    if (text.length > 0) {
      inlineEdit = { ...inlineEdit, value: inlineEdit.value + text }
    }
  }

  // Centralized "open this worktree" — focuses terminal, hides sidebar,
  // resizes the PTY to the new (wider) viewport.
  const openWorktree = async (wtId: string) => {
    // Still-cloning placeholders have no real path/worktree yet — ignore.
    if (cloning.has(wtId)) return
    activeWorktreeId = wtId
    setSetting(SETTING_LAST_ACTIVE, wtId)
    // Opening a worktree marks it read: clear any agent attention/notification.
    if (attention.delete(wtId)) setSetting(mcpAttentionKey(wtId), "")
    if (notifications.delete(wtId)) setSetting(mcpNotifyKey(wtId), "")
    if (!sidebarHidden) {
      sidebarHidden = true
    }
    await spawnPty(wtId)
    const h = activeHandle()
    if (h) h.resize(termCols(), termRows())
    focus = "terminal"
    markDirty()
  }

  const jumpToWorktree = (index: number) => {
    if (index < 0 || index >= worktrees.length) return
    const wt = worktrees[index]!
    selectedIndex = index
    openWorktree(wt.id)
  }

  // F1..F9 send escape sequences that work in any modern terminal and don't
  // conflict with macOS Alt-based desktop shortcuts.
  const FKEY_TO_NUM: Record<string, number> = {
    "\x1bOP": 1, "\x1bOQ": 2, "\x1bOR": 3, "\x1bOS": 4,
    "\x1b[15~": 5, "\x1b[17~": 6, "\x1b[18~": 7, "\x1b[19~": 8, "\x1b[20~": 9,
  }

  const restoreWorktree = (worktreeId: string) => {
    Effect.runPromise(
      worktreeSvc.restore(worktreeId).pipe(Effect.catchAll(() => Effect.void))
    ).then(() => refresh()).then(() => {
      showToast("Restored. Switch back with 'a'.")
      markDirty()
    })
  }

  const handlePermanentDelete = () => {
    const wt = worktrees[selectedIndex]
    if (!wt) return
    const wtId = wt.id
    const displayName = wt.displayName
    focus = "modal"
    modal = {
      type: "confirm",
      title: "Delete permanently",
      message: `Permanently delete "${displayName}"? This removes the git worktree and cannot be undone. (y/n)`,
      onConfirm: () => {
        // Capture the entry + its position so we can restore on failure.
        const originalActiveIdx = activeWorktrees.findIndex(w => w.id === wtId)
        const originalArchivedIdx = archivedWorktrees.findIndex(w => w.id === wtId)
        const original = wt

        // OPTIMISTIC UI: remove from in-memory lists right now.
        activeWorktrees = activeWorktrees.filter(w => w.id !== wtId)
        archivedWorktrees = archivedWorktrees.filter(w => w.id !== wtId)
        applyView()

        Effect.runSync(ptySvc.kill(wtId))
        releaseLock(wtId)

        modal = { type: "none" }
        focus = "sidebar"
        showToast(`Deleted ${displayName}`)
        markDirty()

        // Actual deletion in the background. If it fails, restore the entry
        // to its original position and surface the error.
        Effect.runPromise(worktreeSvc.remove(wtId))
          .catch((err) => {
            if (originalActiveIdx >= 0) {
              const next = [...activeWorktrees]
              next.splice(originalActiveIdx, 0, original)
              activeWorktrees = next
            }
            if (originalArchivedIdx >= 0) {
              const next = [...archivedWorktrees]
              next.splice(originalArchivedIdx, 0, original)
              archivedWorktrees = next
            }
            applyView()
            markDirty()
            const msg = err?.message ?? String(err)
            showErrorModal(`Delete failed`, `Could not delete "${displayName}":\n\n${msg}`)
          })
      },
    }
  }

  const toggleView = () => {
    viewMode = viewMode === "active" ? "archived" : "active"
    selectedIndex = 0
    applyView()
    markDirty()
  }

  const onSidebarInput = (str: string) => {
    if (str.length > 1 && !str.startsWith("\x1b")) return

    // Ctrl+B from sidebar: hide sidebar and jump to terminal (full-screen).
    if (str === "\x02") {
      toggleSidebar()
      if (activeHandle()) focus = "terminal"
      return
    }

    // Digit 1-9: jump directly to that worktree (only in active view).
    if (viewMode === "active" && str.length === 1 && str >= "1" && str <= "9") {
      jumpToWorktree(parseInt(str, 10) - 1)
      return
    }

    // View toggle: 'a' from active → archived; 'a' or Esc-like behavior in archived → active.
    if (str === "a") { toggleView(); return }

    // Archived-view-only actions
    if (viewMode === "archived") {
      // Esc exits the archived view back to active.
      if (str === "\x1b") { toggleView(); return }
      switch (str) {
        case "q": quit(); break
        case "j": case "\x1b[B":
          selectedIndex = Math.min(worktrees.length - 1, selectedIndex + 1); break
        case "k": case "\x1b[A":
          selectedIndex = Math.max(0, selectedIndex - 1); break
        case "u": case "r": {
          // u = un-archive, r = restore. Both feel natural here.
          const wt = worktrees[selectedIndex]
          if (wt) restoreWorktree(wt.id)
          break
        }
        case "D":
          handlePermanentDelete()
          break
      }
      return
    }

    // Active view actions
    switch (str) {
      case "q": quit(); break
      case "j": case "\x1b[B":
        selectedIndex = Math.min(worktrees.length - 1, selectedIndex + 1); break
      case "k": case "\x1b[A":
        selectedIndex = Math.max(0, selectedIndex - 1); break
      case "\r":
        if (worktrees.length > 0) {
          const wt = worktrees[selectedIndex]
          if (wt) openWorktree(wt.id)
        } else {
          handleNew()
        }
        break
      case "n": handleNew(); break
      case "d": handleArchive(); break
      case "z": handleSleep(); break
      case "o": handleEditorPicker(); break
      case "r": {
        const wt = worktrees[selectedIndex]
        if (wt) startInlineEdit(wt.id)
        break
      }
      case "s": handleProjectSettings(); break
      case "S": handleGlobalSettings(); break
      case "y": {
        const wt = worktrees[selectedIndex]
        if (wt) {
          copyToClipboard(wt.path)
          showToast(`Copied path: ${wt.path}`)
        }
        break
      }
    }
  }

  const toggleSidebar = () => {
    const wasHidden = sidebarHidden
    sidebarHidden = !sidebarHidden
    if (wasHidden) {
      refresh().then(() => ghostCheck())
    }
    const h = activeHandle()
    if (h) h.resize(termCols(), termRows())
    markDirty()
  }

  const ghostCheck = () => {
    for (const id of ptySvc.listActive()) {
      const lock = getLock(id)
      if (lock && lock.pid !== process.pid && isProcessAlive(lock.pid)) {
        Effect.runSync(ptySvc.kill(id))
        if (activeWorktreeId === id) {
          focus = "sidebar"
          showToast("Session taken over by another instance")
        }
      }
    }
    markDirty()
  }

  const onTerminalInput = (str: string) => {
    if (str === "\x02") {
      // Ctrl+B from terminal: if sidebar is hidden, show it (and focus it);
      // otherwise just move focus to the visible sidebar.
      if (sidebarHidden) toggleSidebar()
      focus = "sidebar"
      return
    }
    if (str === "\x0b") {
      // Ctrl+K: inject the treemux `create_pr` MCP prompt as a slash command.
      // treemux can't make the agent act via MCP (the server can't start a
      // turn), so we type the command into the PTY exactly as the user would.
      // The prompt body — incl. any per-project conventions — lives server-side.
      const h = activeHandle()
      if (h) h.write("/mcp__treemux__create_pr\r")
      return
    }
    if (str === "\x0f") { handleEditorPicker(); return }
    // Ctrl+P: open the PR in the browser — but only swallow it when a PR
    // actually exists, otherwise forward it to the embedded app (shell/agent
    // history). This mirrors the conditional hotkey shown in the status bar.
    if (str === "\x10" && activeWorktreeId && prNumberFor(activeWorktreeId) !== null) {
      openActivePR()
      return
    }
    // Shift+Up / Shift+Down = scroll terminal panel
    if (str === "\x1b[1;2A") { setScrollOffset(currentScrollOffset() + 1); return }
    if (str === "\x1b[1;2B") { setScrollOffset(currentScrollOffset() - 1); return }
    // Shift+PageUp / Shift+PageDown = scroll by page
    if (str === "\x1b[5;2~") { setScrollOffset(currentScrollOffset() + termRows()); return }
    if (str === "\x1b[6;2~") { setScrollOffset(currentScrollOffset() - termRows()); return }

    // Wheel-as-arrows → treemux scroll. The host terminal (Ghostty, iTerm2,
    // etc.) in alt-screen with mouse reporting off translates mouse-wheel
    // notches into Up/Down arrow sequences. Many embedded TUIs (including
    // Claude Code) don't actually respond to PgUp/PgDn either, so we can't
    // delegate scrolling to them. Instead, scroll treemux's own panel
    // offset directly when we detect a wheel arrow burst (≥2 arrows in one
    // chunk OR a second same-direction arrow within WHEEL_WINDOW_MS — far
    // faster than auto-repeat at ~33ms).
    //
    // To avoid the first arrow of every wheel burst leaking through to the
    // embedded app (which would briefly recall input history on every
    // scroll), single arrows are *deferred* by WHEEL_WINDOW_MS. If a
    // follow-up same-direction arrow arrives, the pair is treated as wheel
    // and the deferred forward is canceled. Otherwise the held arrow is
    // forwarded after the timeout — option-list navigation still works,
    // just with imperceptible latency.
    const upOnly = /^(?:\x1b\[A|\x1bOA)+$/.test(str)
    const downOnly = /^(?:\x1b\[B|\x1bOB)+$/.test(str)
    if (upOnly || downOnly) {
      const dir: "up" | "down" = upOnly ? "up" : "down"
      const arrowCount = str.length / 3

      // Follow-up arrow same direction → wheel: cancel the pending forward
      // and scroll, including the count from the pending arrow.
      if (pendingArrow && pendingArrow.dir === dir) {
        clearTimeout(pendingArrow.timer)
        const pendingCount = pendingArrow.str.length / 3
        pendingArrow = null
        setScrollOffset(currentScrollOffset() + (dir === "up" ? pendingCount + arrowCount : -(pendingCount + arrowCount)))
        return
      }

      // Multi-arrow chunk in one read → unambiguously a wheel burst.
      if (arrowCount >= 2) {
        setScrollOffset(currentScrollOffset() + (dir === "up" ? arrowCount : -arrowCount))
        return
      }

      // Single arrow. If there's a stale pending arrow (different
      // direction), flush it first so its forward order is preserved.
      if (pendingArrow) {
        clearTimeout(pendingArrow.timer)
        const flushed = pendingArrow
        pendingArrow = null
        const h = activeHandle()
        if (h) h.write(flushed.str)
      }
      const capturedStr = str
      const capturedDir = dir
      pendingArrow = {
        dir: capturedDir,
        str: capturedStr,
        timer: setTimeout(() => {
          pendingArrow = null
          const h2 = activeHandle()
          if (h2) h2.write(capturedStr)
          markDirty()
        }, WHEEL_WINDOW_MS),
      }
      return
    }

    // Any non-arrow input flushes a pending arrow so its order is preserved.
    if (pendingArrow) {
      clearTimeout(pendingArrow.timer)
      const flushed = pendingArrow
      pendingArrow = null
      const h2 = activeHandle()
      if (h2) h2.write(flushed.str)
    }

    // Any other key resets scroll to follow-tail
    if (currentScrollOffset() > 0 && str.length === 1 && str >= " ") {
      setScrollOffset(0)
    }
    const h = activeHandle()
    if (h) h.write(str)
  }

  const onModalInput = (str: string) => {
    if (str === "\x1b") {
      modal = { type: "none" }
      focus = activeHandle() ? "terminal" : "sidebar"
      return
    }

    // Error modal: any key dismisses
    if (modal.type === "error") {
      modal = { type: "none" }
      focus = activeHandle() ? "terminal" : "sidebar"
      return
    }

    switch (modal.type) {
      case "input":
        if (str === "\r") {
          modal.onSubmit(modal.value.trim())
        } else if (str === "\x7f") {
          modal = { ...modal, value: modal.value.slice(0, -1) }
        } else if (str === "\x15") {
          // Cmd+Backspace: clear entire input
          modal = { ...modal, value: "" }
        } else if (str === "\x17") {
          // Opt+Backspace: delete last word (or last path segment)
          const trimmed = modal.value.replace(/[^\s/]+[\s/]*$/, "").replace(/[\s/]+$/, "")
          modal = { ...modal, value: trimmed }
        } else if (str === "\t") {
          // Tab complete (filesystem paths)
          modal = { ...modal, value: completePath(modal.value) }
        } else if (str.startsWith("\x1b")) {
          // Unhandled escape sequence (arrows, fn keys, etc.) — ignore so
          // we don't append "[A" etc. to the value.
        } else {
          // Accept typed chars AND multi-char pastes; strip control bytes.
          const text = filterPrintable(str)
          if (text.length > 0) {
            modal = { ...modal, value: modal.value + text }
          }
        }
        break

      case "textarea":
        if (str === "\x04") {
          modal.onSubmit(modal.value)
        } else if (str === "\r" && str.length === 1) {
          modal = { ...modal, value: modal.value + "\n" }
        } else if (str === "\x7f") {
          modal = { ...modal, value: modal.value.slice(0, -1) }
        } else if (str === "\x15") {
          const idx = modal.value.lastIndexOf("\n")
          modal = { ...modal, value: idx >= 0 ? modal.value.slice(0, idx + 1) : "" }
        } else if (str === "\x17") {
          const lastNl = modal.value.lastIndexOf("\n")
          const head = modal.value.slice(0, lastNl + 1)
          const tail = modal.value.slice(lastNl + 1)
          const trimmedTail = tail.replace(/\S+\s*$/, "").replace(/\s+$/, "")
          modal = { ...modal, value: head + trimmedTail }
        } else if (str.startsWith("\x1b") && str !== "\x1b") {
          // Unhandled escape sequence — ignore.
        } else {
          // Accept typed chars AND pastes. Preserve \n, normalize \r\n→\n,
          // strip other control bytes (including bare \r which would submit).
          const text = str
            .replace(/\r\n?/g, "\n")
            .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
          if (text.length > 0) {
            modal = { ...modal, value: modal.value + text }
          }
        }
        break

      case "select":
        if (str === "\r") {
          modal.onSelect(modal.options[modal.selectedIndex]!)
        } else if (str === "j" || str === "\x1b[B") {
          modal = { ...modal, selectedIndex: Math.min(modal.options.length - 1, modal.selectedIndex + 1) }
        } else if (str === "k" || str === "\x1b[A") {
          modal = { ...modal, selectedIndex: Math.max(0, modal.selectedIndex - 1) }
        } else if (str === "d" && modal.onDelete && modal.selectedIndex < (modal.deletableCount ?? modal.options.length)) {
          modal.onDelete(modal.selectedIndex)
        }
        break

      case "confirm":
        if (str === "y" || str === "Y") modal.onConfirm()
        else if (str === "n" || str === "N") { modal = { type: "none" }; focus = "sidebar" }
        break

      case "editor-picker":
        if (str === "\r") {
          const editor = availableEditors[modal.selectedIndex]!
          const wtId = modal.worktreeId
          modal = { type: "none" }
          focus = activeHandle() ? "terminal" : "sidebar"
          const wt = worktrees.find(w => w.id === wtId)
          if (wt) openEditor(editor, wt.path)
        } else if (str === "j" || str === "\x1b[B") {
          modal = { ...modal, selectedIndex: Math.min(availableEditors.length - 1, modal.selectedIndex + 1) }
        } else if (str === "k" || str === "\x1b[A") {
          modal = { ...modal, selectedIndex: Math.max(0, modal.selectedIndex - 1) }
        }
        break
    }
  }

  // --- Initialize ---

  // Purge locks left by crashed instances.
  const staleLocks = dbSvc.db.query("SELECT worktree_id, pid, pty_pid FROM worktree_locks").all() as { worktree_id: string; pid: number; pty_pid: number }[]
  for (const lock of staleLocks) {
    if (!isProcessAlive(lock.pid)) {
      if (lock.pty_pid > 0 && isProcessAlive(lock.pty_pid)) killProcess(lock.pty_pid)
      dbSvc.db.query("DELETE FROM worktree_locks WHERE worktree_id = ?").run(lock.worktree_id)
    }
  }

  await refresh()
  hydrateMcpState()
  availableEditors = detectEditors()

  // Wire the MCP server into app state. Per-client config is installed lazily
  // on first spawn of each client (see ensureClientConfigured).
  mcpSvc.onEvent(handleMcpEvent)
  mcpSvc.setContextProvider(provideContext)

  // Mouse reporting is enabled lazily based on focus — see syncMouseMode.
  // We never want it on while the user is interacting with the embedded
  // terminal, because it hijacks drag-to-select and Cmd+Click on URLs.
  process.stdout.write(ALT_SCREEN_ON + BPASTE_ON)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  process.stdin.on("data", onInput)

  process.stdout.on("resize", () => {
    const h = activeHandle()
    if (h) h.resize(termCols(), termRows())
    markDirty()
  })

  if (projects.length === 0) {
    startOnboarding()
  } else if (worktrees.length > 0) {
    // Restore the previously-active worktree if it still exists. Otherwise
    // pick the most-recently-updated worktree.
    const lastId = getSetting(SETTING_LAST_ACTIVE)
    const restored = lastId && worktrees.find(w => w.id === lastId)
    if (restored) {
      selectedIndex = worktrees.findIndex(w => w.id === restored.id)
      openWorktree(restored.id)
    } else {
      activeWorktreeId = worktrees[0]!.id
    }
  }

  // PTY data triggers paint() directly via onData, so this loop is mostly a
  // fallback (spinner animation, time-based UI like toast expiry, off-screen
  // worktrees that still need their dirty flag cleared eventually).
  const paintLoop = setInterval(paint, 16)
  paint()

  // Background poll: re-fetch PR info every 30s so newly opened PRs show up
  // without needing a manual refresh.
  setInterval(() => { fetchAllPRs() }, 30 * 1000)

  // Memory sampling. One `ps` call per tick aggregates RSS over each PTY's
  // process tree (PTY + child shell + Claude/codex + any spawned helpers).
  const sampleAndStoreMemory = async () => {
    const pidByWt = new Map<string, number>()
    for (const id of ptySvc.listActive()) {
      const h = ptySvc.get(id)
      if (h) pidByWt.set(id, h.pid)
    }
    if (pidByWt.size === 0) {
      if (memoryTotal !== 0) {
        memoryByWorktree = new Map()
        memoryTotal = 0
        markDirty()
      }
      return
    }
    try {
      const sample = await sampleMemory(pidByWt)
      memoryByWorktree = sample.perWorktree
      memoryTotal = sample.total
      markDirty()
    } catch { /* ignore */ }
  }
  void sampleAndStoreMemory()
  setInterval(() => { void sampleAndStoreMemory() }, 2000)

  process.on("SIGINT", quit)
  process.on("SIGTERM", quit)
}
