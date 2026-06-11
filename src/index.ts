import { Effect, Layer } from "effect"
import { handleCli } from "./cli.js"
import { DatabaseServiceLive } from "./services/DatabaseService.js"
import { ConfigServiceLive } from "./services/ConfigService.js"
import { GitServiceLive } from "./services/GitService.js"
import { ProjectServiceLive } from "./services/ProjectService.js"
import { WorktreeServiceLive } from "./services/WorktreeService.js"
import { SetupServiceLive } from "./services/SetupService.js"
import { PtyServiceLive } from "./services/PtyService.js"
import { McpServiceLive } from "./services/McpService.js"
import { startApp } from "./app.js"

const args = process.argv.slice(2)

async function main() {
  const handled = await handleCli(args)
  if (handled) return

  const ConfigLayer = ConfigServiceLive.pipe(Layer.provide(DatabaseServiceLive))
  const BaseLayer = Layer.mergeAll(
    ConfigLayer,
    DatabaseServiceLive,
    GitServiceLive,
    SetupServiceLive,
    PtyServiceLive
  )
  const WorktreeLayer = WorktreeServiceLive.pipe(Layer.provide(BaseLayer))
  const ProjectLayer = ProjectServiceLive.pipe(Layer.provide(BaseLayer))
  // McpService shares the single DatabaseServiceLive instance (memoized by
  // reference across the merged graph, same as ConfigLayer does).
  const McpLayer = McpServiceLive.pipe(Layer.provide(DatabaseServiceLive))
  const MainLayer = Layer.mergeAll(BaseLayer, WorktreeLayer, ProjectLayer, McpLayer)

  await Effect.runPromise(startApp.pipe(Effect.provide(MainLayer), Effect.scoped))
}

main().catch((e) => {
  console.error("Fatal error:", e)
  process.exit(1)
})
