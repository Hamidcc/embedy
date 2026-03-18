import { neon } from '@netlify/neon'
import { nanoid } from 'nanoid'
import Busboy from 'busboy'

const sql = neon()

const BULK_MODE = true

export const handler = async (event) => {
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

  return new Promise((resolve) => {
    const bb = Busboy({ headers: event.headers })

    const files = []

    bb.on('file', (name, file, info) => {
      const { filename } = info
      const chunks = []

      file.on('data', (d) => chunks.push(d))

      file.on('end', () => {
        files.push({
          filename,
          buffer: Buffer.concat(chunks)
        })
      })
    })

    bb.on('finish', async () => {
      if (files.length === 0) {
        return resolve({
          statusCode: 400,
          body: 'No files uploaded'
        })
      }

      const uploaded = []

      for (const f of files) {
        // ignore non-gif files
        if (!f.filename.toLowerCase().endsWith('.gif')) continue

        const id = nanoid(10)

        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

        await sql`
          INSERT INTO gifs (id, data, expires_at, burn_remaining)
          VALUES (${id}, ${f.buffer}, ${expires}, 1)
        `

        uploaded.push(`/.netlify/functions/get?id=${id}`)
      }

      if (!BULK_MODE) {
        await sql`
          INSERT INTO uploads (ip, date)
          VALUES (${ip}, ${today})
        `
      }

      resolve({
        statusCode: 200,
        body: JSON.stringify({
          count: uploaded.length,
          files: uploaded
        })
      })
    })

    bb.end(Buffer.from(event.body, 'base64'))
  })
}
