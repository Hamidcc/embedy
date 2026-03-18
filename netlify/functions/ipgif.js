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

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="500" height="220">
    <rect width="100%" height="100%" fill="#000"/>
    
    <text x="20" y="40" fill="#00ff00" font-size="16" font-family="monospace">
      CONNECTION ESTABLISHED
    </text>

    <text x="20" y="80" fill="#00ff00" font-size="14" font-family="monospace">
      IP: ${ip}
    </text>

    <text x="20" y="110" fill="#00ff00" font-size="14" font-family="monospace">
      LOC: ${location}
    </text>

    <text x="20" y="140" fill="#00ff00" font-size="12" font-family="monospace">
      UA: ${ua.slice(0, 60)}
    </text>

    <text x="20" y="180" fill="#ff0000" font-size="14" font-family="monospace">
      TRACKING ACTIVE
    </text>
  </svg>
  `

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-cache'
    },
    body: svg
  }
}
