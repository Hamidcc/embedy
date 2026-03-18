export const handler = async (event) => {
  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown'
  const ua = event.headers['user-agent'] || 'unknown'

  let location = 'unknown'
  const geoRaw = event.headers['x-nf-geo']
  if (geoRaw) {
    try {
      const geo = JSON.parse(Buffer.from(geoRaw, 'base64').toString())
      location = `${geo.city || ''}, ${geo.subdivision?.name || ''}, ${geo.country?.name || ''}`
    } catch {}
  }

  const text = `
IP: ${ip}

UA: ${ua.slice(0, 40)}
TRACKING ACTIVE
  `.trim()

  const url = `https://dummyimage.com/600x300/000/00ff00&text=${encodeURIComponent(text)}`

  const res = await fetch(url)
  const buffer = await res.arrayBuffer()

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache'
    },
    body: Buffer.from(buffer).toString('base64'),
    isBase64Encoded: true
  }
}
