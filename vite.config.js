import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { pathToFileURL, fileURLToPath } from 'url'
import { resolve, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Dev-only plugin: runs api/*.js handlers so /api/* works without `vercel dev`
function devApiPlugin() {
  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        const match = url.pathname.match(/^\/api\/([^/?]+)/)
        if (!match) return next()

        const handlerPath = resolve(__dirname, 'api', `${match[1]}.js`)
        let mod
        try {
          // Cache-bust so edits to api/*.js hot-reload
          mod = await import(pathToFileURL(handlerPath).href + `?t=${Date.now()}`)
        } catch {
          return next()
        }

        // Collect request body
        let body = null
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          body = await new Promise((resolve) => {
            const chunks = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => {
              const raw = Buffer.concat(chunks).toString()
              try { resolve(JSON.parse(raw)) } catch { resolve(raw || null) }
            })
          })
        }

        // The dev client skips PasswordGate, so it never stores `mlb_auth` and
        // sends no X-Access-Code header — write endpoints (api/_auth.js) would
        // 401. Supply the code from .env.local, which the local operator
        // already has. This plugin is dev-server-only; prod is untouched.
        const headers = { ...req.headers }
        if (!headers['x-access-code'] && process.env.APP_ACCESS_CODE) {
          headers['x-access-code'] = process.env.APP_ACCESS_CODE
        }

        const mockReq = {
          method: req.method,
          query: Object.fromEntries(url.searchParams),
          body,
          headers,
        }

        let sent = false
        const mockRes = {
          statusCode: 200,
          _headers: {},
          status(code) { this.statusCode = code; return this },
          setHeader(k, v) { this._headers[k] = v; return this },
          json(data) {
            if (sent) return
            sent = true
            const payload = JSON.stringify(data)
            res.writeHead(this.statusCode, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              ...this._headers,
            })
            res.end(payload)
          },
          end(data) {
            if (sent) return
            sent = true
            res.writeHead(this.statusCode, this._headers)
            res.end(data)
          },
          // The CSV endpoints (view=freshness, view=sheets-feed) answer with
          // res.send, which this shim never had — so they threw
          // "res.status(...).send is not a function" in dev and could only be
          // exercised against prod.
          send(data) {
            if (sent) return
            sent = true
            const payload = typeof data === 'string' ? data : String(data ?? '')
            res.writeHead(this.statusCode, {
              'content-length': Buffer.byteLength(payload),
              ...this._headers,
            })
            res.end(payload)
          },
        }

        try {
          await mod.default(mockReq, mockRes)
        } catch (err) {
          if (!sent) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          }
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load .env.local → process.env so api handlers can read credentials
  const env = loadEnv(mode, process.cwd(), '')
  Object.assign(process.env, env)

  return {
    plugins: [react(), devApiPlugin()],
    server: {
      port: 5173,
      strictPort: true,
    },
    test: {
      // Agent worktrees under .claude/ are full repo checkouts pinned at old
      // commits. Without this, vitest collects their stale copies of every
      // *.test.js too, so `npm test` reports ~3x the real test count and can
      // fail on code that is no longer in the tree.
      exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/worktrees/**'],
    },
  }
})
