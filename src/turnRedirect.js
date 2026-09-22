const dgram = require('node:dgram')
const { randomBytes } = require('node:crypto')
const { isIP } = require('node:net')

const MAGIC = 0x2112a442
const ALLOCATE_ERROR = 0x0113
const ERROR_CODE = 0x0009
const ALTERNATE_SERVER = 0x8023
const PROBE_TIMEOUT_MS = 3000

// Only IPv4 UDP TURN is handled here. TCP/TLS and IPv6 stay with the backend.
function parseTurnUrl (url) {
  if (typeof url !== 'string') return null
  const match = /^turn:([^:/?]+)(?::(\d+))?(\?transport=udp)?$/i.exec(url)
  if (!match || match[1].includes('[')) return null
  const port = Number(match[2] || 3478)
  if (port < 1 || port > 65535) return null
  return { host: match[1], port, query: match[3] || '' }
}

function parseRedirect (msg, request) {
  if (msg.length < 20 || msg.readUInt16BE(0) !== ALLOCATE_ERROR ||
      msg.readUInt32BE(4) !== MAGIC || !msg.subarray(8, 20).equals(request.subarray(8, 20))) return
  const length = msg.readUInt16BE(2)
  if (length % 4 || length + 20 !== msg.length) return
  let code
  let alternate
  for (let offset = 20; offset < msg.length;) {
    if (offset + 4 > msg.length) return
    const type = msg.readUInt16BE(offset)
    const size = msg.readUInt16BE(offset + 2)
    const end = offset + 4 + size
    const next = end + ((4 - size % 4) % 4)
    if (next > msg.length) return
    const value = msg.subarray(offset + 4, end)
    if (type === ERROR_CODE) {
      if (size < 4) return
      code = (value[2] & 7) * 100 + value[3]
    } else if (type === ALTERNATE_SERVER) {
      if (size === 8 && value[1] === 1) {
        alternate = { ip: [...value.subarray(4)].join('.'), port: value.readUInt16BE(2) }
      }
    }
    offset = next
  }
  if (code === undefined) return
  // null means a matched response without a usable redirect; undefined is invalid.
  return code === 300 && alternate?.port ? alternate : null
}

function probeTurnAlternate (host, port, { timeoutMs = PROBE_TIMEOUT_MS, signal } = {}) {
  if (signal?.aborted || isIP(host) === 6) return Promise.resolve(null)
  const request = Buffer.alloc(28)
  request.writeUInt16BE(3, 0) // Allocate request
  request.writeUInt16BE(8, 2)
  request.writeUInt32BE(MAGIC, 4)
  randomBytes(12).copy(request, 8)
  request.writeUInt16BE(0x0019, 20) // REQUESTED-TRANSPORT: UDP relay allocation
  request.writeUInt16BE(4, 22)
  request[24] = 17

  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4')
    let done = false
    const finish = result => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try { socket.close() } catch (error) {
        if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error
      }
      resolve(result)
    }
    const onAbort = () => finish(null)
    const timer = setTimeout(() => finish(null), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('error', () => finish(null))
    socket.on('message', msg => {
      const result = parseRedirect(msg, request)
      if (result !== undefined) finish(result)
    })
    // Connecting filters packets from other endpoints, including different ports.
    try {
      socket.connect(port, host, () => {
        if (!done) socket.send(request, error => { if (error) finish(null) })
      })
    } catch {
      finish(null)
    }
  })
}

// Werift does not follow the Realm gateway's TURN 300 redirect. Resolve it using
// an unauthenticated probe, then let Werift authenticate with the alternate.
// Do not cache: gateway assignments and network failures can change between joins.
async function resolveTurnRedirects (iceServers, options = {}) {
  return Promise.all(iceServers.map(async server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    const rewritten = await Promise.all(urls.map(async url => {
      const target = parseTurnUrl(url)
      if (!target) return url
      const alternate = await probeTurnAlternate(target.host, target.port, options)
      return alternate ? `turn:${alternate.ip}:${alternate.port}${target.query}` : url
    }))
    return { ...server, urls: Array.isArray(server.urls) ? rewritten : rewritten[0] }
  }))
}

module.exports = { resolveTurnRedirects, probeTurnAlternate }
