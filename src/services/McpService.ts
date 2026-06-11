import { Context, Effect, Layer } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { nanoid } from "nanoid"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { DatabaseService } from "./DatabaseService.js"
import { registerTools, type McpEvent, type WorktreeContext } from "../mcp/tools.js"

export type { McpEvent, WorktreeContext } from "../mcp/tools.js"

// In-process HTTP MCP server. One server per treemux process, bound to an
// ephemeral loopback port. Each worktree gets a random token (persisted) that
// its `claude` sends as the X-Treemux-Token header; that's how the server maps
// a request back to a worktree. The service is passive: agent->treemux tool
// calls are emitted to a handler app.ts registers (onEvent), and the
// treemux->agent get_context tool reads through a provider app.ts registers
// (setContextProvider). Both are late-bound because this service is built
// before app.ts's bootstrap runs.
export class McpService extends Context.Tag("McpService")<
  McpService,
  {
    readonly url: string
    readonly port: number
    readonly tokenFor: (worktreeId: string) => string
    readonly onEvent: (handler: (e: McpEvent) => void) => void
    readonly setContextProvider: (fn: (worktreeId: string) => WorktreeContext | null) => void
  }
>() {}

const TOKEN_PREFIX = "mcp_token_"

export const McpServiceLive = Layer.scoped(
  McpService,
  Effect.gen(function* () {
    const { db } = yield* DatabaseService

    const setSetting = (key: string, value: string) => {
      db.query(
        "INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value)
    }

    // token <-> worktreeId, hydrated from prior runs so tokens are stable.
    const byToken = new Map<string, string>()
    const byWorktree = new Map<string, string>()
    for (const row of db
      .query("SELECT key, value FROM app_settings WHERE key LIKE ?")
      .all(`${TOKEN_PREFIX}%`) as { key: string; value: string }[]) {
      const wtId = row.key.slice(TOKEN_PREFIX.length)
      byToken.set(row.value, wtId)
      byWorktree.set(wtId, row.value)
    }

    const tokenFor = (worktreeId: string): string => {
      const existing = byWorktree.get(worktreeId)
      if (existing) return existing
      const token = nanoid(32)
      byWorktree.set(worktreeId, token)
      byToken.set(token, worktreeId)
      setSetting(TOKEN_PREFIX + worktreeId, token)
      return token
    }

    let eventHandler: ((e: McpEvent) => void) | null = null
    let contextProvider: ((id: string) => WorktreeContext | null) | null = null

    const handlePost = async (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      worktreeId: string,
    ) => {
      // We consume the request stream here, so the parsed body must be handed
      // to handleRequest (it can't re-read the stream).
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      if (chunks.length === 0) {
        res.writeHead(400).end()
        return
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        res.writeHead(400).end()
        return
      }

      const server = new McpServer({ name: "treemux", version: "0.1.0" })
      registerTools(server, {
        worktreeId,
        emit: (e) => eventHandler?.(e),
        getContext: (id) => contextProvider?.(id) ?? null,
      })
      // Stateless: a fresh ephemeral server/transport per request, no sessions.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on("close", () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    }

    const httpServer = http.createServer((req, res) => {
      const ra = req.socket.remoteAddress ?? ""
      const isLoopback = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1"
      if (!isLoopback) {
        res.writeHead(403).end()
        return
      }
      // Stateless transport only handles POST; reject GET (SSE) / DELETE.
      if (req.method !== "POST") {
        res.writeHead(405).end()
        return
      }
      const token = (req.headers["x-treemux-token"] as string | undefined) ?? ""
      const worktreeId = byToken.get(token)
      if (!worktreeId) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "unknown or missing treemux token" },
            id: null,
          }),
        )
        return
      }
      handlePost(req, res, worktreeId).catch(() => {
        try {
          if (!res.headersSent) res.writeHead(500).end()
          else res.end()
        } catch {}
      })
    })

    const port = yield* Effect.async<number, Error>((resume) => {
      httpServer.once("error", (e) => resume(Effect.fail(e)))
      httpServer.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed((httpServer.address() as AddressInfo).port))
      })
    })
    const url = `http://127.0.0.1:${port}/mcp`

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          httpServer.close()
        } catch {}
      }),
    )

    return {
      url,
      port,
      tokenFor,
      onEvent: (handler) => {
        eventHandler = handler
      },
      setContextProvider: (fn) => {
        contextProvider = fn
      },
    }
  }),
)
