import { Context, Effect, Layer } from "effect"
import { nanoid } from "nanoid"
import { Project, type CommandType } from "../models/Config.js"
import {
  ConfigReadError,
  ConfigWriteError,
  ProjectNotFoundError,
} from "../models/Errors.js"
import { ConfigService } from "./ConfigService.js"

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

      remove: (projectId) =>
        Effect.gen(function* () {
          const cfg = yield* config.load
          if (!cfg.projects.some((p) => p.id === projectId)) {
            return yield* new ProjectNotFoundError({ projectId })
          }
          yield* config.update((c) => ({
            ...c,
            projects: c.projects.filter((p) => p.id !== projectId),
            worktrees: c.worktrees.filter((w) => w.projectId !== projectId),
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
