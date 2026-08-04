import type { PtyHandle } from "./services/PtyService.js"
import type { WorktreeEntry, Project } from "./models/Config.js"
import type { EditorOption } from "./utils/editors.js"
import type { AgentStatus } from "./mcp/tools.js"

// PR info reported by the agent (authoritative); see McpService.
export interface ReportedPr {
  number: number
  state?: string
}

const ESC = "\x1b"
const CSI = `${ESC}[`

export const ALT_SCREEN_ON = `${CSI}?1049h`
export const ALT_SCREEN_OFF = `${CSI}?1049l`
export const HIDE_CURSOR = `${CSI}?25l`
export const SHOW_CURSOR = `${CSI}?25h`
export const CLEAR = `${CSI}2J`
export const SGR_RESET = `${CSI}0m`
export const CLEAR_RIGHT = `${CSI}0K`
// X11 mouse (click only) + SGR format. We intentionally omit ?1002h
// (button-motion tracking) so the terminal's native drag-to-select keeps
// working — otherwise mouse drags get reported to us and the user can't
// select / copy Claude's output.
export const MOUSE_ON = `${CSI}?1000h${CSI}?1006h`
export const MOUSE_OFF = `${CSI}?1006l${CSI}?1000l`
export const BPASTE_ON = `${CSI}?2004h`
export const BPASTE_OFF = `${CSI}?2004l`

const moveTo = (r: number, c: number) => `${CSI}${r};${c}H`

const SGR_BOLD = `${CSI}1m`
const SGR_DIM = `${CSI}2m`
const SGR_ITALIC = `${CSI}3m`
const SGR_UNDERLINE = `${CSI}4m`
const SGR_INVERSE = `${CSI}7m`

const SIDEBAR_BG = `${CSI}48;5;235m`
const SIDEBAR_FG = `${CSI}38;5;252m`
const SELECTED_BG = `${CSI}48;5;57m`
const SELECTED_FG = `${CSI}38;5;255m`
const ACTIVE_FG = `${CSI}38;5;213m`
const HEADER_FG = `${CSI}38;5;213m`
const BORDER_FG = `${CSI}38;5;240m`
const DIM_FG = `${CSI}38;5;245m`
const BAR_BG = `${CSI}48;5;236m`
const BAR_FG = `${CSI}38;5;252m`
const ACCENT = `${CSI}38;5;81m`
const MODAL_BG = `${CSI}48;5;237m`
const MODAL_BORDER_FG = `${CSI}38;5;213m`
// Three worktree signals, distinguished by color, not by symbol:
//   ATTENTION_FG (amber) — the agent is calling you (needs_attention/notify):
//     bold name + an orb. An unread nudge; clears when you open the worktree.
//   STATUS_ERROR_FG (red) — the agent reported a problem (set_status "error"):
//     red name, no orb. A persistent state; stays red until the agent recovers.
//   DIM_FG + SGR_DIM (dark gray) — ready to archive (set_status "done"): the
//     whole row recedes, including the PR number. Not a nudge and not a
//     problem — the opposite, a "you can stop thinking about this one" signal.
const ATTENTION_FG = `${CSI}38;5;220m`
const STATUS_ERROR_FG = `${CSI}38;5;203m`

export const SIDEBAR_WIDTH = 30

export type ModalState =
  | { type: "none" }
  | { type: "input"; title: string; placeholder: string; value: string; onSubmit: (v: string) => void }
  | { type: "textarea"; title: string; placeholder: string; value: string; onSubmit: (v: string) => void }
  | { type: "select"; title: string; options: string[]; selectedIndex: number; onSelect: (v: string) => void; onDelete?: (idx: number) => void; deletableCount?: number }
  // `choice` opts into a Yes/No button row (arrow-selectable, Enter activates)
  // instead of the bare y/n prompt — use it when the default should be "don't".
  | { type: "confirm"; title: string; message: string; onConfirm: () => void; onCancel?: () => void; choice?: "yes" | "no" }
  | { type: "error"; title: string; message: string }
  | { type: "editor-picker"; worktreeId: string; selectedIndex: number }

export interface InlineEdit {
  worktreeId: string
  value: string
}

export interface FrameOpts {
  worktrees: readonly WorktreeEntry[]
  projects: readonly Project[]
  selectedIndex: number
  activeWorktreeId: string | null
  focus: "sidebar" | "terminal" | "modal"
  modal: ModalState
  handle: PtyHandle | null
  availableEditors: EditorOption[]
  cols: number
  rows: number
  scrollOffset: number
  inlineEdit: InlineEdit | null
  prNumbers: ReadonlyMap<string, number | null>
  reportedPr: ReadonlyMap<string, ReportedPr>
  attention: ReadonlyMap<string, { summary: string; at: number }>
  agentStatus: ReadonlyMap<string, AgentStatus>
  setupRunning: ReadonlySet<string>
  cloning: ReadonlySet<string>
  toast: string | null
  sidebarHidden: boolean
  viewMode: "active" | "archived"
  archivedCount: number
  memoryByWorktree: ReadonlyMap<string, number>
  memorySubprocByWorktree: ReadonlyMap<string, number>
  memorySelf: number
  memoryTotal: number
}

function formatMem(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return ""
  const MB = 1024 * 1024
  const GB = MB * 1024
  if (b >= GB) return `${(b / GB).toFixed(1)}GB`
  return `${Math.round(b / MB)}MB`
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const spinner = (): string => SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length]!

export function paintFrame(opts: FrameOpts): string {
  const { worktrees, projects, selectedIndex, activeWorktreeId, focus, modal, handle, availableEditors, cols, rows, scrollOffset, inlineEdit, prNumbers, reportedPr, attention, agentStatus, setupRunning, cloning, toast, sidebarHidden, viewMode, archivedCount, memoryByWorktree, memorySubprocByWorktree, memorySelf, memoryTotal } = opts
  const contentHeight = rows - 2
  const termStartCol = sidebarHidden ? 1 : SIDEBAR_WIDTH + 2
  const termCols = sidebarHidden ? cols : cols - SIDEBAR_WIDTH - 1

  let out = HIDE_CURSOR

  if (!sidebarHidden) {
    out += paintSidebar(worktrees, projects, selectedIndex, activeWorktreeId, contentHeight, focus === "sidebar", inlineEdit, prNumbers, reportedPr, attention, agentStatus, setupRunning, cloning, viewMode, archivedCount, memoryByWorktree)
    for (let r = 1; r <= contentHeight; r++) {
      out += moveTo(r, SIDEBAR_WIDTH + 1) + BORDER_FG + "│" + SGR_RESET
    }
  }

  if (handle) {
    out += paintTerminal(handle, termStartCol, 1, termCols, contentHeight, scrollOffset)
  } else {
    const wt = worktrees[selectedIndex]
    out += paintPlaceholder(wt, termStartCol, 1, termCols, contentHeight, projects.length === 0)
  }

  const selWt = worktrees[selectedIndex]
  const selProj = selWt ? projects.find(p => p.id === selWt.projectId) : undefined
  out += paintDetailBar(selWt, selProj, rows - 1, cols, scrollOffset, toast, selWt ? memoryByWorktree.get(selWt.id) ?? 0 : 0, selWt ? memorySubprocByWorktree.get(selWt.id) ?? 0 : 0)
  const activePr = activeWorktreeId
    ? reportedPr.get(activeWorktreeId)?.number ?? prNumbers.get(activeWorktreeId) ?? null
    : null
  out += paintStatusBar(focus, rows, cols, viewMode, sidebarHidden ? memoryTotal : 0, sidebarHidden ? memorySelf : 0, activePr !== null)

  if (modal.type !== "none") {
    out += paintModal(modal, availableEditors, cols, rows)
  }

  if (inlineEdit) {
    const idx = worktrees.findIndex(w => w.id === inlineEdit.worktreeId)
    if (idx >= 0) {
      // Two rows per worktree, primary line is at offset idx*2.
      const r = 3 + idx * 2
      // prefix " N M " is 5 chars, name starts at col 6
      const c = 6 + inlineEdit.value.length
      out += moveTo(r, c) + SHOW_CURSOR
    }
  } else if (focus === "terminal" && handle && scrollOffset === 0) {
    const cy = handle.terminal.buffer.active.cursorY
    const cx = handle.terminal.buffer.active.cursorX
    const sr = 1 + cy
    const sc = termStartCol + cx
    if (sr <= contentHeight && sc <= cols) {
      out += moveTo(sr, sc) + SHOW_CURSOR
    }
  } else if (modal.type === "input") {
    const mw = Math.min(60, cols - 4)
    const ml = Math.floor((cols - mw) / 2)
    const mt = Math.floor(rows / 2) - 2
    out += moveTo(mt + 3, ml + 5 + modal.value.length) + SHOW_CURSOR
  }

  return out
}

function paintSidebar(
  worktrees: readonly WorktreeEntry[],
  projects: readonly Project[],
  selectedIndex: number,
  activeId: string | null,
  height: number,
  focused: boolean,
  inlineEdit: InlineEdit | null,
  prNumbers: ReadonlyMap<string, number | null>,
  reportedPr: ReadonlyMap<string, ReportedPr>,
  attention: ReadonlyMap<string, { summary: string; at: number }>,
  agentStatus: ReadonlyMap<string, AgentStatus>,
  setupRunning: ReadonlySet<string>,
  cloning: ReadonlySet<string>,
  viewMode: "active" | "archived",
  archivedCount: number,
  memoryByWorktree: ReadonlyMap<string, number>,
): string {
  let out = ""

  if (viewMode === "archived") {
    const head = " archived"
    const hint = " · 'a' back"
    out += moveTo(1, 1) + SIDEBAR_BG + ACCENT + SGR_BOLD + head + SGR_RESET
    out += SIDEBAR_BG + DIM_FG + SGR_DIM + hint + SGR_RESET
    out += SIDEBAR_BG + " ".repeat(Math.max(0, SIDEBAR_WIDTH - head.length - hint.length)) + SGR_RESET
  } else {
    const brand = " treemux"
    const handle = " · @tomaspiaggio"
    out += moveTo(1, 1) + SIDEBAR_BG + HEADER_FG + SGR_BOLD + brand + SGR_RESET
    out += SIDEBAR_BG + DIM_FG + SGR_DIM + handle + SGR_RESET
    out += SIDEBAR_BG + " ".repeat(Math.max(0, SIDEBAR_WIDTH - brand.length - handle.length)) + SGR_RESET
  }

  out += moveTo(2, 1) + SIDEBAR_BG + BORDER_FG + SGR_DIM + "─".repeat(SIDEBAR_WIDTH) + SGR_RESET

  const listStart = 3
  // Two rows per worktree: row N = primary line, row N+1 = project line.
  // After all worktrees, one row for "[+ New]".
  const spinChar = spinner()

  // The bottom row is reserved for the status/legend label (see below); keep the
  // list from drawing under it so the last worktree isn't clipped.
  const hasBottomLabel = (viewMode === "active" && archivedCount > 0) || viewMode === "archived"
  const lastListRow = hasBottomLabel ? height - 1 : height
  // Scroll the list so the selected worktree stays visible. Each worktree spans
  // two rows, so only `visibleCount` of them fit. Derive the window start purely
  // from selectedIndex (paint is stateless): pin the selection to the bottom
  // edge once it scrolls past the fold, top edge otherwise.
  const visibleCount = Math.max(1, Math.floor((lastListRow - listStart + 1) / 2))
  const startIdx = selectedIndex >= visibleCount ? selectedIndex - visibleCount + 1 : 0

  for (let r = listStart; r <= lastListRow; r++) {
    const offset = r - listStart
    const i = Math.floor(offset / 2) + startIdx
    const isPrimary = offset % 2 === 0

    if (i < worktrees.length) {
      const wt = worktrees[i]!
      const isSelected = i === selectedIndex
      const isActive = wt.id === activeId
      const pr = reportedPr.get(wt.id)
      const isSetupRunning = setupRunning.has(wt.id)
      const isCloning = cloning.has(wt.id)
      // Persistent problem state — the agent reported set_status "error". Shown
      // as a red name (no orb), and it takes precedence over the attention orb:
      // a broken worktree reads as a problem, not a "come here" nudge.
      const hasError = agentStatus.get(wt.id) === "error"
      // "Come here" nudge: the agent flagged this worktree via needs_attention/
      // notify and you haven't opened it since (opening clears it — see
      // openWorktree). Suppressed for the active worktree (you're already there)
      // and for errored worktrees (red wins).
      const needsAttention = attention.has(wt.id) && !isActive && !hasError
      // "Ready to archive": the agent reported set_status "done", which means
      // the whole body of work has landed — PRs merged, nothing left to do —
      // not merely "this turn is over" (that's "waiting"). Renders as a dark
      // gray row so a glance down the sidebar shows what's safe to delete.
      // An unread nudge outranks it: amber first so you don't miss the "come
      // look" call, then gray once you've opened the worktree and cleared it.
      const isDone = agentStatus.get(wt.id) === "done" && !needsAttention
      const editing = inlineEdit?.worktreeId === wt.id

      const numLabel = i < 9 ? `${i + 1}` : " "
      // Marker: a transient spinner while cloning/setup runs, the attention orb
      // when the agent needs you, otherwise nothing. No per-status ticks — the
      // orb is the only symbol, so "no orb" reliably means "no nudge". Problems
      // are signalled by the red name color below, not a marker.
      let marker: string
      let markerColor: string
      if (isCloning) { marker = spinChar; markerColor = ACCENT }
      else if (isSetupRunning) { marker = spinChar; markerColor = SIDEBAR_FG }
      else if (needsAttention) { marker = "●"; markerColor = ATTENTION_FG }
      else { marker = " "; markerColor = SIDEBAR_FG }
      const project = projects.find(p => p.id === wt.projectId)
      const prNum = pr?.number ?? prNumbers.get(wt.id)
      const prSuffix = prNum ? ` #${prNum}` : ""

      if (isPrimary) {
        // Primary line: " N M name #PR                "
        const prefix = ` ${numLabel} ${marker} `
        const displayText = editing ? inlineEdit!.value : wt.displayName
        const maxNameLen = SIDEBAR_WIDTH - prefix.length - prSuffix.length - 1
        const name = displayText.slice(0, Math.max(1, maxNameLen))
        const pad = Math.max(0, SIDEBAR_WIDTH - prefix.length - name.length - prSuffix.length)

        if (editing) {
          out += moveTo(r, 1) + SIDEBAR_BG + DIM_FG + prefix + SGR_RESET
          out += SIDEBAR_BG + SGR_BOLD + ACCENT + name + " ".repeat(pad) + SGR_RESET
        } else if (isSelected && focused) {
          out += moveTo(r, 1) + SELECTED_BG + SELECTED_FG + SGR_BOLD + prefix + name + SGR_RESET
          if (prSuffix) out += SELECTED_BG + ACCENT + SGR_BOLD + prSuffix + SGR_RESET
          out += SELECTED_BG + " ".repeat(pad) + SGR_RESET
        } else if (isDone) {
          out += moveTo(r, 1) + SIDEBAR_BG + DIM_FG + SGR_DIM + prefix + name + prSuffix + " ".repeat(pad) + SGR_RESET
        } else {
          out += moveTo(r, 1) + SIDEBAR_BG + DIM_FG + ` ${numLabel} ` + SGR_RESET
          const nameColor = hasError ? STATUS_ERROR_FG : needsAttention ? ATTENTION_FG : isActive ? ACTIVE_FG : SIDEBAR_FG
          out += SIDEBAR_BG + (needsAttention ? SGR_BOLD : "") + markerColor + marker + SGR_RESET
          out += SIDEBAR_BG + (needsAttention ? SGR_BOLD : "") + nameColor + ` ` + name + SGR_RESET
          if (prSuffix) out += SIDEBAR_BG + ACCENT + prSuffix + SGR_RESET
          out += SIDEBAR_BG + " ".repeat(pad) + SGR_RESET
        }
      } else {
        // Secondary line: indented project name in dim, with memory on the right
        const projectName = project?.name ?? ""
        const indent = "      " // 6 spaces, aligns with name (after " N M ")
        const memBytes = memoryByWorktree.get(wt.id) ?? 0
        const memStr = memBytes > 0 ? formatMem(memBytes) : ""
        const memSuffix = memStr ? ` ${memStr}` : ""
        const maxProjLen = SIDEBAR_WIDTH - indent.length - memSuffix.length - 1
        const shown = projectName.slice(0, Math.max(0, maxProjLen))
        const pad = Math.max(0, SIDEBAR_WIDTH - indent.length - shown.length - memSuffix.length)
        if (isSelected && focused) {
          out += moveTo(r, 1) + SELECTED_BG + SELECTED_FG + SGR_DIM + indent + shown + " ".repeat(pad) + memSuffix + SGR_RESET
        } else {
          out += moveTo(r, 1) + SIDEBAR_BG + DIM_FG + SGR_DIM + indent + shown + " ".repeat(pad) + memSuffix + SGR_RESET
        }
      }
    } else if (i === worktrees.length && isPrimary && viewMode === "active") {
      const label = " [+ New]"
      out += moveTo(r, 1) + SIDEBAR_BG + DIM_FG + label + " ".repeat(Math.max(0, SIDEBAR_WIDTH - label.length)) + SGR_RESET
    } else {
      out += moveTo(r, 1) + SIDEBAR_BG + " ".repeat(SIDEBAR_WIDTH) + SGR_RESET
    }
  }

  // Bottom-of-sidebar status: "Archived (N) — 'a'" in active view (only if any),
  // or restore/delete legend in archived view.
  if (viewMode === "active" && archivedCount > 0) {
    const label = ` archived (${archivedCount}) · 'a'`
    const r = height
    out += moveTo(r, 1) + SIDEBAR_BG + DIM_FG + SGR_DIM + label + " ".repeat(Math.max(0, SIDEBAR_WIDTH - label.length)) + SGR_RESET
  } else if (viewMode === "archived") {
    const label = " u restore · D delete"
    const r = height
    out += moveTo(r, 1) + SIDEBAR_BG + DIM_FG + SGR_DIM + label + " ".repeat(Math.max(0, SIDEBAR_WIDTH - label.length)) + SGR_RESET
  }

  return out
}

function paintTerminal(
  handle: PtyHandle,
  startCol: number,
  startRow: number,
  termCols: number,
  termRows: number,
  scrollOffset: number,
): string {
  let out = ""
  const buffer = handle.terminal.buffer.active
  const termColMax = handle.terminal.cols
  const termRowMax = handle.terminal.rows

  // Determine which buffer rows to render. xterm buffer indices go from
  // 0 to (buffer.length - 1). The visible window normally starts at baseY
  // and shows `rows` rows. When scrolled up, we shift back into scrollback.
  const baseY = (buffer as any).baseY ?? 0
  const startBufRow = Math.max(0, baseY - scrollOffset)


  for (let row = 0; row < termRows; row++) {
    out += moveTo(startRow + row, startCol) + SGR_RESET

    if (row >= termRowMax) {
      out += " ".repeat(termCols)
      continue
    }

    const bufRow = startBufRow + row
    const line = buffer.getLine(bufRow)
    if (!line) {
      out += " ".repeat(termCols)
      continue
    }

    let prevSgr = ""
    let outCol = 0
    let bufCol = 0

    while (outCol < termCols && bufCol < termColMax) {
      // Fresh allocation per cell. Reusing the cell object had subtle bugs
      // where some cells appeared to read stale content (e.g. "shift" →
      // "siift"). The perf cost is modest; the dirty flag in app.ts already
      // skips most paints when nothing changed.
      const result = line.getCell(bufCol)
      if (!result) {
        out += " "
        outCol++
        bufCol++
        continue
      }

      const w = result.getWidth()
      if (w === 0) {
        bufCol++
        continue
      }
      if (outCol + w > termCols) break

      const chars = result.getChars() || " "
      const isSpace = chars === " "
      const sgr = cellSgr(result, isSpace)
      if (sgr !== prevSgr) {
        out += sgr
        prevSgr = sgr
      }

      out += chars
      outCol += w
      bufCol++
    }

    if (outCol < termCols) {
      out += SGR_RESET + " ".repeat(termCols - outCol)
    } else {
      out += SGR_RESET
    }
  }

  handle.dirtyLines.clear()
  return out
}

function cellSgr(cell: any, isSpace: boolean): string {
  let s = SGR_RESET

  if (cell.isBold()) s += SGR_BOLD
  if (cell.isDim()) s += SGR_DIM
  if (cell.isItalic()) s += SGR_ITALIC
  // Underline and strikethrough on space cells render as visible dashes in
  // many terminals/fonts, making body text look like "I-sit-at-the-window".
  // Only emit these for non-space cells.
  if (!isSpace) {
    if (cell.isUnderline()) s += SGR_UNDERLINE
  }
  if (cell.isInverse()) s += SGR_INVERSE

  if (!cell.isFgDefault()) {
    if (cell.isFgRGB()) {
      const c = cell.getFgColor()
      s += `${CSI}38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}m`
    } else if (cell.isFgPalette()) {
      s += `${CSI}38;5;${cell.getFgColor()}m`
    }
  }

  if (!cell.isBgDefault()) {
    if (cell.isBgRGB()) {
      const c = cell.getBgColor()
      s += `${CSI}48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}m`
    } else if (cell.isBgPalette()) {
      s += `${CSI}48;5;${cell.getBgColor()}m`
    }
  }

  return s
}

function paintPlaceholder(
  wt: WorktreeEntry | undefined,
  startCol: number,
  startRow: number,
  termCols: number,
  termRows: number,
  noProjects: boolean,
): string {
  let out = ""
  for (let r = 0; r < termRows; r++) {
    out += moveTo(startRow + r, startCol) + " ".repeat(termCols)
  }

  const cy = startRow + Math.floor(termRows / 2) - 1

  if (noProjects) {
    const msg = "Welcome! Setting up your first project..."
    out += moveTo(cy, startCol + Math.max(0, Math.floor((termCols - msg.length) / 2)))
    out += ACCENT + msg + SGR_RESET
  } else if (wt) {
    const l1 = wt.displayName
    const l2 = `Branch: ${wt.branchName}`
    out += moveTo(cy, startCol + Math.max(0, Math.floor((termCols - l1.length) / 2)))
    out += SGR_BOLD + ACCENT + l1 + SGR_RESET
    out += moveTo(cy + 1, startCol + Math.max(0, Math.floor((termCols - l2.length) / 2)))
    out += DIM_FG + l2 + SGR_RESET
    const l3 = "Press Enter to start terminal"
    out += moveTo(cy + 3, startCol + Math.max(0, Math.floor((termCols - l3.length) / 2)))
    out += "Press " + ACCENT + SGR_BOLD + "Enter" + SGR_RESET + " to start terminal"
  } else {
    const msg = "Press n to create a worktree"
    out += moveTo(cy, startCol + Math.max(0, Math.floor((termCols - msg.length) / 2)))
    out += "Press " + ACCENT + SGR_BOLD + "n" + SGR_RESET + " to create a worktree"
  }

  return out
}

function relTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime()
  const m = Math.floor(d / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function paintDetailBar(wt: WorktreeEntry | undefined, project: Project | undefined, row: number, cols: number, scrollOffset: number, toast: string | null, memBytes: number, subprocBytes: number): string {
  let out = moveTo(row, 1) + BAR_BG

  if (toast) {
    // Toast takes over the detail bar in the accent color
    const msg = ` ${toast}`
    out += ACCENT + SGR_BOLD + (msg.length < cols ? msg + " ".repeat(cols - msg.length) : msg.slice(0, cols))
    out += SGR_RESET
    return out
  }

  out += BAR_FG
  if (!wt) {
    const msg = " No worktree selected"
    out += msg + " ".repeat(Math.max(0, cols - msg.length))
  } else {
    let c = ` ${wt.displayName}`
    c += `  │  Branch: ${wt.branchName}`
    c += `  │  ${wt.status}`
    c += `  │  ${relTime(wt.updatedAt)}`
    if (project) c += `  │  ${project.name}`
    if (memBytes > 0) {
      // Left number is the agent process alone; subprocesses are shown as an
      // additive term so it's clear they're NOT folded into the left figure.
      if (subprocBytes >= 1024 * 1024) {
        c += `  │  mem ${formatMem(memBytes - subprocBytes)} + ${formatMem(subprocBytes)} subproc`
      } else {
        c += `  │  mem ${formatMem(memBytes)}`
      }
    }
    if (scrollOffset > 0) c += `  │  SCROLL -${scrollOffset}`
    out += c.length < cols ? c + " ".repeat(cols - c.length) : c.slice(0, cols)
  }

  out += SGR_RESET
  return out
}

function paintStatusBar(focus: string, row: number, cols: number, viewMode: "active" | "archived", memoryTotal: number, memorySelf: number, hasPr: boolean): string {
  let out = moveTo(row, 1) + BAR_BG + BAR_FG + " "

  if (focus === "sidebar" && viewMode === "archived") {
    out += shortcut("a/Esc", "back to active") + shortcut("u", "restore")
    out += shortcut("D", "delete forever") + shortcut("j/k", "navigate") + shortcut("q", "quit")
  } else if (focus === "sidebar") {
    out += shortcut("Enter", "open") + shortcut("1-9", "jump") + shortcut("n", "new")
    out += shortcut("r", "rename") + shortcut("y", "yank path") + shortcut("d", "archive")
    out += shortcut("z", "sleep") + shortcut("a", "archived") + shortcut("s/S", "settings") + shortcut("q", "quit")
  } else if (focus === "terminal") {
    out += shortcut("Ctrl+B", "sidebar / fullscreen") + shortcut("F1-F9", "jump") + shortcut("Ctrl+O", "editor") + shortcut("Ctrl+K", "draft PR")
    if (hasPr) out += shortcut("Ctrl+P", "open PR")
  }

  out += CLEAR_RIGHT + SGR_RESET

  // Right-aligned total memory readout when sidebar is hidden (terminal focus).
  // The total covers every worktree session plus treemux itself; the tui's own
  // share is called out separately so a leak in it is attributable.
  if (memoryTotal > 0) {
    const self = memorySelf >= 1024 * 1024 ? ` (tui ${formatMem(memorySelf)})` : ""
    const memStr = `total mem ${formatMem(memoryTotal)}${self} `
    const col = Math.max(1, cols - memStr.length + 1)
    out += moveTo(row, col) + BAR_BG + ACCENT + SGR_BOLD + memStr + SGR_RESET
  }
  return out
}

function shortcut(key: string, label: string): string {
  return `${ACCENT}${SGR_BOLD}${key}${SGR_RESET}${BAR_BG}${BAR_FG} ${label}  `
}

function paintModal(modal: ModalState, editors: EditorOption[], screenCols: number, rows: number): string {
  if (modal.type === "none") return ""

  // Dynamic width — grow to fit content, up to terminal width.
  let mw: number
  if (modal.type === "textarea") {
    const valueLines = (modal.value || modal.placeholder || "").split("\n")
    const longest = Math.max(modal.title.length, ...valueLines.map(l => l.length), 40)
    mw = Math.min(screenCols - 4, Math.max(60, longest + 6))
  } else if (modal.type === "input") {
    const contentLen = Math.max(modal.value.length, modal.placeholder.length)
    const longest = Math.max(modal.title.length, contentLen, 40)
    mw = Math.min(screenCols - 4, Math.max(60, longest + 6))
  } else if (modal.type === "error") {
    const msgLines = modal.message.split("\n")
    const longest = Math.max(modal.title.length, ...msgLines.map(l => l.length), 40)
    mw = Math.min(screenCols - 4, Math.max(60, longest + 6))
  } else if (modal.type === "confirm") {
    const longest = Math.max(modal.title.length, modal.message.length, 40)
    mw = Math.min(screenCols - 4, Math.max(60, longest + 6))
  } else {
    mw = Math.min(60, screenCols - 4)
  }

  // Word-wrap helper: wraps plain text to fit a given column width without
  // breaking words (unless a word is itself longer than the width).
  const wrapText = (text: string, width: number): string[] => {
    if (width <= 0) return [text]
    const out: string[] = []
    for (const paragraph of text.split("\n")) {
      const words = paragraph.split(/\s+/).filter(Boolean)
      if (words.length === 0) { out.push(""); continue }
      let line = ""
      for (const w of words) {
        if (line.length === 0) {
          line = w.length > width ? w.slice(0, width) : w
        } else if (line.length + 1 + w.length <= width) {
          line += " " + w
        } else {
          out.push(line)
          line = w.length > width ? w.slice(0, width) : w
        }
      }
      if (line) out.push(line)
    }
    return out
  }
  const ml = Math.floor((screenCols - mw) / 2)

  let title = ""
  let lines: string[] = []

  switch (modal.type) {
    case "input":
      title = modal.title
      lines = [
        ACCENT + "> " + SGR_RESET + MODAL_BG + modal.value +
        (!modal.value && modal.placeholder ? DIM_FG + modal.placeholder + SGR_RESET + MODAL_BG : "")
      ]
      break
    case "textarea": {
      title = modal.title
      const valueLines = modal.value === "" ? [""] : modal.value.split("\n")
      if (modal.value === "" && modal.placeholder) {
        const phLines = modal.placeholder.split("\n")
        lines = phLines.map(l => DIM_FG + l + SGR_RESET + MODAL_BG)
      } else {
        lines = valueLines.map(l => l === "" ? " " : l)
      }
      // Footer hint
      lines.push("")
      lines.push(DIM_FG + "Ctrl+D save · Esc cancel · Enter new line" + SGR_RESET + MODAL_BG)
      break
    }
    case "select":
      title = modal.title
      lines = modal.options.map((o, i) =>
        i === modal.selectedIndex
          ? SELECTED_BG + SELECTED_FG + SGR_BOLD + " " + o + " " + SGR_RESET + MODAL_BG
          : " " + o
      )
      if (modal.onDelete) {
        lines.push("")
        lines.push(DIM_FG + "Enter select · d delete · Esc cancel" + SGR_RESET + MODAL_BG)
      }
      break
    case "confirm": {
      title = modal.title
      // Wrap to fit the modal's inner content width (mw minus borders + padding).
      lines = wrapText(modal.message, mw - 4)
      if (modal.choice) {
        const btn = (label: string, active: boolean) =>
          active
            ? SELECTED_BG + SELECTED_FG + SGR_BOLD + ` ${label} ` + SGR_RESET + MODAL_BG
            : DIM_FG + ` ${label} ` + SGR_RESET + MODAL_BG
        lines.push("")
        lines.push(btn("Yes", modal.choice === "yes") + "   " + btn("No", modal.choice === "no"))
        lines.push("")
        lines.push(DIM_FG + "←/→ choose · Enter confirm · Esc cancel" + SGR_RESET + MODAL_BG)
      }
      break
    }
    case "error":
      title = modal.title
      lines = []
      for (const para of modal.message.split("\n")) lines.push(...wrapText(para, mw - 4))
      lines.push("")
      lines.push(DIM_FG + "Press any key to dismiss" + SGR_RESET + MODAL_BG)
      break
    case "editor-picker":
      title = "Open in editor"
      lines = editors.map((e, i) =>
        i === modal.selectedIndex
          ? SELECTED_BG + SELECTED_FG + SGR_BOLD + " " + e.name + " " + SGR_RESET + MODAL_BG
          : " " + e.name
      )
      break
  }

  const mh = lines.length + 4
  const mt = Math.max(1, Math.floor((rows - mh) / 2))
  let out = ""

  out += moveTo(mt, ml) + MODAL_BORDER_FG + "╭" + "─".repeat(mw - 2) + "╮" + SGR_RESET

  out += moveTo(mt + 1, ml) + MODAL_BORDER_FG + "│" + SGR_RESET + MODAL_BG + " "
  out += SGR_BOLD + ACCENT + title + SGR_RESET + MODAL_BG
  const tp = Math.max(0, mw - 4 - title.length)
  out += " ".repeat(tp) + " " + SGR_RESET + MODAL_BORDER_FG + "│" + SGR_RESET

  out += moveTo(mt + 2, ml) + MODAL_BORDER_FG + "│" + SGR_RESET + MODAL_BG + " ".repeat(mw - 2) + SGR_RESET + MODAL_BORDER_FG + "│" + SGR_RESET

  // Visible length ignoring SGR escape sequences, so we can pad each line's
  // background to the full modal width (otherwise the unfilled gap shows the
  // terminal content underneath and the modal looks transparent/unreadable).
  const visibleLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length
  for (let i = 0; i < lines.length; i++) {
    const lr = mt + 3 + i
    const content = lines[i]!
    const pad = Math.max(0, mw - 4 - visibleLen(content))
    out += moveTo(lr, ml) + MODAL_BORDER_FG + "│" + SGR_RESET + MODAL_BG + "  " + content + MODAL_BG + " ".repeat(pad)
    out += SGR_RESET + moveTo(lr, ml + mw - 1) + MODAL_BORDER_FG + "│" + SGR_RESET
  }

  out += moveTo(mt + mh - 1, ml) + MODAL_BORDER_FG + "╰" + "─".repeat(mw - 2) + "╯" + SGR_RESET

  return out
}
