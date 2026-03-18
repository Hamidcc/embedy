import { neon } from '@netlify/neon'
import { nanoid } from 'nanoid'
import Busboy from 'busboy'

const sql = neon()

const BULK_MODE = true

export const handler = async (event) => {
  const ip = event.headers['x-forwarded-for']?.split(',')[0] || 'unknown'
  const today = new Date().toISOString().slice(0, 10)

  console.info(`[UPLOAD] Request from IP: ${ip}, Date: ${today}`)

  try {
    if (!BULK_MODE) {
      const existing = await sql`
        SELECT 1 FROM uploads WHERE ip = ${ip} AND date = ${today}
      `
      if (existing.length > 0) {
        console.warn(`[UPLOAD] IP ${ip} exceeded daily upload limit`)
        return { statusCode: 429, body: '1 upload/day limit' }
      }
    }

    const contentType = event.headers['content-type'] || event.headers['Content-Type']
    if (!contentType || !contentType.includes('multipart/form-data')) {
      console.warn(`[UPLOAD] Invalid content type: ${contentType}`)
      return {
        statusCode: 400,
        body: 'Invalid upload: Content-Type must be multipart/form-data'
      }
    }

    return await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: { 'content-type': contentType } })
      const files = []

      bb.on('file', (name, file, info) => {
        const { filename } = info
        const chunks = []
        let size = 0
        console.info(`[UPLOAD] Processing file: ${filename}`)

        file.on('data', (d) => {
          size += d.length
          if (size > 5 * 1024 * 1024) {
            console.warn(`[UPLOAD] File too large, skipping: ${filename}`)
            file.resume()
          } else chunks.push(d)
        })

        file.on('end', () => {
          if (chunks.length > 0) {
            files.push({ filename, buffer: Buffer.concat(chunks) })
            console.info(`[UPLOAD] File buffered successfully: ${filename}, Size: ${size} bytes`)
          }
        })
      })

      bb.on('error', (err) => {
        console.error('[UPLOAD] Busboy error:', err)
        reject(err)
      })

      bb.on('finish', async () => {
        if (files.length === 0) {
          console.warn('[UPLOAD] No valid files uploaded')
          return resolve({ statusCode: 400, body: 'No valid files uploaded' })
        }

        const uploaded = []

        for (const f of files) {
          if (!f.filename.toLowerCase().endsWith('.gif')) {
            console.warn(`[UPLOAD] Skipping non-GIF file: ${f.filename}`)
            continue
          }

          const id = nanoid(10)
          const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

          try {
            await sql`
              INSERT INTO gifs (id, data, expires_at, burn_remaining)
              VALUES (${id}, ${f.buffer}, ${expires}, 1)
            `
            uploaded.push(`/.netlify/functions/get?id=${id}`)
            console.info(`[UPLOAD] GIF stored successfully: ${f.filename}, ID: ${id}`)
          } catch (e) {
            console.error(`[UPLOAD] Failed to insert GIF into DB: ${f.filename}, Error:`, e)
          }
        }

        if (!BULK_MODE) {
          try {
            await sql`INSERT INTO uploads (ip, date) VALUES (${ip}, ${today})`
            console.info(`[UPLOAD] Recorded upload for IP: ${ip}`)
          } catch (e) {
            console.error('[UPLOAD] Failed to record IP upload:', e)
          }
        }

        resolve({
          statusCode: 200,
          body: JSON.stringify({
            count: uploaded.length,
            files: uploaded
          })
        })
      })

      try {
        const bodyBuffer = event.isBase64Encoded
          ? Buffer.from(event.body, 'base64')
          : Buffer.from(event.body)

        bb.end(bodyBuffer)
      } catch (err) {
        console.error('[UPLOAD] Failed to parse request body:', err)
        reject(err)
      }
    })
  } catch (err) {
    console.error('[UPLOAD] Function error:', err)
    return { statusCode: 500, body: 'Internal Server Error: ' + err.message }
  }
}
