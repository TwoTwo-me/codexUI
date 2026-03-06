function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '')
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '127.0.0.1'
    || normalized.startsWith('127.')
}

export function normalizeHubAddress(
  value: string,
  options?: { allowInsecureHttp?: boolean },
): string {
  const rawValue = value.trim()
  if (!rawValue) return ''

  try {
    const parsed = new URL(rawValue)
    const allowInsecureHttp = options?.allowInsecureHttp === true
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return ''
    }
    if (parsed.protocol === 'http:' && !allowInsecureHttp && !isLoopbackHostname(parsed.hostname)) {
      return ''
    }
    parsed.hash = ''
    parsed.search = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/'
    return parsed.toString().replace(/\/$/u, '')
  } catch {
    return ''
  }
}
