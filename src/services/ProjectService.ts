import { Context, Effect, Layer } from "effect"
import { nanoid } from "nanoid"
import { Project, type CommandType } from "../models/Config.js"
import {
  ConfigReadError,
  ConfigWriteError,
  ProjectNotFoundError,
} from "../models/Errors.js"
import { ConfigService } from "./ConfigService.js"
import { GitService } from "./GitService.js"

export class ProjectService extends Context.Tag("ProjectService")<
  ProjectService,
  {
    readonly add: (params: {
      name: string
      repoPath: string
      setupScript?: string[]
      defaultCommand?: CommandType
      customCommand?: string
      prInstructions?: string
    }) => Effect.Effect<Project, ConfigReadError | ConfigWriteError>
    readonly update: (
      projectId: string,
      params: {
        setupScript?: readonly string[]
        defaultCommand?: CommandType
        customCommand?: string
        prInstructions?: string
      }
    ) => Effect.Effect<Project, ConfigReadError | ConfigWriteError | ProjectNotFoundError>
    readonly remove: (
      projectId: string
    ) => Effect.Effect<void, ConfigReadError | ConfigWriteError | ProjectNotFoundError>
    readonly list: () => Effect.Effect<readonly Project[], ConfigReadError>
    readonly get: (
      projectId: string
    ) => Effect.Effect<Project, ConfigReadError | ProjectNotFoundError>
  }
>() {}

export const ProjectServiceLive = Layer.effect(
  ProjectService,
  Effect.gen(function* () {
    const config = yield* ConfigService
    const git = yield* GitService

    return {
      add: (params) =>
        Effect.gen(function* () {
          const project = new Project({
            id: nanoid(),
            name: params.name,
            repoPath: params.repoPath,
            setupScript: params.setupScript ?? [],
            defaultCommand: params.defaultCommand ?? "claude",
            customCommand: params.customCommand,
            prInstructions: params.prInstructions,
          })
          yield* config.update((c) => ({
            ...c,
            projects: [...c.projects, project],
          }) as typeof c)
          return project
        }),

      update: (projectId, params) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const current = cfg.projects.find((p) => p.id === projectId)
          if (!current) {
            return yield* new ProjectNotFoundError({ projectId })
          }
          const updated = new Project({
            id: current.id,
            name: current.name,
            repoPath: current.repoPath,
            setupScript: params.setupScript !== undefined ? [...params.setupScript] : [...current.setupScript],
            defaultCommand: params.defaultCommand ?? current.defaultCommand,
            customCommand: params.customCommand !== undefined ? params.customCommand : current.customCommand,
            prInstructions: params.prInstructions !== undefined ? params.prInstructions : current.prInstructions,
          })
          yield* config.update((c) => ({
            ...c,
            projects: c.projects.map((p) => (p.id === projectId ? updated : p)),
          }) as typeof c)
          return updated
        }),

      // Deleting a project frees the disk used by its archived worktrees but
      // never touches its still-open (active) worktrees — those may have a live
      // agent and uncommitted work. If any active worktrees remain, the project
      // is soft-deleted (record kept, hidden from the picker) so they keep
      // working; WorktreeService purges the record once the last one closes. If
      // none remain, the project is removed outright.
      remove: (projectId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const project = cfg.projects.find((p) => p.id === projectId)
          if (!project) {
            return yield* new ProjectNotFoundError({ projectId })
          }
          const worktrees = cfg.worktrees.filter((w) => w.projectId === projectId)
          const archived = worktrees.filter((w) => w.status === "archived")
          const hasActive = worktrees.some((w) => w.status !== "archived")

          // Free disk for every archived worktree. Best-effort, mirroring
          // WorktreeService.remove — git worktree commands can hang or fail and
          // shouldn't block the deletion.
          for (const wt of archived) {
            yield* git.removeWorktree(project.repoPath, wt.path).pipe(
              Effect.catchAll(() => Effect.void)
            )
          }

          if (!hasActive) {
            // Nothing open depends on this project — remove it outright.
            yield* config.update((c) => ({
              ...c,
              projects: c.projects.filter((p) => p.id !== projectId),
              worktrees: c.worktrees.filter((w) => w.projectId !== projectId),
            }) as typeof c)
            return
          }

          // Keep the project record (soft-deleted) so its open worktrees keep
          // working; drop only the archived worktree records we just cleaned up.
          const deleted = new Project({ ...project, deletedAt: new Date().toISOString() })
          yield* config.update((c) => ({
            ...c,
            projects: c.projects.map((p) => (p.id === projectId ? deleted : p)),
            worktrees: c.worktrees.filter(
              (w) => w.projectId !== projectId || w.status !== "archived"
            ),
          }) as typeof c)
        }),

      list: () =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          return cfg.projects
        }),

      get: (projectId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          const project = cfg.projects.find((p) => p.id === projectId)
          if (!project) {
            return yield* new ProjectNotFoundError({ projectId })
          }
          return project
        }),
    }
  })
)
