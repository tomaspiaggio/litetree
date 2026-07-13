import { describe, expect, test } from "bun:test"
import { computeMemory, type ProcRecord } from "./memory.js"

const KB = 1024

describe("computeMemory", () => {
  test("sums the ppid subtree and splits out the subprocess portion", () => {
    const procs: ProcRecord[] = [
      { pid: 100, ppid: 50, sid: 100, rssKb: 200 }, // agent (session leader)
      { pid: 200, ppid: 100, sid: 100, rssKb: 30 }, // bash spawned by agent
      { pid: 201, ppid: 200, sid: 100, rssKb: 70 }, // tool under that bash
    ]
    const s = computeMemory(procs, new Map([["w1", 100]]))
    expect(s.perWorktree.get("w1")).toBe(300 * KB)
    expect(s.subprocByWorktree.get("w1")).toBe(100 * KB) // 300 - 200 leader
    expect(s.total).toBe(300 * KB)
  })

  test("captures a REPARENTED subprocess via session id (the bug this fixes)", () => {
    const procs: ProcRecord[] = [
      { pid: 100, ppid: 50, sid: 100, rssKb: 200 },  // agent
      { pid: 200, ppid: 100, sid: 100, rssKb: 30 },  // still-connected child
      { pid: 300, ppid: 1, sid: 100, rssKb: 5000 },  // tsc worker reparented to launchd (ppid=1!)
      { pid: 999, ppid: 1, sid: 999, rssKb: 8000 },  // unrelated process, must NOT count
    ]
    const s = computeMemory(procs, new Map([["w1", 100]]))
    // A ppid-only walk would report 230KB and miss the 5000KB hog entirely.
    expect(s.perWorktree.get("w1")).toBe(5230 * KB)
    expect(s.subprocByWorktree.get("w1")).toBe(5030 * KB)
    expect(s.total).toBe(5230 * KB)
  })

  test("keeps sessions disjoint across worktrees (no double counting)", () => {
    const procs: ProcRecord[] = [
      { pid: 100, ppid: 50, sid: 100, rssKb: 200 },
      { pid: 101, ppid: 100, sid: 100, rssKb: 100 },
      { pid: 500, ppid: 50, sid: 500, rssKb: 300 },
      { pid: 501, ppid: 1, sid: 500, rssKb: 400 }, // reparented, belongs to w2
    ]
    const s = computeMemory(procs, new Map([["w1", 100], ["w2", 500]]))
    expect(s.perWorktree.get("w1")).toBe(300 * KB)
    expect(s.perWorktree.get("w2")).toBe(700 * KB)
    expect(s.total).toBe(1000 * KB)
  })

  test("reports zero subprocess memory when the agent spawned nothing", () => {
    const procs: ProcRecord[] = [{ pid: 100, ppid: 50, sid: 100, rssKb: 200 }]
    const s = computeMemory(procs, new Map([["w1", 100]]))
    expect(s.perWorktree.get("w1")).toBe(200 * KB)
    expect(s.subprocByWorktree.get("w1")).toBe(0)
  })

  test("falls back to the ppid subtree when sid is unavailable (-1)", () => {
    const procs: ProcRecord[] = [
      { pid: 100, ppid: 50, sid: -1, rssKb: 200 },
      { pid: 200, ppid: 100, sid: -1, rssKb: 50 }, // reachable via ppid
      { pid: 300, ppid: 1, sid: -1, rssKb: 999 },  // reparented + no sid → unreachable, excluded
    ]
    const s = computeMemory(procs, new Map([["w1", 100]]))
    expect(s.perWorktree.get("w1")).toBe(250 * KB)
    expect(s.subprocByWorktree.get("w1")).toBe(50 * KB)
  })

  test("returns empty when no worktrees are tracked", () => {
    const s = computeMemory([{ pid: 1, ppid: 0, sid: 1, rssKb: 10 }], new Map())
    expect(s.total).toBe(0)
    expect(s.perWorktree.size).toBe(0)
  })

  test("handles a missing agent pid without crashing", () => {
    // Agent process gone between listing pids and sampling ps.
    const s = computeMemory([{ pid: 999, ppid: 1, sid: 999, rssKb: 10 }], new Map([["w1", 100]]))
    expect(s.perWorktree.get("w1")).toBe(0)
    expect(s.subprocByWorktree.get("w1")).toBe(0)
  })
})
