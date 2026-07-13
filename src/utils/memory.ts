import { spawn } from "node:child_process"
import { dlopen, FFIType } from "bun:ffi"

export interface MemorySample {
  // Bytes of RSS per worktree (whole session: PTY leader + everything it spawned).
  perWorktree: Map<string, number>
  // Of `perWorktree`, the portion attributable to spawned subprocesses
  // (session total minus the session-leader/agent process itself).
  subprocByWorktree: Map<string, number>
  // Sum across every tracked worktree, in bytes.
  total: number
}

// One process as reported by `ps`, enriched with its session id.
export interface ProcRecord {
  pid: number
  ppid: number
  // Session id (getsid). -1 when unknown (ffi unavailable or process gone).
  sid: number
  // Resident set size, in kilobytes (as `ps` reports it).
  rssKb: number
}

// Pure core: given the full process table and the PTY-leader pid per worktree,
// attribute RSS to each worktree.
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
  ptyPidByWorktree: ReadonlyMap<string, number>,
): MemorySample {
  const perWorktree = new Map<string, number>()
  const subprocByWorktree = new Map<string, number>()
  let total = 0

  if (ptyPidByWorktree.size === 0) return { perWorktree, subprocByWorktree, total }

  const rssOf = new Map<number, number>()
  const childrenOf = new Map<number, number[]>()
  const bySid = new Map<number, number[]>()
  for (const p of procs) {
    rssOf.set(p.pid, p.rssKb)
    const kids = childrenOf.get(p.ppid)
    if (kids) kids.push(p.pid)
    else childrenOf.set(p.ppid, [p.pid])
    if (p.sid >= 0) {
      const sibs = bySid.get(p.sid)
      if (sibs) sibs.push(p.pid)
      else bySid.set(p.sid, [p.pid])
    }
  }

  for (const [wtId, rootPid] of ptyPidByWorktree) {
    const pids = new Set<number>()
    // Session members (survives reparenting).
    const session = bySid.get(rootPid)
    if (session) for (const pid of session) pids.add(pid)
    // ppid subtree (safety net; also covers the root even if sid was unknown).
    const stack = [rootPid]
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (pids.has(pid) && pid !== rootPid) continue
      pids.add(pid)
      const kids = childrenOf.get(pid)
      if (kids) for (const k of kids) if (!pids.has(k)) stack.push(k)
    }

    let sumKb = 0
    for (const pid of pids) sumKb += rssOf.get(pid) ?? 0
    const leaderKb = rssOf.get(rootPid) ?? 0
    const totalBytes = sumKb * 1024
    const subprocBytes = Math.max(0, sumKb - leaderKb) * 1024
    perWorktree.set(wtId, totalBytes)
    subprocByWorktree.set(wtId, subprocBytes)
    total += totalBytes
  }

  return { perWorktree, subprocByWorktree, total }
}

export async function sampleMemory(
  ptyPidByWorktree: ReadonlyMap<string, number>,
): Promise<MemorySample> {
  if (ptyPidByWorktree.size === 0) {
    return { perWorktree: new Map(), subprocByWorktree: new Map(), total: 0 }
  }

  const stdout = await runPs()
  if (!stdout) return { perWorktree: new Map(), subprocByWorktree: new Map(), total: 0 }

  const getsid = loadGetsid()
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
    const sid = getsid ? getsid(pid) : -1
    procs.push({ pid, ppid, sid, rssKb })
  }

  return computeMemory(procs, ptyPidByWorktree)
}

// Lazily dlopen libc and bind getsid(2). Cached across calls; null if ffi is
// unavailable, in which case computeMemory falls back to the ppid subtree.
let getsidFn: ((pid: number) => number) | null | undefined
function loadGetsid(): ((pid: number) => number) | null {
  if (getsidFn !== undefined) return getsidFn
  try {
    const path = process.platform === "darwin" ? "libc.dylib" : "libc.so.6"
    const lib = dlopen(path, { getsid: { args: [FFIType.i32], returns: FFIType.i32 } })
    getsidFn = (pid: number) => lib.symbols.getsid(pid) as number
  } catch {
    getsidFn = null
  }
  return getsidFn
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
