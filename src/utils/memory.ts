import { spawn } from "node:child_process"
import { dlopen, FFIType, ptr } from "bun:ffi"

export interface MemorySample {
  // Bytes per worktree (whole session: PTY leader + everything it spawned,
  // including orphans left behind by sessions treemux has already closed).
  perWorktree: Map<string, number>
  // Of `perWorktree`, the portion attributable to spawned subprocesses
  // (session total minus the session-leader/agent process itself).
  subprocByWorktree: Map<string, number>
  // treemux's own process and any helper it spawned that isn't part of a
  // worktree session (the TUI, its per-worktree xterm buffers, `ps`, ...).
  selfBytes: number
  // Sum across every tracked worktree PLUS `selfBytes`, in bytes.
  total: number
}

// One process as reported by `ps`, enriched with data only the kernel has.
export interface ProcRecord {
  pid: number
  ppid: number
  // Session id (getsid). -1 when unknown (ffi unavailable or process gone).
  sid: number
  // Memory as macOS accounts it (phys_footprint: resident + compressed +
  // iokit), falling back to RSS where that's unavailable. In bytes.
  bytes: number
  // Process start stamp (mach absolute time); 0 when unknown. Only ever
  // compared for equality, to tell a live pid apart from a recycled one.
  startedAt: number
}

// A PTY session treemux started and has since closed. Its leader is gone but
// descendants it spawned may still be alive, reparented to launchd, holding
// the same sid — so we keep charging them to the worktree that started them.
export interface ClosedSession {
  sid: number
  // The leader's start stamp, captured while it was alive. Guards against a
  // recycled pid dragging an unrelated session into this worktree's total.
  startedAt: number
}

export interface WorktreeRoots {
  // pid of the PTY leader that's running right now, or null if the terminal
  // has been closed. Doubles as the session id (node-pty calls setsid).
  livePid: number | null
  closed: readonly ClosedSession[]
}

// Pure core: given the full process table and each worktree's PTY sessions,
// attribute memory to each worktree and to treemux itself.
//
// Each worktree's PTY is spawned via node-pty, which calls setsid(), so the
// PTY-leader pid IS a session id. Every descendant inherits that sid and KEEPS
// it even after being reparented to launchd/init (which is what happens when a
// `bash -c "..."` exits but leaves a `tsc`/`node` worker running). Grouping by
// sid therefore catches those detached hogs, which a ppid-only tree walk misses
// entirely. We still union in the ppid subtree as a safety net so we never
// count *less* than the old behavior on a platform where sid is unavailable.
export function computeMemory(
  procs: readonly ProcRecord[],
  rootsByWorktree: ReadonlyMap<string, WorktreeRoots>,
  selfPid = 0,
): MemorySample {
  const perWorktree = new Map<string, number>()
  const subprocByWorktree = new Map<string, number>()

  const byPid = new Map<number, ProcRecord>()
  const childrenOf = new Map<number, number[]>()
  const bySid = new Map<number, number[]>()
  for (const p of procs) {
    byPid.set(p.pid, p)
    const kids = childrenOf.get(p.ppid)
    if (kids) kids.push(p.pid)
    else childrenOf.set(p.ppid, [p.pid])
    if (p.sid >= 0) {
      const sibs = bySid.get(p.sid)
      if (sibs) sibs.push(p.pid)
      else bySid.set(p.sid, [p.pid])
    }
  }

  // Everything under session leader `root`: session members (survives
  // reparenting) unioned with the ppid subtree (safety net; also covers the
  // root itself even when sid is unavailable).
  const collectSession = (root: number, into: Set<number>) => {
    const session = bySid.get(root)
    if (session) for (const pid of session) into.add(pid)
    const stack = [root]
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (into.has(pid) && pid !== root) continue
      into.add(pid)
      const kids = childrenOf.get(pid)
      if (kids) for (const k of kids) if (!into.has(k)) stack.push(k)
    }
  }

  // A closed session's leader pid is free for the kernel to hand out again. If
  // something is living under that pid now, only count the session when we can
  // prove it's the same process we started; otherwise a recycled pid would drag
  // a stranger's whole session into this worktree's total.
  const isRecycled = (closed: ClosedSession) => {
    const current = byPid.get(closed.sid)
    if (!current) return false // leader gone; orphans still carry its sid
    return closed.startedAt === 0 || current.startedAt !== closed.startedAt
  }

  const claimed = new Set<number>()
  let total = 0

  for (const [wtId, roots] of rootsByWorktree) {
    const pids = new Set<number>()
    if (roots.livePid !== null) collectSession(roots.livePid, pids)
    for (const closed of roots.closed) {
      if (closed.sid === roots.livePid) continue
      if (isRecycled(closed)) continue
      collectSession(closed.sid, pids)
    }

    let sum = 0
    for (const pid of pids) {
      sum += byPid.get(pid)?.bytes ?? 0
      claimed.add(pid)
    }
    const leaderBytes = roots.livePid !== null ? byPid.get(roots.livePid)?.bytes ?? 0 : 0
    perWorktree.set(wtId, sum)
    subprocByWorktree.set(wtId, Math.max(0, sum - leaderBytes))
    total += sum
  }

  // treemux itself. Walk our own ppid subtree but stop at anything already
  // charged to a worktree — PTY leaders are our direct children, so without
  // that guard the whole tree would be counted twice.
  let selfBytes = 0
  if (selfPid > 0) {
    const seen = new Set<number>()
    const stack = [selfPid]
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (seen.has(pid) || claimed.has(pid)) continue
      seen.add(pid)
      selfBytes += byPid.get(pid)?.bytes ?? 0
      const kids = childrenOf.get(pid)
      if (kids) for (const k of kids) stack.push(k)
    }
    total += selfBytes
  }

  return { perWorktree, subprocByWorktree, selfBytes, total }
}

export async function sampleMemory(
  rootsByWorktree: ReadonlyMap<string, WorktreeRoots>,
): Promise<MemorySample> {
  const empty = (): MemorySample => ({
    perWorktree: new Map(),
    subprocByWorktree: new Map(),
    selfBytes: 0,
    total: 0,
  })

  const stdout = await runPs()
  if (!stdout) return empty()

  const libc = loadLibc()
  const procs: ProcRecord[] = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = parseInt(parts[0]!, 10)
    const ppid = parseInt(parts[1]!, 10)
    const rssKb = parseInt(parts[2]!, 10)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue
    // getsid returns -1 (and sets errno) if the process exited between `ps` and now.
    const sid = libc ? libc.getsid(pid) : -1
    const usage = libc?.rusage?.(pid)
    procs.push({
      pid,
      ppid,
      sid,
      bytes: usage ? usage.footprint : rssKb * 1024,
      startedAt: usage?.startedAt ?? 0,
    })
  }

  return computeMemory(procs, rootsByWorktree, process.pid)
}

// Start stamp for a live process, for pinning a pid to a specific incarnation.
// 0 when unavailable (non-darwin, or the process is already gone).
export function processStartedAt(pid: number): number {
  return loadLibc()?.rusage?.(pid)?.startedAt ?? 0
}

interface Libc {
  getsid: (pid: number) => number
  // Only bound on darwin; RSS from `ps` is the fallback everywhere else.
  rusage?: (pid: number) => { footprint: number; startedAt: number } | null
}

// struct rusage_info_v0: uint8_t ri_uuid[16] followed by 10 uint64s. As
// uint64 indices that puts ri_phys_footprint at 9 and ri_proc_start_abstime
// at 10. Module-level so the buffer isn't reallocated (or collected) per call.
const RUSAGE_INFO_V0 = 0
const RI_PHYS_FOOTPRINT = 9
const RI_PROC_START_ABSTIME = 10
const rusageBuf = new BigUint64Array(12)
const rusageBufPtr = ptr(rusageBuf)

// Lazily dlopen libc. Cached across calls; null if ffi is unavailable, in
// which case computeMemory falls back to the ppid subtree and to RSS.
let libcRef: Libc | null | undefined
function loadLibc(): Libc | null {
  if (libcRef !== undefined) return libcRef
  try {
    if (process.platform !== "darwin") {
      const lib = dlopen("libc.so.6", { getsid: { args: [FFIType.i32], returns: FFIType.i32 } })
      libcRef = { getsid: (pid: number) => lib.symbols.getsid(pid) as number }
      return libcRef
    }
    const lib = dlopen("libSystem.B.dylib", {
      getsid: { args: [FFIType.i32], returns: FFIType.i32 },
      // int proc_pid_rusage(int pid, int flavor, rusage_info_t *buffer)
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    })
    libcRef = {
      getsid: (pid: number) => lib.symbols.getsid(pid) as number,
      // `ps` reports RSS: resident pages only. macOS pushes idle pages into
      // the compressor under pressure, which drops RSS to a fraction of what
      // the process actually holds against "application memory" — i.e. the
      // readout collapses exactly when the machine is filling up.
      // phys_footprint is what Activity Monitor and the Force Quit dialog
      // show, so use that instead.
      rusage: (pid: number) => {
        rusageBuf.fill(0n)
        const rc = lib.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V0, rusageBufPtr) as number
        if (rc !== 0) return null
        return {
          footprint: Number(rusageBuf[RI_PHYS_FOOTPRINT]!),
          startedAt: Number(rusageBuf[RI_PROC_START_ABSTIME]!),
        }
      },
    }
  } catch {
    libcRef = null
  }
  return libcRef
}

function runPs(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn("ps", ["-A", "-o", "pid=,ppid=,rss="], { stdio: ["ignore", "pipe", "ignore"] })
      let out = ""
      child.stdout.on("data", (d) => { out += d.toString("utf8") })
      child.on("error", () => resolve(null))
      child.on("close", (code) => resolve(code === 0 ? out : null))
    } catch {
      resolve(null)
    }
  })
}

export function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "—"
  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024
  if (b >= GB) return `${(b / GB).toFixed(1)}GB`
  if (b >= MB) return `${Math.round(b / MB)}MB`
  if (b >= KB) return `${Math.round(b / KB)}KB`
  return `${b}B`
}
