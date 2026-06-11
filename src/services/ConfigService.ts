import { Context, Effect, Layer } from "effect"
import { TreemuxConfig, Project, WorktreeEntry } from "../models/Config.js"
import { ConfigReadError, ConfigWriteError } from "../models/Errors.js"
import { DatabaseService } from "./DatabaseService.js"

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<TreemuxConfig, ConfigReadError>
    readonly save: (config: TreemuxConfig) => Effect.Effect<void, ConfigWriteError>
    readonly update: (
      fn: (config: TreemuxConfig) => TreemuxConfig
    ) => Effect.Effect<TreemuxConfig, ConfigReadError | ConfigWriteError>
  }
>() {}

interface ProjectRow {
  id: string
  name: string
  repo_path: string
  setup_script: string
  default_command: string
  custom_command: string | null
  pr_instructions: string | null
  created_at: string
  updated_at: string
}

interface WorktreeRow {
  id: string
  project_id: string
  branch_name: string
  path: string
  display_name: string
  description: string
  status: string
  sort_order: number | null
  created_at: string
  updated_at: string
}

const rowToProject = (row: ProjectRow): Project =>
  new Project({
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    setupScript: JSON.parse(row.setup_script) as string[],
    defaultCommand: row.default_command as "claude" | "codex" | "opencode" | "custom",
    customCommand: row.custom_command ?? undefined,
    prInstructions: row.pr_instructions ?? undefined,
  })

const rowToWorktree = (row: WorktreeRow): WorktreeEntry =>
  new WorktreeEntry({
    id: row.id,
    projectId: row.project_id,
    branchName: row.branch_name,
    path: row.path,
    displayName: row.display_name,
    description: row.description,
    status: row.status as "active" | "merged" | "archived",
    sortOrder: row.sort_order ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    const { db } = yield* DatabaseService

    const loadConfig = (): TreemuxConfig => {
      const projects = db.query("SELECT * FROM projects ORDER BY name").all() as ProjectRow[]
      const worktrees = db
        .query("SELECT * FROM worktrees ORDER BY created_at DESC")
        .all() as WorktreeRow[]
      return new TreemuxConfig({
        projects: projects.map(rowToProject),
        worktrees: worktrees.map(rowToWorktree),
      })
    }

    const saveConfig = (config: TreemuxConfig) => {
      const tx = db.transaction(() => {
        db.exec("DELETE FROM worktrees")
        db.exec("DELETE FROM projects")

        const insertProject = db.prepare(`
          INSERT INTO projects (id, name, repo_path, setup_script, default_command, custom_command, pr_instructions)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        for (const p of config.projects) {
          insertProject.run(
            p.id,
            p.name,
            p.repoPath,
            JSON.stringify(p.setupScript),
            p.defaultCommand,
            p.customCommand ?? null,
            p.prInstructions ?? null
          )
        }

        const insertWorktree = db.prepare(`
          INSERT INTO worktrees (id, project_id, branch_name, path, display_name, description, status, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const w of config.worktrees) {
          insertWorktree.run(
            w.id,
            w.projectId,
            w.branchName,
            w.path,
            w.displayName,
            w.description,
            w.status,
            w.sortOrder ?? null,
            w.createdAt,
            w.updatedAt
          )
        }
      })
      tx()
    }

    return {
      load: Effect.try({
        try: () => loadConfig(),
        catch: (e) =>
          new ConfigReadError({
            message: `Failed to load config from DB: ${e}`,
            path: "treemux.db",
          }),
      }),

      save: (config: TreemuxConfig) =>
        Effect.try({
          try: () => saveConfig(config),
          catch: (e) =>
            new ConfigWriteError({
              message: `Failed to save config to DB: ${e}`,
              path: "treemux.db",
            }),
        }),

      update: (fn: (config: TreemuxConfig) => TreemuxConfig) =>
        Effect.try({
          try: () => {
            const current = loadConfig()
            const updated = fn(current)
            saveConfig(updated)
            return updated
          },
          catch: (e) =>
            new ConfigReadError({
              message: `Failed to update config in DB: ${e}`,
              path: "treemux.db",
            }),
        }),
    }
  })
)
