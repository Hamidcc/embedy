import { neon } from '@netlify/neon'
import { nanoid } from 'nanoid'
import Busboy from 'busboy'
import { execSync } from 'child_process'
import fs from 'fs'
const BULK_MODE = true
const sql = neon()

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
    let fileBuffer = null

    bb.on('file', (_, file) => {
  const chunks = []
  file.on('data', (d) => chunks.push(d))
  file.on('end', async () => {
    const buffer = Buffer.concat(chunks)

    const id = nanoid(10)

    await sql`
      INSERT INTO gifs (id, data, expires_at)
      VALUES (${id}, ${buffer}, ${new Date(Date.now() + 7*24*60*60*1000)})
    `
  })
})

    bb.on('finish', async () => {
      const id = nanoid(10)

      fs.writeFileSync('/tmp/in.gif', fileBuffer)

      try {
        execSync(`ffmpeg -y -i /tmp/in.gif -t 10 -vf "fps=15,scale=480:-1:flags=lanczos" /tmp/out.gif`)
        fileBuffer = fs.readFileSync('/tmp/out.gif')
      } catch {}

      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      const burnCount = 1 // default burn link = 1 view

      await sql`
        INSERT INTO gifs (id, data, expires_at, burn_remaining)
        VALUES (${id}, ${fileBuffer}, ${expires}, ${burnCount})
      `

      await sql`
        INSERT INTO uploads (ip, date)
        VALUES (${ip}, ${today})
      `

      if (process.env.DISCORD_WEBHOOK) {
        await fetch(process.env.DISCORD_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `New GIF: https://${event.headers.host}/.netlify/functions/get?id=${id}`
          })
        })
      }

      const gifs = await sql`
  SELECT id FROM gifs ORDER BY created_at DESC LIMIT 20
`

resolve({
  statusCode: 200,
  body: JSON.stringify({
    uploaded: gifs.map(g => `/.netlify/functions/get?id=${g.id}`)
  })
})
    })

    bb.end(Buffer.from(event.body, 'base64'))
  })
}
