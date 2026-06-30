import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Project, TreemuxConfig, WorktreeEntry } from "../../models/Config.js"
import { ConfigService, ConfigServiceLive } from "../ConfigService.js"
import { DatabaseServiceLive } from "../DatabaseService.js"
import { GitServiceLive } from "../GitService.js"
import { WorktreeService, WorktreeServiceLive } from "../WorktreeService.js"

// Real layer stack, pointed at a throwaway DB per test via TREEMUX_DB_PATH.
const ConfigLayer = ConfigServiceLive.pipe(Layer.provide(DatabaseServiceLive))
const TestLayer = Layer.mergeAll(
  ConfigLayer,
  WorktreeServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigLayer, GitServiceLive))),
)

const run = <A>(
  program: Effect.Effect<A, unknown, ConfigService | WorktreeService>,
): Promise<A> =>
  Effect.runPromise(
    (program as Effect.Effect<A, never, ConfigService | WorktreeService>).pipe(
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

let counter = 0
let dbPath = ""

beforeEach(() => {
  dbPath = join(tmpdir(), `treemux-order-test-${process.pid}-${counter++}.db`)
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

// createdAt ordered t1 < t2 < t3 < t4 (ISO strings sort lexically = chronologically).
const makeWt = (
  id: string,
  createdAt: string,
  extra: Partial<{ sortOrder: number; status: "active" | "archived" }> = {},
): WorktreeEntry =>
  new WorktreeEntry({
    id,
    projectId: PROJECT.id,
    branchName: `branch-${id}`,
    path: `/tmp/proj/${id}`,
    displayName: id,
    createdAt,
    updatedAt: createdAt,
    ...(extra.sortOrder !== undefined ? { sortOrder: extra.sortOrder } : {}),
    ...(extra.status ? { status: extra.status } : {}),
  })

const seed = (worktrees: WorktreeEntry[]) =>
  Effect.gen(function* () {
    const config = yield* ConfigService
    yield* config.save(new TreemuxConfig({ projects: [PROJECT], worktrees }))
  })

const loadedIds = Effect.gen(function* () {
  const config = yield* ConfigService
  const cfg = yield* config.load
  return cfg.worktrees.map((w) => w.id)
})

describe("worktree sidebar ordering", () => {
  test("with no persisted order, falls back to newest-created first", async () => {
    const ids = await run(
      Effect.gen(function* () {
        yield* seed([
          makeWt("a", "2024-01-01T00:00:00.000Z"),
          makeWt("b", "2024-01-02T00:00:00.000Z"),
          makeWt("c", "2024-01-03T00:00:00.000Z"),
        ])
        return yield* loadedIds
      }),
    )
    expect(ids).toEqual(["c", "b", "a"])
  })

  test("saveOrder persists an explicit order that survives reload", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const config = yield* ConfigService
        yield* seed([
          makeWt("a", "2024-01-01T00:00:00.000Z"),
          makeWt("b", "2024-01-02T00:00:00.000Z"),
          makeWt("c", "2024-01-03T00:00:00.000Z"),
        ])
        // A custom order unrelated to creation time.
        yield* config.saveOrder(["b", "c", "a"])
        return yield* loadedIds
      }),
    )
    expect(ids).toEqual(["b", "c", "a"])
  })

  test("a newly created worktree (null sort_order) sorts to the top", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const config = yield* ConfigService
        yield* seed([
          makeWt("a", "2024-01-01T00:00:00.000Z"),
          makeWt("b", "2024-01-02T00:00:00.000Z"),
          makeWt("c", "2024-01-03T00:00:00.000Z"),
        ])
        yield* config.saveOrder(["a", "b", "c"])
        // Simulate a brand-new worktree added after ordering was established.
        yield* config.update((cfg) => ({
          ...cfg,
          worktrees: [...cfg.worktrees, makeWt("d", "2024-01-04T00:00:00.000Z")],
        }) as typeof cfg)
        return yield* loadedIds
      }),
    )
    // d has no sort_order yet, so it floats to the top; the rest keep their order.
    expect(ids).toEqual(["d", "a", "b", "c"])
  })

  test("saveConfig round-trips sort_order so unrelated updates don't lose it", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const config = yield* ConfigService
        yield* seed([
          makeWt("a", "2024-01-01T00:00:00.000Z"),
          makeWt("b", "2024-01-02T00:00:00.000Z"),
          makeWt("c", "2024-01-03T00:00:00.000Z"),
        ])
        yield* config.saveOrder(["c", "a", "b"])
        // An unrelated mutation (e.g. a rename) goes through a full save.
        yield* config.update((cfg) => ({
          ...cfg,
          worktrees: cfg.worktrees.map((w) =>
            w.id === "a" ? new WorktreeEntry({ ...w, displayName: "renamed" }) : w,
          ),
        }) as typeof cfg)
        return yield* loadedIds
      }),
    )
    expect(ids).toEqual(["c", "a", "b"])
  })

  test("saveOrder only touches the ids it is given", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const config = yield* ConfigService
        yield* seed([
          makeWt("a", "2024-01-01T00:00:00.000Z", { sortOrder: 0 }),
          makeWt("b", "2024-01-02T00:00:00.000Z", { sortOrder: 1 }),
          makeWt("c", "2024-01-03T00:00:00.000Z", { sortOrder: 2 }),
        ])
        // Only reorder a and c; b keeps its existing sort_order (1).
        yield* config.saveOrder(["c", "a"])
        return yield* loadedIds
      }),
    )
    // c -> 0, a -> 1, b stays at 1; ties (a, b both 1) break by created_at DESC -> b before a.
    expect(ids).toEqual(["c", "b", "a"])
  })

  test("WorktreeService.reorder + list honour order and exclude archived", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const config = yield* ConfigService
        const wt = yield* WorktreeService
        yield* seed([
          makeWt("a", "2024-01-01T00:00:00.000Z"),
          makeWt("b", "2024-01-02T00:00:00.000Z"),
          makeWt("c", "2024-01-03T00:00:00.000Z"),
          makeWt("z", "2024-01-04T00:00:00.000Z", { status: "archived" }),
        ])
        yield* wt.reorder(["b", "a", "c"])
        // Sanity: the config layer sees the same persisted order.
        const persisted = (yield* config.load).worktrees
          .filter((w) => w.status !== "archived")
          .map((w) => w.id)
        expect(persisted).toEqual(["b", "a", "c"])
        const list = yield* wt.list()
        return list.map((w) => w.id)
      }),
    )
    expect(ids).toEqual(["b", "a", "c"])
    expect(ids).not.toContain("z")
  })
})
