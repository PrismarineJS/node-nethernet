'use strict'
// TURN "300 Try Alternate" pre-resolution (PoC).
//
// Microsoft's Realm relay (gateway-world.az.relay.communications.svc.cloud.microsoft) answers the initial TURN Allocate
// with STUN error 300 "Try Alternate" + an ALTERNATE-SERVER, redirecting the client to a regional relay. Native
// libwebrtc (@roamhq/wrtc) follows the redirect; the pure-JS werift backend does not, so on werift the allocation fails,
// no relay candidate is gathered, and the Realm connection times out.
//
// This resolves the redirect at the node-nethernet layer using only werift's SUPPORTED iceServers config: send one
// unauthenticated Allocate to each TURN server, and if it answers 300 + ALTERNATE-SERVER, rewrite the iceServer URL to
// point straight at the alternate. werift then does its normal (working) 401 auth handshake against the alternate.
// No werift internals are touched. Best-effort: any probe failure leaves the original URL unchanged.
const dgram = require('dgram')
const crypto = require('crypto')
const MAGIC = 0x2112a442

function buildAllocate () {
  const tid = crypto.randomBytes(12)
  const attr = Buffer.from([0x00, 0x19, 0x00, 0x04, 17, 0x00, 0x00, 0x00]) // REQUESTED-TRANSPORT = UDP
  const header = Buffer.alloc(20)
  header.writeUInt16BE(0x0003, 0) // Allocate request
  header.writeUInt16BE(attr.length, 2)
  header.writeUInt32BE(MAGIC, 4)
  tid.copy(header, 8)
  return Buffer.concat([header, attr])
}

function parseAttrs (msg) {
  const out = {}
  const mlen = msg.readUInt16BE(2)
  let off = 20
  while (off + 4 <= 20 + mlen) {
    const type = msg.readUInt16BE(off)
    const len = msg.readUInt16BE(off + 2)
    const val = msg.slice(off + 4, off + 4 + len)
    if (type === 0x0009 && val.length >= 4) { // ERROR-CODE
      out.errorCode = (val[2] & 0x07) * 100 + val[3]
    } else if (type === 0x8023 && val.length >= 8) { // ALTERNATE-SERVER (MAPPED-ADDRESS format, not XOR'd)
      const family = val[1]
      if (family === 0x01) out.alternate = { ip: Array.from(val.slice(4, 8)).join('.'), port: val.readUInt16BE(2) }
    }
    off += 4 + len + ((4 - (len % 4)) % 4)
  }
  return out
}

function probeTurnAlternate (host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false
    const sock = dgram.createSocket('udp4')
    const finish = (r) => { if (done) return; done = true; try { sock.close() } catch {} resolve(r) }
    const timer = setTimeout(() => finish(null), timeoutMs)
    sock.on('message', (msg) => { clearTimeout(timer); try { const a = parseAttrs(msg); finish(a.errorCode === 300 && a.alternate ? a.alternate : null) } catch { finish(null) } })
    sock.on('error', () => { clearTimeout(timer); finish(null) })
    try { sock.send(buildAllocate(), port, host) } catch { finish(null) }
  })
}

// Rewrite each plain-UDP `turn:` server that redirects via 300 to point at its ALTERNATE-SERVER. `turns:` (TLS) and
// `stun:` entries are left untouched. Results are cached per host:port so repeated connects probe at most once.
async function resolveTurnRedirects (iceServers, { timeoutMs = 3000, cache = resolveTurnRedirects._cache } = {}) {
  const out = []
  for (const server of iceServers || []) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    const rewritten = []
    for (const url of urls) {
      const m = /^turn:([^:/?]+)(?::(\d+))?(\?.*)?$/i.exec(url || '')
      if (!m) { rewritten.push(url); continue }
      const host = m[1]; const port = Number(m[2] || 3478); const query = m[3] || ''
      const key = host + ':' + port
      let alt = cache.get(key)
      if (alt === undefined) { alt = await probeTurnAlternate(host, port, timeoutMs); cache.set(key, alt) }
      rewritten.push(alt ? `turn:${alt.ip}:${alt.port}${query}` : url)
    }
    out.push({ ...server, urls: rewritten.length === 1 ? rewritten[0] : rewritten })
  }
  return out
}
resolveTurnRedirects._cache = new Map()

module.exports = { resolveTurnRedirects, probeTurnAlternate }
