import { createCanvas } from 'canvas'

export const handler = async (event) => {
  try {
    const ip = (event.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown'
    const ua = event.headers['user-agent'] || 'unknown'
    const geoRaw = event.headers['x-nf-geo']

    let location = 'unknown'
    if (geoRaw) {
      try {
        const geo = JSON.parse(Buffer.from(geoRaw, 'base64').toString())
        location = `${geo.city || ''}, ${geo.subdivision?.name || ''}, ${geo.country?.name || ''}`
      } catch {}
    }

    const canvas = createCanvas(500, 200)
    const ctx = canvas.getContext('2d')

    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, 500, 200)

    ctx.fillStyle = '#0f0'
    ctx.font = '16px monospace'

    ctx.fillText(`IP: ${ip}`, 20, 40)
    ctx.fillText(`Location: ${location}`, 20, 80)
    ctx.fillText(`UA: ${ua.slice(0, 50)}...`, 20, 120)

    const buffer = canvas.toBuffer('image/png')

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache'
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true
    }
  } catch (err) {
    console.error(err)
    return { statusCode: 500, body: 'error' }
  }
}
