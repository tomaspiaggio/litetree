import { Effect, Layer } from "effect"
import { DatabaseServiceLive } from "./services/DatabaseService.js"
import { ConfigServiceLive } from "./services/ConfigService.js"
import { ProjectServiceLive } from "./services/ProjectService.js"
import { ProjectService } from "./services/ProjectService.js"
import type { CommandType } from "./models/Config.js"

const ConfigLayer = ConfigServiceLive.pipe(Layer.provide(DatabaseServiceLive))
const BaseLayer = Layer.merge(ConfigLayer, DatabaseServiceLive)
const FullLayer = ProjectServiceLive.pipe(Layer.provide(BaseLayer), Layer.merge(BaseLayer))

export async function handleCli(args: string[]): Promise<boolean> {
  const [cmd, sub] = args

  if (cmd === "project") {
    if (sub === "add") {
      return runProjectAdd(args.slice(2))
    }
    if (sub === "list") {
      return runProjectList()
    }
    if (sub === "remove") {
      return runProjectRemove(args.slice(2))
    }
    console.log("Usage: treemux project <add|list|remove>")
    return true
  }

  return false
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith("--")) {
        flags[key] = value
        i++
      } else {
        flags[key] = "true"
      }
    }
  }
  return flags
}

async function runProjectAdd(args: string[]): Promise<boolean> {
  const flags = parseFlags(args)
  const name = flags["name"]
  const repo = flags["repo"]

  if (!name || !repo) {
    console.log('Usage: treemux project add --name <name> --repo <path> [--command claude|codex|opencode|custom] [--custom-command "cmd"] [--pr-instructions "..."] [--setup "cmd1" --setup "cmd2"]')
    return true
  }

  const command = (flags["command"] ?? "claude") as CommandType
  const customCommand = flags["custom-command"]
  const prInstructions = flags["pr-instructions"]
  const setupScripts: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--setup" && args[i + 1]) {
      setupScripts.push(args[i + 1]!)
    }
  }

  await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* ProjectService
      const project = yield* svc.add({
        name,
        repoPath: repo,
        setupScript: setupScripts,
        defaultCommand: command,
        customCommand,
        prInstructions,
      })
      console.log(`Project added: ${project.name} (${project.id})`)
      console.log(`  Repo: ${project.repoPath}`)
      console.log(`  Command: ${project.defaultCommand}`)
      if (setupScripts.length > 0) {
        console.log(`  Setup: ${setupScripts.join("; ")}`)
      }
    }).pipe(Effect.provide(FullLayer))
  )

  return true
}

async function runProjectList(): Promise<boolean> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* ProjectService
      const projects = yield* svc.list()
      if (projects.length === 0) {
        console.log("No projects registered. Add one with: treemux project add --name <name> --repo <path>")
        return
      }
      for (const p of projects) {
        console.log(`  ${p.name} (${p.id})`)
        console.log(`    Repo: ${p.repoPath}`)
        console.log(`    Command: ${p.defaultCommand}`)
        if (p.setupScript.length > 0) {
          console.log(`    Setup: ${p.setupScript.join("; ")}`)
        }
        if (p.prInstructions) {
          console.log(`    PR instructions: ${p.prInstructions}`)
        }
      }
    }).pipe(Effect.provide(FullLayer))
  )
  return true
}

async function runProjectRemove(args: string[]): Promise<boolean> {
  const id = args[0]
  if (!id) {
    console.log("Usage: treemux project remove <id>")
    return true
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* ProjectService
      yield* svc.remove(id)
      console.log(`Project removed: ${id}`)
    }).pipe(
      Effect.provide(FullLayer),
      Effect.catchAll((e) => {
        console.error(`Error: ${e}`)
        return Effect.void
      })
    )
  )
  return true
}
