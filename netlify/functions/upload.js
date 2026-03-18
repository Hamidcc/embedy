import { neon } from '@netlify/neon'
import { nanoid } from 'nanoid'
import Busboy from 'busboy'

const sql = neon()

const BULK_MODE = true

export const handler = async (event) => {
  try {
    const ip = event.headers['x-forwarded-for']?.split(',')[0] || 'unknown'
    const today = new Date().toISOString().slice(0, 10)

    if (!BULK_MODE) {
      const existing = await sql`
        SELECT 1 FROM uploads WHERE ip = ${ip} AND date = ${today}
      `
      if (existing.length > 0) {
        return { statusCode: 429, body: '1 upload/day limit' }
      }
    }

    const contentType = event.headers['content-type'] || event.headers['Content-Type']
    if (!contentType || !contentType.includes('multipart/form-data')) {
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

        file.on('data', (d) => {
          size += d.length
          if (size > 5 * 1024 * 1024) file.resume() // skip big files
          else chunks.push(d)
        })

        file.on('end', () => {
          if (chunks.length > 0) {
            files.push({ filename, buffer: Buffer.concat(chunks) })
          }
        })
      })

      bb.on('error', (err) => reject(err))

      bb.on('finish', async () => {
        if (files.length === 0) return resolve({ statusCode: 400, body: 'No valid files uploaded' })

        const uploaded = []

        for (const f of files) {
          if (!f.filename.toLowerCase().endsWith('.gif')) continue
          const id = nanoid(10)
          const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          try {
            await sql`
              INSERT INTO gifs (id, data, expires_at, burn_remaining)
              VALUES (${id}, ${f.buffer}, ${expires}, 1)
            `
            uploaded.push(`/.netlify/functions/get?id=${id}`)
          } catch (e) {
            console.error('DB insert failed:', e)
          }
        }

        if (!BULK_MODE) {
          await sql`INSERT INTO uploads (ip, date) VALUES (${ip}, ${today})`
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
        reject(err)
      }
    })
  } catch (err) {
    console.error('UPLOAD FUNCTION ERROR:', err)
    return { statusCode: 500, body: 'Internal Server Error: ' + err.message }
  }
}
