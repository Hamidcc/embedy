import { neon } from '@netlify/neon'
import { nanoid } from 'nanoid'
import Busboy from 'busboy'

const sql = neon()
const BULK_MODE = true
const FILE_SIZE_LIMIT = 5 * 1024 * 1024
const FINISH_TIMEOUT_MS = 30000

export const handler = async (event, context) => {
  const reqId = nanoid(8)
  const startTs = Date.now()
  const ip = (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'] || '').split(',')[0]?.trim() || 'unknown'
  console.info(`[${reqId}] upload:start ip=${ip}`)

  // debug: log all headers once
  console.info(`[${reqId}] headers: ${JSON.stringify(event.headers || {}, null, 2)}`)

  try {
    // prepare raw body buffer (Netlify sets isBase64Encoded=true for binary)
    const raw = event.body || ''
    const bodyBuffer = event.isBase64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')

    // original header if present
    let contentType = (event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || undefined

    // If missing, try to auto-detect boundary from the raw body
    if (!contentType) {
      try {
        const probe = bodyBuffer.slice(0, Math.min(bodyBuffer.length, 2048)).toString('utf8')
        // boundary line usually starts with --<boundary>
        const m = probe.match(/^--([A-Za-z0-9'()+_,-.\/:=?]+)\r?\n/)
        if (m) {
          contentType = `multipart/form-data; boundary=${m[1]}`
          console.info(`[${reqId}] detected boundary; reconstructed content-type=${contentType}`)
        } else if (probe.includes('Content-Disposition: form-data')) {
          // fallback: assume multipart but unknown boundary (Busboy may still work)
          contentType = 'multipart/form-data'
          console.info(`[${reqId}] detected form-data markers; using generic multipart/form-data`)
        } else {
          console.warn(`[${reqId}] unable to detect content-type from body`)
        }
      } catch (e) {
        console.error(`[${reqId}] boundary-detect-failed`, e)
      }
    } else {
      console.info(`[${reqId}] received content-type header=${contentType}`)
    }

    if (!contentType || !contentType.includes('multipart/form-data')) {
      console.warn(`[${reqId}] upload:bad-content-type contentType=${contentType}`)
      return { statusCode: 400, body: 'Invalid upload: Content-Type must be multipart/form-data' }
    }

    // optional: rate limiting check (kept brief)
    const today = new Date().toISOString().slice(0, 10)
    if (!BULK_MODE) {
      try {
        const existing = await sql`SELECT 1 FROM uploads WHERE ip = ${ip} AND date = ${today}`
        if (existing.length > 0) return { statusCode: 429, body: '1 upload/day limit' }
      } catch (e) {
        console.error(`[${reqId}] upload:check-uploads-failed`, e)
      }
    }

    return await new Promise((resolve, reject) => {
      let settled = false
      const settle = (res, isErr = false) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const duration = Date.now() - startTs
        if (isErr) {
          console.error(`[${reqId}] upload:settle error duration_ms=${duration}`, res)
          reject(res)
        } else {
          console.info(`[${reqId}] upload:settle status=${res.statusCode} duration_ms=${duration}`)
          resolve(res)
        }
      }

      const timeout = setTimeout(() => settle(new Error('Upload handler timed out'), true), FINISH_TIMEOUT_MS)

      const bb = Busboy({ headers: { 'content-type': contentType } })
      const files = []
      let parseError = null

      bb.on('error', (err) => {
        parseError = err
        console.error(`[${reqId}] busboy:error`, err)
        settle(err, true)
      })

      bb.on('file', (fieldname, file, info) => {
        const filename = (info && (info.filename || info.name)) || 'unknown'
        const chunks = []
        let size = 0

        file.on('data', (d) => {
          if (parseError) return
          size += d.length
          if (size > FILE_SIZE_LIMIT) {
            console.warn(`[${reqId}] file:oversize filename=${filename} size=${size}`)
            file.resume()
            return
          }
          chunks.push(d)
        })

        file.on('end', () => {
          if (parseError) return
          if (chunks.length > 0 && size <= FILE_SIZE_LIMIT) {
            files.push({ filename, buffer: Buffer.concat(chunks), size })
            console.info(`[${reqId}] file:buffered filename=${filename} size=${size}`)
          } else {
            console.warn(`[${reqId}] file:skipped filename=${filename} buffered=${chunks.length} size=${size}`)
          }
        })

        file.on('error', (err) => {
          parseError = err
          console.error(`[${reqId}] file:error filename=${filename}`, err)
          settle(err, true)
        })
      })

      bb.on('finish', async () => {
        try {
          if (parseError) return settle(parseError, true)
          if (files.length === 0) return settle({ statusCode: 400, body: 'No valid files uploaded' })

          const gifFiles = files.filter(f => f.filename.toLowerCase().endsWith('.gif'))
          if (gifFiles.length === 0) return settle({ statusCode: 400, body: 'No GIF files uploaded' })

          const insertPromises = gifFiles.map(f => {
            const id = nanoid(10)
            const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            return sql`
              INSERT INTO gifs (id, data, expires_at, burn_remaining)
              VALUES (${id}, ${f.buffer}, ${expires}, 1)
            `
              .then(() => ({ id, filename: f.filename, size: f.size }))
              .catch(err => {
                console.error(`[${reqId}] db:insert-failed filename=${f.filename}`, err)
                return null
              })
          })

          const results = await Promise.all(insertPromises)
          const successful = results.filter(Boolean)
          const uploadedPaths = successful.map(r => `/.netlify/functions/get?id=${r.id}`)

          if (!BULK_MODE) {
            try {
              await sql`INSERT INTO uploads (ip, date) VALUES (${ip}, ${today})`
            } catch (e) {
              console.error(`[${reqId}] uploads:record-failed ip=${ip}`, e)
            }
          }

          settle({ statusCode: 200, body: JSON.stringify({ count: uploadedPaths.length, files: uploadedPaths }) })
        } catch (err) {
          settle(err, true)
        }
      })

      try {
        // pass the raw buffer into busboy
        bb.end(bodyBuffer)
      } catch (err) {
        settle(err, true)
      }
    })
  } catch (err) {
    console.error(`[${reqId}] handler:uncaught`, err)
    return { statusCode: 500, body: 'Internal Server Error: ' + (err && err.message ? err.message : String(err)) }
  }
}
