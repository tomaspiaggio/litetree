import { describe, expect, test } from "bun:test"
import { computeMemory, type ProcRecord, type WorktreeRoots } from "./memory.js"

const KB = 1024

// Terse ProcRecord builder — every test cares about pid/ppid/sid/bytes, and
// only the pid-reuse tests care about startedAt.
function proc(pid: number, ppid: number, sid: number, kb: number, startedAt = 0): ProcRecord {
  return { pid, ppid, sid, bytes: kb * KB, startedAt }
}

function live(pid: number): Map<string, WorktreeRoots> {
  return new Map([["w1", { livePid: pid, closed: [] }]])
}

describe("computeMemory", () => {
  test("sums the ppid subtree and splits out the subprocess portion", () => {
    const procs = [
      proc(100, 50, 100, 200), // agent (session leader)
      proc(200, 100, 100, 30), // bash spawned by agent
      proc(201, 200, 100, 70), // tool under that bash
    ]
    const s = computeMemory(procs, live(100))
    expect(s.perWorktree.get("w1")).toBe(300 * KB)
    expect(s.subprocByWorktree.get("w1")).toBe(100 * KB) // 300 - 200 leader
    expect(s.total).toBe(300 * KB)
  })

  test("captures a REPARENTED subprocess via session id", () => {
    const procs = [
      proc(100, 50, 100, 200),  // agent
      proc(200, 100, 100, 30),  // still-connected child
      proc(300, 1, 100, 5000),  // tsc worker reparented to launchd (ppid=1!)
      proc(999, 1, 999, 8000),  // unrelated process, must NOT count
    ]
    const s = computeMemory(procs, live(100))
    // A ppid-only walk would report 230KB and miss the 5000KB hog entirely.
    expect(s.perWorktree.get("w1")).toBe(5230 * KB)
    expect(s.subprocByWorktree.get("w1")).toBe(5030 * KB)
    expect(s.total).toBe(5230 * KB)
  })

  test("keeps sessions disjoint across worktrees (no double counting)", () => {
    const procs = [
      proc(100, 50, 100, 200),
      proc(101, 100, 100, 100),
      proc(500, 50, 500, 300),
      proc(501, 1, 500, 400), // reparented, belongs to w2
    ]
    const roots = new Map<string, WorktreeRoots>([
      ["w1", { livePid: 100, closed: [] }],
      ["w2", { livePid: 500, closed: [] }],
    ])
    const s = computeMemory(procs, roots)
    expect(s.perWorktree.get("w1")).toBe(300 * KB)
    expect(s.perWorktree.get("w2")).toBe(700 * KB)
    expect(s.total).toBe(1000 * KB)
  })

  test("reports zero subprocess memory when the agent spawned nothing", () => {
    const s = computeMemory([proc(100, 50, 100, 200)], live(100))
    expect(s.perWorktree.get("w1")).toBe(200 * KB)
    expect(s.subprocByWorktree.get("w1")).toBe(0)
  })

  test("falls back to the ppid subtree when sid is unavailable (-1)", () => {
    const procs = [
      proc(100, 50, -1, 200),
      proc(200, 100, -1, 50), // reachable via ppid
      proc(300, 1, -1, 999),  // reparented + no sid → unreachable, excluded
    ]
    const s = computeMemory(procs, live(100))
    expect(s.perWorktree.get("w1")).toBe(250 * KB)
    expect(s.subprocByWorktree.get("w1")).toBe(50 * KB)
  })

  test("returns empty when no worktrees are tracked", () => {
    const s = computeMemory([proc(1, 0, 1, 10)], new Map())
    expect(s.total).toBe(0)
    expect(s.perWorktree.size).toBe(0)
  })

  test("handles a missing agent pid without crashing", () => {
    // Agent process gone between listing pids and sampling ps.
    const s = computeMemory([proc(999, 1, 999, 10)], live(100))
    expect(s.perWorktree.get("w1")).toBe(0)
    expect(s.subprocByWorktree.get("w1")).toBe(0)
  })

  describe("sessions that outlive the terminal", () => {
    test("still charges orphans of a CLOSED session to their worktree", () => {
      const procs = [
        // Leader 100 is gone; the dev server it started is now under launchd.
        proc(300, 1, 100, 4000),
        proc(999, 1, 999, 8000), // unrelated, must NOT count
      ]
      const roots = new Map<string, WorktreeRoots>([
        ["w1", { livePid: null, closed: [{ sid: 100, startedAt: 7 }] }],
      ])
      const s = computeMemory(procs, roots)
      expect(s.perWorktree.get("w1")).toBe(4000 * KB)
      // No live leader, so all of it is subprocess memory.
      expect(s.subprocByWorktree.get("w1")).toBe(4000 * KB)
    })

    test("adds a closed session's orphans to the reopened session's total", () => {
      const procs = [
        proc(700, 50, 700, 100),  // freshly reopened agent
        proc(300, 1, 100, 4000),  // orphan from the previous session
      ]
      const roots = new Map<string, WorktreeRoots>([
        ["w1", { livePid: 700, closed: [{ sid: 100, startedAt: 7 }, { sid: 700, startedAt: 9 }] }],
      ])
      const s = computeMemory(procs, roots)
      expect(s.perWorktree.get("w1")).toBe(4100 * KB)
      expect(s.subprocByWorktree.get("w1")).toBe(4000 * KB)
    })

    test("ignores a closed session whose pid was RECYCLED by a stranger", () => {
      const procs = [
        proc(100, 1, 100, 6000, 42), // pid 100 reused; different start stamp
        proc(300, 100, 100, 500, 43),
      ]
      const roots = new Map<string, WorktreeRoots>([
        ["w1", { livePid: null, closed: [{ sid: 100, startedAt: 7 }] }],
      ])
      const s = computeMemory(procs, roots)
      expect(s.perWorktree.get("w1")).toBe(0)
      expect(s.total).toBe(0)
    })

    test("keeps counting a leader that survived the kill (same start stamp)", () => {
      const procs = [proc(100, 1, 100, 6000, 7)]
      const roots = new Map<string, WorktreeRoots>([
        ["w1", { livePid: null, closed: [{ sid: 100, startedAt: 7 }] }],
      ])
      const s = computeMemory(procs, roots)
      expect(s.perWorktree.get("w1")).toBe(6000 * KB)
    })

    test("skips a live-pid session we cannot pin to a start stamp", () => {
      // startedAt 0 means the platform gave us nothing to compare, so we can't
      // rule out pid reuse — better to undercount than to blame a stranger.
      const procs = [proc(100, 1, 100, 6000, 0)]
      const roots = new Map<string, WorktreeRoots>([
        ["w1", { livePid: null, closed: [{ sid: 100, startedAt: 0 }] }],
      ])
      expect(computeMemory(procs, roots).perWorktree.get("w1")).toBe(0)
    })
  })

  describe("treemux's own usage", () => {
    test("counts the tui subtree without double-counting worktree sessions", () => {
      const procs = [
        proc(10, 1, 5, 70),      // treemux itself
        proc(11, 10, 5, 30),     // a helper it spawned (ps, git, ...)
        proc(100, 10, 100, 200), // a PTY leader: our child, but w1's memory
        proc(101, 100, 100, 50),
      ]
      const s = computeMemory(procs, live(100), 10)
      expect(s.perWorktree.get("w1")).toBe(250 * KB)
      expect(s.selfBytes).toBe(100 * KB)
      expect(s.total).toBe(350 * KB)
    })

    test("reports the tui even when no worktree session is running", () => {
      const s = computeMemory([proc(10, 1, 5, 70)], new Map(), 10)
      expect(s.selfBytes).toBe(70 * KB)
      expect(s.total).toBe(70 * KB)
    })

    test("stays at zero when no self pid is given", () => {
      const s = computeMemory([proc(10, 1, 5, 70)], new Map())
      expect(s.selfBytes).toBe(0)
    })
  })
})
