import { Context, Effect, Layer } from "effect"
import { PtySpawnError } from "../models/Errors.js"
import * as fs from "node:fs"
import * as path from "node:path"
import { StringDecoder } from "node:string_decoder"

function resolveNodePtyNative(): { ptyNodePath: string; spawnHelperPath: string } | null {
  const platArch = `${process.platform}-${process.arch}`
  const candidates: string[] = []
  // Next to the compiled binary: bin/native/<plat>-<arch>/
  const execDir = path.dirname(process.execPath)
  candidates.push(path.join(execDir, "native", platArch))
  candidates.push(path.join(execDir, "..", "native", platArch))
  // Dev mode: original node_modules
  try {
    const pkg = require.resolve("node-pty/package.json")
    candidates.push(path.join(path.dirname(pkg), "prebuilds", platArch))
  } catch {}
  for (const dir of candidates) {
    const ptyNodePath = path.join(dir, "pty.node")
    const spawnHelperPath = path.join(dir, "spawn-helper")
    if (fs.existsSync(ptyNodePath) && fs.existsSync(spawnHelperPath)) {
      try {
        fs.chmodSync(spawnHelperPath, 0o755)
      } catch {}
      return { ptyNodePath, spawnHelperPath }
    }
  }
  return null
}


export interface PtyHandle {
  readonly worktreeId: string
  readonly terminal: import("@xterm/headless").Terminal
  readonly dirtyLines: Set<number>
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export class PtyService extends Context.Tag("PtyService")<
  PtyService,
  {
    readonly spawn: (params: {
      worktreeId: string
      command: string
      args?: string[]
      cols: number
      rows: number
      cwd: string
      env?: Record<string, string>
      onExit?: () => void
      onData?: () => void
    }) => Effect.Effect<PtyHandle, PtySpawnError>
    readonly get: (worktreeId: string) => PtyHandle | undefined
    readonly kill: (worktreeId: string) => Effect.Effect<void>
    readonly resize: (worktreeId: string, cols: number, rows: number) => void
    readonly listActive: () => readonly string[]
  }
>() {}

export const PtyServiceLive = Layer.effect(
  PtyService,
  Effect.gen(function* () {
    const handles = new Map<string, PtyHandle>()

    return {
      spawn: (params) =>
        Effect.gen(function* () {
          const nativePaths = yield* Effect.try({
            try: () => {
              const resolved = resolveNodePtyNative()
              if (!resolved) {
                throw new Error(
                  `Could not locate node-pty native files (pty.node + spawn-helper) for ${process.platform}-${process.arch}. Looked next to execPath (${path.dirname(process.execPath)}) and node_modules.`,
                )
              }
              return resolved
            },
            catch: (e) =>
              new PtySpawnError({ message: `Failed to locate node-pty native: ${e}`, command: params.command }),
          })

          const ptyNative = yield* Effect.try({
            try: () => require(nativePaths.ptyNodePath) as any,
            catch: (e) =>
              new PtySpawnError({ message: `Failed to load node-pty native: ${e}`, command: params.command }),
          })

          const xtermMod = yield* Effect.tryPromise({
            try: () => import("@xterm/headless"),
            catch: (e) =>
              new PtySpawnError({ message: `Failed to load @xterm/headless: ${e}`, command: params.command }),
          })

          const helperPath = nativePaths.spawnHelperPath

          const terminal = new xtermMod.Terminal({
            cols: params.cols,
            rows: params.rows,
            allowProposedApi: true,
          })

          const dirtyLines = new Set<number>()

          const env = {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            LANG: "en_US.UTF-8",
            ...(params.env ?? {}),
          }
          const parsedEnv = Object.entries(env)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`)

          let exited = false
          const term = ptyNative.fork(
            params.command,
            params.args ?? [],
            parsedEnv,
            params.cwd,
            params.cols,
            params.rows,
            -1,
            -1,
            true,
            helperPath,
            (_code: number, _signal: number) => {
              exited = true
              params.onExit?.()
            },
          )

          const fd: number = term.fd
          const pid: number = term.pid
          const READ_BUF_SIZE = 65536
          const readBuf = Buffer.alloc(READ_BUF_SIZE)
          // StringDecoder buffers incomplete UTF-8 sequences across reads.
          // Without this, multi-byte chars (─, ·, emojis) split across two
          // polls get corrupted into replacement chars or weird substitutions.
          const decoder = new StringDecoder("utf8")

          // Drain everything available in a single tick: a clear-screen +
          // full redraw from Claude/Codex can easily exceed 64KB, and
          // chunking it across many ticks (with a full repaint between)
          // is what made init feel slow.
          const pollInterval = setInterval(() => {
            let chunks = ""
            let hadData = false
            for (;;) {
              try {
                const n = fs.readSync(fd, readBuf, { offset: 0, length: READ_BUF_SIZE })
                if (n <= 0) break
                chunks += decoder.write(readBuf.subarray(0, n) as Buffer)
                hadData = true
                // If we didn't fill the buffer, the kernel has no more
                // bytes queued right now — stop draining and let the next
                // tick pick up anything that arrives.
                if (n < READ_BUF_SIZE) break
              } catch (e: any) {
                if (e.code === "EIO" && exited) {
                  clearInterval(pollInterval)
                  handles.delete(params.worktreeId)
                  return
                }
                if (e.code === "EAGAIN") break
                clearInterval(pollInterval)
                return
              }
            }
            if (hadData) {
              // xterm.write parses asynchronously. Mark dirty + notify in
              // the callback so the renderer sees post-parse buffer state.
              terminal.write(chunks, () => {
                for (let i = 0; i < terminal.rows; i++) {
                  dirtyLines.add(i)
                }
                params.onData?.()
              })
            }
          }, 8)

          const handle: PtyHandle = {
            worktreeId: params.worktreeId,
            terminal,
            dirtyLines,
            pid,
            write: (data) => {
              try {
                const buf = typeof data === "string" ? Buffer.from(data) : data
                const CHUNK = 4096
                for (let off = 0; off < buf.length; off += CHUNK) {
                  fs.writeSync(fd, buf.subarray(off, off + CHUNK))
                }
              } catch {}
            },
            resize: (cols, rows) => {
              try {
                ptyNative.resize(fd, cols, rows)
              } catch {}
              terminal.resize(cols, rows)
            },
            kill: () => {
              clearInterval(pollInterval)
              try { process.kill(pid, "SIGTERM") } catch {}
              terminal.dispose()
              handles.delete(params.worktreeId)
            },
          }

          handles.set(params.worktreeId, handle)
          return handle
        }),

      get: (worktreeId) => handles.get(worktreeId),
      kill: (worktreeId) =>
        Effect.sync(() => {
          const handle = handles.get(worktreeId)
          if (handle) handle.kill()
        }),
      resize: (worktreeId, cols, rows) => {
        const handle = handles.get(worktreeId)
        if (handle) handle.resize(cols, rows)
      },
      listActive: () => [...handles.keys()],
    }
  }),
)
