import { neon } from '@netlify/neon'
import { nanoid } from 'nanoid'
import Busboy from 'busboy'

const sql = neon()
const FILE_SIZE_LIMIT = 5 * 1024 * 1024
const FINISH_TIMEOUT_MS = 30000
const BULK_MODE = true

export const handler = async (event) => {
  const reqId = nanoid(8)
  const start = Date.now()
  const ip = (event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'] || '').split(',')[0]?.trim() || 'unknown'
  console.info(`[${reqId}] upload:start ip=${ip}`)

  try {
    const raw = event.body || ''
    const bodyBuffer = event.isBase64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
    let contentType = event.headers && (event.headers['content-type'] || event.headers['Content-Type'])

    if (!contentType) {
      try {
        const probe = bodyBuffer.slice(0, Math.min(bodyBuffer.length, 2048)).toString('utf8')
        const m = probe.match(/^--([A-Za-z0-9'()+_,-.\/:=?]+)\r?\n/)
        if (m) contentType = `multipart/form-data; boundary=${m[1]}`
        else if (probe.includes('Content-Disposition: form-data')) contentType = 'multipart/form-data'
      } catch (e) {
        console.warn(`[${reqId}] boundary-detect-failed`, e)
      }
    }

    if (!contentType || !contentType.includes('multipart/form-data')) {
      console.warn(`[${reqId}] upload:bad-content-type contentType=${contentType}`)
      return { statusCode: 400, body: 'Invalid upload: Content-Type must be multipart/form-data' }
    }

    const today = new Date().toISOString().slice(0, 10)
    if (!BULK_MODE) {
      try {
        const existing = await sql`SELECT 1 FROM uploads WHERE ip = ${ip} AND date = ${today}`
        if (existing.length > 0) return { statusCode: 429, body: '1 upload/day limit' }
      } catch (e) {
        console.error(`[${reqId}] uploads-check-failed`, e)
      }
    }

    return await new Promise((resolve, reject) => {
      let settled = false
      const settleResolve = (res) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const dur = Date.now() - start
        console.info(`[${reqId}] upload:done status=${res.statusCode} duration_ms=${dur}`)
        resolve(res)
      }
      const settleReject = (err) => {
        if (settled) {
          console.error(`[${reqId}] reject-after-settled`, err)
          return
        }
        settled = true
        clearTimeout(timeout)
        console.error(`[${reqId}] upload:error`, err)
        reject(err)
      }

      const timeout = setTimeout(() => settleReject(new Error('Upload handler timed out')), FINISH_TIMEOUT_MS)

      const bb = Busboy({ headers: { 'content-type': contentType } })
      let parseError = null
      const files = []

      bb.on('error', (err) => {
        parseError = err
        settleReject(err)
      })

      bb.on('file', (fieldname, file, info) => {
        const filename = (info && (info.filename || info.name)) || 'unknown'
        const chunks = []
        let size = 0

        file.on('data', (d) => {
          if (parseError) return
          size += d.length
          if (size > FILE_SIZE_LIMIT) {
            file.resume()
            return
          }
          chunks.push(d)
        })

        file.on('end', () => {
          if (parseError) return
          if (chunks.length > 0 && size <= FILE_SIZE_LIMIT) files.push({ fieldname, filename, buffer: Buffer.concat(chunks), size })
        })

        file.on('error', (err) => {
          parseError = err
          settleReject(err)
        })
      })

      bb.on('finish', async () => {
        try {
          if (parseError) return settleReject(parseError)
          if (files.length === 0) return settleResolve({ statusCode: 400, body: 'No valid files uploaded' })

          const f = files.find(x => x.fieldname === 'file') || files[0]
          if (!f.filename.toLowerCase().endsWith('.gif')) return settleResolve({ statusCode: 400, body: 'Uploaded file is not a GIF' })

          const id = nanoid(10)
          const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          try {
            await sql`
              INSERT INTO gifs (id, data, expires_at, burn_remaining)
              VALUES (${id}, ${f.buffer}, ${expires}, 1)
            `
          } catch (e) {
            console.error(`[${reqId}] db-insert-failed`, e)
            return settleReject(e)
          }

          if (!BULK_MODE) {
            try {
              await sql`INSERT INTO uploads (ip, date) VALUES (${ip}, ${today})`
            } catch (e) {
              console.error(`[${reqId}] uploads-record-failed`, e)
            }
          }

          const url = `/.netlify/functions/get?id=${id}`
          const burn = `/.netlify/functions/get?id=${id}&burn=1`
          const random = `/.netlify/functions/random`

          settleResolve({
            statusCode: 200,
            body: JSON.stringify({ url, burn, random })
          })
        } catch (err) {
          settleReject(err)
        }
      })

      try {
        bb.end(bodyBuffer)
      } catch (err) {
        settleReject(err)
      }
    })
  } catch (err) {
    console.error('handler:uncaught', err)
    return { statusCode: 500, body: 'Internal Server Error: ' + (err && err.message ? err.message : String(err)) }
  }
}
