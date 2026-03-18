import { neon } from '@netlify/neon'

const sql = neon()

export const handler = async (event) => {
  const ip = event.headers['x-forwarded-for']?.split(',')[0] || 'unknown'

  const rows = await sql`
    SELECT id FROM gifs WHERE deleted = FALSE ORDER BY random() LIMIT 1
  `

  if (!rows.length) return { statusCode: 404 }

  const id = rows[0].id

  return {
    statusCode: 302,
    headers: {
      Location: `/.netlify/functions/get?id=${id}&e=${encodeURIComponent(ip + Date.now())}`,
      'Cache-Control': 'no-store'
    }
  }
}
