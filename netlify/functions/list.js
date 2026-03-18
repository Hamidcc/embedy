import { neon } from '@netlify/neon'

const sql = neon()

export const handler = async () => {
  try {
    const rows = await sql`
      SELECT id 
      FROM gifs 
      WHERE expires_at > NOW()
      ORDER BY expires_at DESC
      LIMIT 100
    `

    return {
      statusCode: 200,
      body: JSON.stringify(rows.map(r => r.id))
    }
  } catch (err) {
    console.error('list error:', err)
    return { statusCode: 500, body: 'error' }
  }
}
