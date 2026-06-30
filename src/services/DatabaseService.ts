import { Context, Effect, Layer } from "effect"
import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { paths } from "../utils/paths.js"
import { ConfigWriteError } from "../models/Errors.js"

const DEFAULT_DB_PATH = paths.root + "/treemux.db"

// Tests (and other tooling) can point treemux at a throwaway database by
// setting TREEMUX_DB_PATH. Unset in normal use, so behaviour is unchanged.
const dbPath = () => process.env.TREEMUX_DB_PATH || DEFAULT_DB_PATH

export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly db: Database
  }
>() {}

export const DatabaseServiceLive = Layer.scoped(
  DatabaseService,
  Effect.gen(function* () {
    const path = dbPath()
    if (path !== ":memory:") {
      const dir = dirname(path)
      yield* Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true }),
        catch: (e) =>
          new ConfigWriteError({
            message: `Failed to create data dir: ${e}`,
            path: dir,
          }),
      })
    }

    const db = new Database(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 3000")

    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        repo_path TEXT NOT NULL,
        setup_script TEXT NOT NULL DEFAULT '[]',
        default_command TEXT NOT NULL DEFAULT 'claude',
        custom_command TEXT,
        pr_instructions TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    // Migration: add pr_instructions to projects created before it existed.
    const hasPrCol = db
      .query("SELECT COUNT(*) as n FROM pragma_table_info('projects') WHERE name = 'pr_instructions'")
      .get() as { n: number } | null
    if (hasPrCol && hasPrCol.n === 0) {
      db.exec("ALTER TABLE projects ADD COLUMN pr_instructions TEXT")
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        branch_name TEXT NOT NULL,
        path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        sort_order INTEGER,
        branch_name_generated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    // Migration: add branch_name_generated to worktrees tables that predate it.
    const hasBranchGenCol = db
      .query("SELECT COUNT(*) as n FROM pragma_table_info('worktrees') WHERE name = 'branch_name_generated'")
      .get() as { n: number } | null
    if (hasBranchGenCol && hasBranchGenCol.n === 0) {
      db.exec("ALTER TABLE worktrees ADD COLUMN branch_name_generated INTEGER NOT NULL DEFAULT 0")
    }

    // Migration: add sort_order to worktrees tables that predate persisted ordering.
    const hasSortOrderCol = db
      .query("SELECT COUNT(*) as n FROM pragma_table_info('worktrees') WHERE name = 'sort_order'")
      .get() as { n: number } | null
    if (hasSortOrderCol && hasSortOrderCol.n === 0) {
      db.exec("ALTER TABLE worktrees ADD COLUMN sort_order INTEGER")
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id)
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status)
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    // Migration: drop old worktree_locks without pty_pid column
    const hasCol = db.query("SELECT COUNT(*) as n FROM pragma_table_info('worktree_locks') WHERE name = 'pty_pid'").get() as { n: number } | null
    if (hasCol && hasCol.n === 0) db.exec("DROP TABLE IF EXISTS worktree_locks")

    db.exec(`
      CREATE TABLE IF NOT EXISTS worktree_locks (
        worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
        pid INTEGER NOT NULL,
        pty_pid INTEGER NOT NULL DEFAULT 0,
        locked_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        db.close()
      })
    )

    return { db }
  })
)
