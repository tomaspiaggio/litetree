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
      branchName: string
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
          return worktrees.filter((w) => w.status === "archived")
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
            updatedAt: new Date().toISOString(),
          })
          yield* config.update((c) => ({
            ...c,
            worktrees: c.worktrees.map((w) => (w.id === worktreeId ? updated : w)),
          }) as typeof c)
          return updated
        }),

      // Agent renamed the git branch. Update branchName (and displayName if it
      // still mirrored the old branch) but DO NOT touch path — the on-disk
      // worktree directory is derived from the original branch and does not
      // move when the branch is renamed.
      renameBranch: (worktreeId, branchName) =>
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
            branchName,
            displayName: wt.displayName === wt.branchName ? branchName : wt.displayName,
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
