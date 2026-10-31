// What counts as localhost for the evals (evals/lib/net.mjs) and the pi adapter's
// eval mode (harness/pi.mjs). Lives in lib/ because evals/ is not deployed.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLocalUrl(url) {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}
