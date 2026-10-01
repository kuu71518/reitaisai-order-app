import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { app } from '../../api/src/index.ts'
import { deriveDiscordIdHmac, sha256Base64Url } from '../../api/src/security.js'

const ORIGIN = 'http://127.0.0.1:5174'
const COOKIE = 'reitaisai_demo_session'
const roles = new Set(['admin', 'member', 'manager'])
const sampleRows = [
  ['参加者名', 'DiscordユーザーID', 'グループ', '権限'],
  ['テスト追加メンバー', '900000000000000001', 'クラシック席', '一般参加者'],
  ['テスト追加担当者', '900000000000000002', 'ニュークラシック席', '担当者'],
]

function sampleWorkbook() {
  const archive = unzipSync(new Uint8Array(readFileSync(new URL('../public/templates/member-import.xlsx', import.meta.url))))
  const rows = sampleRows.map((values, index) => `<row r="${index + 1}">${values.map((value, column) => `<c r="${'ABCD'[column]}${index + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`).join('')
  const sheet = strFromU8(archive['xl/worksheets/sheet1.xml'])
  const sheetData = /<((?:\w+:)?sheetData)(?:\s[^>]*)?>[\s\S]*?<\/\1>/
  if (!sheetData.test(sheet)) throw new Error('Unexpected template structure')
  archive['xl/worksheets/sheet1.xml'] = strToU8(sheet.replace(sheetData, `<sheetData xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${rows}</sheetData>`))
  return Buffer.from(zipSync(archive))
}

// Only the local Vite demo server installs this bridge. It runs actual API SQL
// against memory SQLite. No existing database, credentials or seed is loaded.
export function localDemo() {
  let database
  let env
  let bridgeQueue = Promise.resolve()
  const key = randomBytes(32).toString('hex')

  function adapter(sqlite) {
    return {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          first() { return sqlite.prepare(sql).get(...values) ?? null },
          all() { return { success: true, results: sqlite.prepare(sql).all(...values) } },
          run() {
            const statement = sqlite.prepare(sql)
            if (statement.columns().length) return { success: true, results: statement.all(...values), meta: {} }
            const result = statement.run(...values)
            return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }
          },
        }
      },
      batch(statements) {
        sqlite.exec('BEGIN')
        try {
          const results = statements.map((statement) => statement.run())
          sqlite.exec('COMMIT')
          return results
        } catch (error) { sqlite.exec('ROLLBACK'); throw error }
      },
    }
  }

  async function reset() {
    database?.close()
    database = new DatabaseSync(':memory:')
    for (const name of ['0001_initial.sql', '0002_security_constraints.sql', '0003_discord_allowlist_and_admin_orders.sql']) {
      database.exec(readFileSync(new URL(`../../api/migrations/${name}`, import.meta.url), 'utf8'))
    }
    const people = [
      ['テスト管理者', 'クラシック席', 'admin'],
      ['テスト参加者', 'クラシック席', 'member'],
      ['テスト担当者', 'クラシック席', 'manager'],
      ['テスト参加者B', 'ニュークラシック席', 'member'],
    ]
    for (const [index, person] of people.entries()) {
      const hmac = await deriveDiscordIdHmac(key, String(900000000000000101n + BigInt(index)))
      database.prepare('INSERT INTO users (name, group_id, role, discord_id_hmac, is_manual_added) VALUES (?, ?, ?, ?, 1)').run(...person, hmac)
    }
    for (const item of [
      ['ソフトドリンク', 'テスト用ウーロン茶', '通常', 300],
      ['ビール', 'テスト用生ビール', '中', 500],
      ['揚物', 'テスト用からあげ', '通常', 600],
      ['一品', 'テスト用枝豆', '通常', 300],
      ['ビール', 'テスト用生ビール', '大', 800],
      ['ソフトドリンク', 'テスト用ウーロン茶', '大', 450],
      ['サラダ', 'テスト用・季節の野菜をたっぷり使った彩りサラダ', '取り分け用', 850],
      ['食事', 'テスト用おにぎり', '通常', 250],
      ['サワー', 'テスト用レモンサワー', '通常', 400],
      ['デザート', 'テスト用アイス', '通常', 280],
    ]) database.prepare('INSERT INTO menu_items (category, name, size, price) VALUES (?, ?, ?, ?)').run(...item)
    env = { APP_ENV: 'local', ALLOWED_ORIGINS: ORIGIN, FRONTEND_URL: ORIGIN, DISCORD_ID_HMAC_KEY: key, DB: adapter(database) }
  }

  async function signIn(role, res) {
    const user = database.prepare('SELECT id FROM users WHERE role = ? AND is_active = 1 AND discord_id_hmac IS NOT NULL ORDER BY id LIMIT 1').get(role)
    if (!user) return false
    const token = randomBytes(32).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    database.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(await sha256Base64Url(token), user.id, now, now, now + 2592000, now + 2592000)
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`)
    return true
  }

  function json(res, body, status = 200) {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 256 * 1024) throw new Error('Body too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  return {
    name: 'local-memory-demo',
    apply: 'serve',
    async configureServer(server) {
      if (server.config.server.host !== '127.0.0.1' || server.config.server.port !== 5174) throw new Error('Demo must bind to 127.0.0.1:5174')
      await reset()
      server.httpServer?.once('close', () => database?.close())
      server.middlewares.use((req, res, next) => {
        if (req.headers.host !== '127.0.0.1:5174') return json(res, { success: false }, 403)
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Security-Policy', "connect-src 'self' ws://127.0.0.1:5174; frame-ancestors 'self'; form-action 'self'; object-src 'none'")
        const url = new URL(req.url, ORIGIN)
        if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/__demo')) return next()
        const handle = async () => {
          if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== ORIGIN) return json(res, { success: false }, 403)
          if (url.pathname === '/__demo' || url.pathname === '/__demo/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            return res.end(readFileSync(new URL('./demo-page.html', import.meta.url)))
          }
          if (url.pathname === '/__demo/sample.xlsx') {
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            res.setHeader('Content-Disposition', "attachment; filename=demo-members.xlsx; filename*=UTF-8''" + encodeURIComponent('テスト用メンバー2名.xlsx'))
            return res.end(sampleWorkbook())
          }
          if (url.pathname === '/__demo/session' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8'))
            if (body.role === 'guest') {
              res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
              return json(res, { success: true })
            }
            if (!roles.has(body.role) || !await signIn(body.role, res)) return json(res, { success: false, message: 'テスト用の利用者がいません。「最初の状態に戻す」を押してください。' }, 400)
            return json(res, { success: true })
          }
          if (url.pathname === '/__demo/reset' && req.method === 'POST') {
            await reset()
            await signIn('admin', res)
            return json(res, { success: true })
          }
          if (url.pathname.startsWith('/__demo')) return json(res, { success: false }, 404)
          if (url.pathname.startsWith('/api/auth/discord/')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            return res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>テスト用ログイン</title><body style="font:18px sans-serif;padding:28px;line-height:1.8"><h1>テスト用ログイン</h1><p>この画面ではDiscordへ接続しません。上部の「管理者」「参加者」「担当者」を選ぶとログインできます。</p></body></html>')
          }
          const headers = new Headers()
          for (const [name, value] of Object.entries(req.headers)) if (value != null && !['host', 'content-length', 'cookie'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          const match = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))
          if (match) headers.set('Cookie', `reitaisai_session=${match.slice(COOKIE.length + 1)}`)
          const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
          const response = await app.request(url.href, { method: req.method, headers, body }, env)
          res.statusCode = response.status
          for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value)
          const cookies = response.headers.getSetCookie().map((cookie) => cookie.replace(/^reitaisai_session=/, `${COOKIE}=`))
          if (cookies.length) res.setHeader('Set-Cookie', cookies)
          res.end(Buffer.from(await response.arrayBuffer()))
        }
        // Serialize demo API/control requests so a reset never closes an active DB.
        bridgeQueue = bridgeQueue.then(handle).catch(() => {
          if (!res.writableEnded) json(res, { success: false, message: 'テスト処理に失敗しました。最初の状態に戻してお試しください。' }, 500)
        })
      })
    },
  }
}
