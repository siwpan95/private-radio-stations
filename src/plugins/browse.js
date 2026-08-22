// browse plugin — search the global Radio-Browser.info directory.
import { Service } from 'cordis'

const ENDPOINT = 'https://de1.api.radio-browser.info/json/stations/search'

class BrowseService extends Service {
  constructor(ctx) {
    super(ctx, 'browse')
  }

  async search(query, limit = 20) {
    const q = encodeURIComponent(query || '')
    if (!q) return []
    const url = `${ENDPOINT}?name=${q}&limit=${limit}&hidebroken=true&order=votes&reverse=true`
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'private-radio/3.0' } })
      if (!resp.ok) return []
      const data = await resp.json()
      return (data || []).slice(0, limit).map((s) => ({
        name: s.name,
        url: s.url_resolved || s.url,
        bitrate: s.bitrate,
        country: s.country,
        genre: s.tags,
        codec: s.codec,
        listeners: s.listeners,
      }))
    } catch (e) {
      this.ctx.logger.warn(`browse error: ${e.message}`)
      return []
    }
  }
}

export default function browsePlugin(ctx) {
  ctx.plugin(BrowseService)
}
