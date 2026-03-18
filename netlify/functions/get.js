import { neon } from '@netlify/neon'
import crypto from 'crypto'

const sql = neon()

function hash(ip, ua) {
  return crypto.createHash('sha256').update(ip + ua).digest('hex')
}

export const handler = async (event) => {
  const id = event.queryStringParameters.id
  const burn = event.queryStringParameters.burn
  const embedId = event.queryStringParameters.e || 'default'

  const ip = event.headers['x-forwarded-for']?.split(',')[0] || 'unknown'
  const ua = event.headers['user-agent'] || ''
  const viewer = hash(ip, ua)

  const rows = await sql`
    SELECT * FROM gifs WHERE id = ${id} AND deleted = FALSE
  `

  if (!rows.length) return { statusCode: 404 }

  const gif = rows[0]

  if (gif.expires_at && new Date() > gif.expires_at) {
    await sql`UPDATE gifs SET deleted = TRUE WHERE id = ${id}`
    return { statusCode: 410 }
  }

  if (ip.endsWith('.13')) {
    return { statusCode: 403 }
  }

  await sql`UPDATE gifs SET views = views + 1 WHERE id = ${id}`

  const existing = await sql`
    SELECT 1 FROM gif_views WHERE gif_id = ${id} AND viewer_hash = ${viewer}
  `

  if (!existing.length) {
    await sql`
      INSERT INTO gif_views (gif_id, viewer_hash)
      VALUES (${id}, ${viewer})
    `
    await sql`
      UPDATE gifs SET unique_views = unique_views + 1 WHERE id = ${id}
    `
  }

  const embed = await sql`
    SELECT * FROM gif_embeds WHERE gif_id = ${id} AND embed_id = ${embedId}
  `

  if (!embed.length) {
    await sql`
      INSERT INTO gif_embeds (gif_id, embed_id, loads, unique_loads)
      VALUES (${id}, ${embedId}, 1, 1)
    `
  } else {
    await sql`
      UPDATE gif_embeds SET loads = loads + 1 WHERE gif_id = ${id} AND embed_id = ${embedId}
    `
  }

  if (burn && gif.burn_after !== null) {
    if (gif.views >= gif.burn_after) {
      await sql`UPDATE gifs SET deleted = TRUE WHERE id = ${id}`
    }
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store'
    },
    body: gif.data.toString('base64'),
    isBase64Encoded: true
  }
}
