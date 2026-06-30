import { Context, Effect, Layer } from "effect"
import { nanoid } from "nanoid"
import { mkdir } from "node:fs/promises"
import { WorktreeEntry } from "../models/Config.js"
import {
  ConfigReadError,
  ConfigWriteError,
  GitError,
  ProjectNotFoundError,
  WorktreeCreateError,
  WorktreeDeleteError,
} from "../models/Errors.js"
import { paths } from "../utils/paths.js"
import { ConfigService } from "./ConfigService.js"
import { GitService } from "./GitService.js"

export class WorktreeService extends Context.Tag("WorktreeService")<
  WorktreeService,
  {
    readonly create: (params: {
      projectId: string
      branchName: string
      displayName?: string
      baseBranch?: string
      command?: string
      branchNameGenerated?: boolean
    }) => Effect.Effect<
      WorktreeEntry,
      | WorktreeCreateError
      | GitError
      | ConfigReadError
      | ConfigWriteError
      | ProjectNotFoundError
    >
    readonly remove: (
      worktreeId: string
    ) => Effect.Effect<
      void,
      WorktreeDeleteError | GitError | ConfigReadError | ConfigWriteError
    >
    readonly archive: (
      worktreeId: string
    ) => Effect.Effect<
      WorktreeEntry,
      WorktreeDeleteError | ConfigReadError | ConfigWriteError
    >
    readonly rename: (
      worktreeId: string,
      displayName: string
    ) => Effect.Effect<
      WorktreeEntry,
      WorktreeDeleteError | ConfigReadError | ConfigWriteError
    >
    readonly renameBranch: (
      worktreeId: string,
      branchName: string,
      displayName?: string
    ) => Effect.Effect<
      WorktreeEntry,
      WorktreeDeleteError | ConfigReadError | ConfigWriteError
    >
    readonly restore: (
      worktreeId: string
    ) => Effect.Effect<
      WorktreeEntry,
      WorktreeDeleteError | ConfigReadError | ConfigWriteError
    >
    readonly listArchived: (
      projectId?: string
    ) => Effect.Effect<readonly WorktreeEntry[], ConfigReadError>
    readonly list: (
      projectId?: string
    ) => Effect.Effect<readonly WorktreeEntry[], ConfigReadError>
    // Persist the sidebar order. `orderedIds` is the desired top-to-bottom
    // order of active worktrees; each id's position becomes its sort_order.
    readonly reorder: (
      orderedIds: readonly string[]
    ) => Effect.Effect<void, ConfigWriteError>
    readonly checkMerged: (
      worktreeId: string
    ) => Effect.Effect<boolean, GitError | ConfigReadError>
  }
>() {}

export const WorktreeServiceLive = Layer.effect(
  WorktreeService,
  Effect.gen(function* () {
    const config = yield* ConfigService
    const git = yield* GitService

    // A soft-deleted project (see ProjectService.remove) lingers only to keep
    // its still-open worktrees alive. Once the last active worktree of such a
    // project is archived or removed, there's nothing left to keep working — so
    // free any remaining (archived) worktrees from disk and purge the project
    // record along with all its worktree rows. No-op for live projects.
    const purgeOrphanedProject = (projectId: string) =>
      Effect.gen(function* () {
        const cfg = yield* config.load
        const project = cfg.projects.find((p) => p.id === projectId)
        if (!project || !project.deletedAt) return
        const worktrees = cfg.worktrees.filter((w) => w.projectId === projectId)
        if (worktrees.some((w) => w.status !== "archived")) return
        for (const wt of worktrees) {
          yield* git.removeWorktree(project.repoPath, wt.path).pipe(
            Effect.catchAll(() => Effect.void)
          )
        }
        yield* config.update((c) => ({
          ...c,
          projects: c.projects.filter((p) => p.id !== projectId),
          worktrees: c.worktrees.filter((w) => w.projectId !== projectId),
        }) as typeof c)
      })

    return {
      create: (params) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const project = cfg.projects.find((p) => p.id === params.projectId)
          if (!project) {
            return yield* new ProjectNotFoundError({ projectId: params.projectId })
          }
          const wtPath = paths.worktree(project.name, params.branchName)
          yield* Effect.tryPromise({
            try: () => mkdir(paths.worktrees, { recursive: true }),
            catch: (e) =>
              new WorktreeCreateError({
                message: `Failed to create worktrees dir: ${e}`,
                repoPath: project.repoPath,
                branch: params.branchName,
              }),
          })
          yield* git.fetch(project.repoPath).pipe(Effect.catchAll(() => Effect.void))
          yield* git.addWorktree(
            project.repoPath,
            wtPath,
            params.branchName,
            params.baseBranch ?? "origin/main"
          )
          const now = new Date().toISOString()
          const entry = new WorktreeEntry({
            id: nanoid(),
            projectId: params.projectId,
            branchName: params.branchName,
            path: wtPath,
            displayName: params.displayName ?? params.branchName,
            branchNameGenerated: params.branchNameGenerated ?? false,
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
          yield* config.update((c) =>
            new (c.constructor as typeof import("../models/Config.js").TreemuxConfig)({
              ...c,
              worktrees: [entry, ...c.worktrees],
            })
          )
          return entry
        }),

      remove: (worktreeId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const wt = cfg.worktrees.find((w) => w.id === worktreeId)
          if (!wt) {
            return yield* new WorktreeDeleteError({
              message: `Worktree not found: ${worktreeId}`,
              worktreeId,
            })
          }
          const project = cfg.projects.find((p) => p.id === wt.projectId)
          if (project) {
            yield* git.removeWorktree(project.repoPath, wt.path).pipe(
              Effect.catchAll(() => Effect.void)
            )
          }
          yield* config.update((c) => ({
            ...c,
            worktrees: c.worktrees.filter((w) => w.id !== worktreeId),
          }) as typeof c)
          yield* purgeOrphanedProject(wt.projectId)
        }),

      archive: (worktreeId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const wt = cfg.worktrees.find((w) => w.id === worktreeId)
          if (!wt) {
            return yield* new WorktreeDeleteError({
              message: `Worktree not found: ${worktreeId}`,
              worktreeId,
            })
          }
          const updated = new WorktreeEntry({
            ...wt,
            status: "archived",
            updatedAt: new Date().toISOString(),
          })
          yield* config.update((c) => ({
            ...c,
            worktrees: c.worktrees.map((w) => (w.id === worktreeId ? updated : w)),
          }) as typeof c)
          yield* purgeOrphanedProject(wt.projectId)
          return updated
        }),

      restore: (worktreeId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const wt = cfg.worktrees.find((w) => w.id === worktreeId)
          if (!wt) {
            return yield* new WorktreeDeleteError({
              message: `Worktree not found: ${worktreeId}`,
              worktreeId,
            })
          }
          const updated = new WorktreeEntry({
            ...wt,
            status: "active",
            updatedAt: new Date().toISOString(),
          })
          yield* config.update((c) => ({
            ...c,
            worktrees: c.worktrees.map((w) => (w.id === worktreeId ? updated : w)),
          }) as typeof c)
          return updated
        }),

      listArchived: (projectId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const worktrees = projectId
            ? cfg.worktrees.filter((w) => w.projectId === projectId)
            : cfg.worktrees
          // Sort by archive time (updatedAt is stamped when archived) descending,
          // so the most recently deleted worktrees appear first.
          return worktrees
            .filter((w) => w.status === "archived")
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        }),

      rename: (worktreeId, displayName) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const wt = cfg.worktrees.find((w) => w.id === worktreeId)
          if (!wt) {
            return yield* new WorktreeDeleteError({
              message: `Worktree not found: ${worktreeId}`,
              worktreeId,
            })
          }
          const updated = new WorktreeEntry({
            ...wt,
            displayName,
            // The user gave it a real name; stop nudging agents to rename.
            branchNameGenerated: false,
            updatedAt: new Date().toISOString(),
          })
          yield* config.update((c) => ({
            ...c,
            worktrees: c.worktrees.map((w) => (w.id === worktreeId ? updated : w)),
          }) as typeof c)
          return updated
        }),

      // Agent renamed the git branch. Update branchName and, separately, the
      // sidebar label: prefer an explicit short displayName when the agent
      // supplied one, otherwise fall back to mirroring the branch name (only if
      // the label still tracked the old branch). DO NOT touch path — the
      // on-disk worktree directory is derived from the original branch and does
      // not move when the branch is renamed.
      renameBranch: (worktreeId, branchName, displayName) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const wt = cfg.worktrees.find((w) => w.id === worktreeId)
          if (!wt) {
            return yield* new WorktreeDeleteError({
              message: `Worktree not found: ${worktreeId}`,
              worktreeId,
            })
          }
          const label = displayName?.trim()
          const updated = new WorktreeEntry({
            ...wt,
            branchName,
            displayName: label && label.length > 0
              ? label
              : wt.displayName === wt.branchName ? branchName : wt.displayName,
            // The branch now has a real name.
            branchNameGenerated: false,
            updatedAt: new Date().toISOString(),
          })
          yield* config.update((c) => ({
            ...c,
            worktrees: c.worktrees.map((w) => (w.id === worktreeId ? updated : w)),
          }) as typeof c)
          return updated
        }),

      list: (projectId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const worktrees = projectId
            ? cfg.worktrees.filter((w) => w.projectId === projectId)
            : cfg.worktrees
          return worktrees.filter((w) => w.status !== "archived")
        }),

      reorder: (orderedIds) => config.saveOrder(orderedIds),

      checkMerged: (worktreeId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const wt = cfg.worktrees.find((w) => w.id === worktreeId)
          if (!wt) return false
          const project = cfg.projects.find((p) => p.id === wt.projectId)
          if (!project) return false
          return yield* git.isBranchMerged(project.repoPath, wt.branchName)
        }),
    }
  })
)
