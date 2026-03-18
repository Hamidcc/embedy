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
  const today = new Date().toISOString().slice(0, 10)

  console.info(`[${reqId}] upload:start ip=${ip} date=${today} bulk=${BULK_MODE}`)

  try {
    if (!BULK_MODE) {
      try {
        const existing = await sql`SELECT 1 FROM uploads WHERE ip = ${ip} AND date = ${today}`
        if (existing.length > 0) {
          console.warn(`[${reqId}] upload:limit ip=${ip}`)
          return { statusCode: 429, body: '1 upload/day limit' }
        }
      } catch (e) {
        console.error(`[${reqId}] upload:check-uploads-failed`, e)
      }
    }

    const contentType = event.headers['content-type'] || event.headers['Content-Type']
    if (!contentType || !contentType.includes('multipart/form-data')) {
      console.warn(`[${reqId}] upload:bad-content-type contentType=${contentType}`)
      return { statusCode: 400, body: 'Invalid upload: Content-Type must be multipart/form-data' }
    }

    return await new Promise((resolve, reject) => {
      let settled = false
      const settleResolve = (res) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const duration = Date.now() - startTs
        console.info(`[${reqId}] upload:settle status=${res.statusCode} duration_ms=${duration}`)
        resolve(res)
      }
      const settleReject = (err) => {
        if (settled) {
          console.error(`[${reqId}] upload:reject-after-settled`, err)
          return
        }
        settled = true
        clearTimeout(timeout)
        console.error(`[${reqId}] upload:error`, err)
        reject(err)
      }

      const timeout = setTimeout(() => {
        if (!settled) {
          const err = new Error('Upload handler timed out')
          console.error(`[${reqId}] upload:timeout ${FINISH_TIMEOUT_MS}ms`)
          settleReject(err)
        }
      }, FINISH_TIMEOUT_MS)

      const bb = Busboy({ headers: { 'content-type': contentType } })
      const files = []
      let parseError = null

      bb.on('error', (err) => {
        parseError = err
        console.error(`[${reqId}] busboy:error`, err)
        settleReject(err)
      })

      bb.on('file', (fieldname, file, info) => {
        const filename = (info && (info.filename || info.name)) || 'unknown'
        const chunks = []
        let size = 0
        let ended = false

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
          ended = true
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
          settleReject(err)
        })
      })

      bb.on('finish', async () => {
        try {
          if (parseError) return settleReject(parseError)
          if (files.length === 0) return settleResolve({ statusCode: 400, body: 'No valid files uploaded' })

          const gifFiles = files.filter(f => f.filename.toLowerCase().endsWith('.gif'))
          if (gifFiles.length === 0) {
            console.warn(`[${reqId}] upload:no-gifs files=${files.length}`)
            return settleResolve({ statusCode: 400, body: 'No GIF files uploaded' })
          }

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
              console.info(`[${reqId}] uploads:recorded ip=${ip}`)
            } catch (e) {
              console.error(`[${reqId}] uploads:record-failed ip=${ip}`, e)
            }
          }

          const resp = {
            statusCode: 200,
            body: JSON.stringify({
              count: uploadedPaths.length,
              files: uploadedPaths
            })
          }
          settleResolve(resp)
        } catch (err) {
          settleReject(err)
        }
      })

      try {
        const bodyBuffer = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8')
        bb.end(bodyBuffer)
      } catch (err) {
        settleReject(err)
      }
    })
  } catch (err) {
    console.error(`[${reqId}] handler:uncaught`, err)
    return { statusCode: 500, body: 'Internal Server Error: ' + (err && err.message ? err.message : String(err)) }
  }
}
