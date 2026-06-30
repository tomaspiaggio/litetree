import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Project, TreemuxConfig, WorktreeEntry } from "../../models/Config.js"
import { ConfigService, ConfigServiceLive } from "../ConfigService.js"
import { DatabaseServiceLive } from "../DatabaseService.js"
import { GitServiceLive } from "../GitService.js"
import { ProjectService, ProjectServiceLive } from "../ProjectService.js"
import { WorktreeService, WorktreeServiceLive } from "../WorktreeService.js"

// Real layer stack, pointed at a throwaway DB per test via TREEMUX_DB_PATH.
// Worktree paths below don't exist on disk; GitService.removeWorktree failures
// are swallowed by the services, so the record-level behaviour is what's tested.
const ConfigLayer = ConfigServiceLive.pipe(Layer.provide(DatabaseServiceLive))
const Deps = Layer.mergeAll(ConfigLayer, GitServiceLive)
const TestLayer = Layer.mergeAll(
  ConfigLayer,
  WorktreeServiceLive.pipe(Layer.provide(Deps)),
  ProjectServiceLive.pipe(Layer.provide(Deps)),
)

const run = <A>(
  program: Effect.Effect<A, unknown, ConfigService | WorktreeService | ProjectService>,
): Promise<A> =>
  Effect.runPromise(
    (program as Effect.Effect<A, never, ConfigService | WorktreeService | ProjectService>).pipe(
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

let counter = 0
let dbPath = ""

beforeEach(() => {
  dbPath = join(tmpdir(), `treemux-softdel-test-${process.pid}-${counter++}.db`)
  process.env.TREEMUX_DB_PATH = dbPath
})

afterEach(() => {
  delete process.env.TREEMUX_DB_PATH
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix)
    } catch {
      // file may not exist; ignore
    }
  }
})

const PROJECT = new Project({ id: "p1", name: "proj", repoPath: "/tmp/proj" })

const makeWt = (id: string, status: "active" | "archived"): WorktreeEntry =>
  new WorktreeEntry({
    id,
    projectId: PROJECT.id,
    branchName: `branch-${id}`,
    path: `/tmp/proj/${id}`,
    displayName: id,
    status,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  })

const seed = (worktrees: WorktreeEntry[]) =>
  Effect.gen(function* () {
    const config = yield* ConfigService
    yield* config.save(new TreemuxConfig({ projects: [PROJECT], worktrees }))
  })

const load = Effect.gen(function* () {
  const config = yield* ConfigService
  return yield* config.load
})

describe("project soft-deletion", () => {
  test("deleting a project with open worktrees soft-deletes it and frees the archived ones", async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const projectSvc = yield* ProjectService
        yield* seed([makeWt("open", "active"), makeWt("arch", "archived")])
        yield* projectSvc.remove(PROJECT.id)
        return yield* load
      }),
    )
    // Project record survives, marked deleted.
    expect(cfg.projects.map((p) => p.id)).toEqual(["p1"])
    expect(cfg.projects[0]!.deletedAt).toBeTruthy()
    // Open worktree kept; archived one dropped.
    expect(cfg.worktrees.map((w) => w.id)).toEqual(["open"])
  })

  test("deleting a project with no open worktrees removes it outright", async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const projectSvc = yield* ProjectService
        yield* seed([makeWt("arch1", "archived"), makeWt("arch2", "archived")])
        yield* projectSvc.remove(PROJECT.id)
        return yield* load
      }),
    )
    expect(cfg.projects).toEqual([])
    expect(cfg.worktrees).toEqual([])
  })

  test("archiving the last open worktree purges the soft-deleted project", async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const projectSvc = yield* ProjectService
        const wtSvc = yield* WorktreeService
        yield* seed([makeWt("open", "active")])
        yield* projectSvc.remove(PROJECT.id) // -> soft-deleted, "open" retained
        yield* wtSvc.archive("open") // last active closes -> purge
        return yield* load
      }),
    )
    expect(cfg.projects).toEqual([])
    expect(cfg.worktrees).toEqual([])
  })

  test("permanently removing the last open worktree purges the soft-deleted project", async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const projectSvc = yield* ProjectService
        const wtSvc = yield* WorktreeService
        yield* seed([makeWt("open", "active")])
        yield* projectSvc.remove(PROJECT.id)
        yield* wtSvc.remove("open")
        return yield* load
      }),
    )
    expect(cfg.projects).toEqual([])
    expect(cfg.worktrees).toEqual([])
  })

  test("a soft-deleted project with multiple open worktrees survives until the last closes", async () => {
    const cfg = await run(
      Effect.gen(function* () {
        const projectSvc = yield* ProjectService
        const wtSvc = yield* WorktreeService
        yield* seed([makeWt("a", "active"), makeWt("b", "active")])
        yield* projectSvc.remove(PROJECT.id)
        yield* wtSvc.remove("a")
        // One open worktree remains -> project still soft-deleted.
        const mid = yield* load
        expect(mid.projects[0]?.deletedAt).toBeTruthy()
        expect(mid.worktrees.map((w) => w.id)).toEqual(["b"])
        yield* wtSvc.archive("b")
        return yield* load
      }),
    )
    expect(cfg.projects).toEqual([])
    expect(cfg.worktrees).toEqual([])
  })
})
