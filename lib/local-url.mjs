// The localhost guard shared by the evals and the pi adapter's eval mode.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLocalUrl(url) {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

// Throws if any { name: url } entry is not a localhost URL. The evals must never
// reach a real Fermi, chat API or Mac.
export function assertLocalUrls(urls) {
  const bad = Object.entries(urls).filter(([, url]) => url != null && !isLocalUrl(url))
  if (bad.length) {
    throw new Error(`refusing to start: non-localhost URL(s) configured: ${bad.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
}
