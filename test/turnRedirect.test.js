/* eslint-env mocha */
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { resolveTurnRedirects, probeTurnAlternate } = require('../src/turnRedirect')
const { Client } = require('../src/client')

function response (request, code = 300, ip = [192, 0, 2, 10]) {
  const packet = Buffer.alloc(40)
  request.copy(packet, 0, 0, 20)
  packet.writeUInt16BE(0x0113, 0)
  packet.writeUInt16BE(20, 2)
  packet.writeUInt16BE(9, 20)
  packet.writeUInt16BE(4, 22)
  packet[26] = Math.floor(code / 100)
  packet[27] = code % 100
  packet.writeUInt16BE(0x8023, 28)
  packet.writeUInt16BE(8, 30)
  packet[33] = 1
  packet.writeUInt16BE(3478, 34)
  Buffer.from(ip).copy(packet, 36)
  return packet
}

describe('TURN redirect probes', function () {
  this.timeout(5000)
  let relay
  let port
  beforeEach(async () => {
    relay = dgram.createSocket('udp4')
    relay.bind(0, '127.0.0.1')
    await once(relay, 'listening')
    port = relay.address().port
  })
  afterEach(async () => {
    const closed = once(relay, 'close')
    relay.close()
    await closed
  })

  it('sends Allocate and preserves credentials, URL shape and UDP query', async () => {
    relay.on('message', (request, peer) => {
      assert.equal(request.readUInt16BE(0), 3)
      assert.equal(request.readUInt32BE(4), 0x2112a442)
      assert.equal(request.readUInt16BE(20), 0x19)
      assert.equal(request[24], 17)
      relay.send(response(request), peer.port, peer.address)
    })
    const input = [{ urls: [`turn:127.0.0.1:${port}?transport=udp`], username: 'user', credential: 'secret' }]
    const output = await resolveTurnRedirects(input)
    assert.deepEqual(output, [{ urls: ['turn:192.0.2.10:3478?transport=udp'], username: 'user', credential: 'secret' }])
    assert.equal(input[0].urls[0], `turn:127.0.0.1:${port}?transport=udp`)
  })

  it('ignores a different sender and malformed/unmatched replies before a valid reply', async () => {
    const stranger = dgram.createSocket('udp4')
    let sends
    relay.once('message', (request, peer) => {
      sends = (async () => {
        stranger.send(response(request, 300, [192, 0, 2, 99]), peer.port, peer.address)
        const invalid = [Buffer.alloc(2)]
        for (const offset of [0, 4, 8]) {
          const packet = response(request)
          packet[offset] ^= 1
          invalid.push(packet)
        }
        const truncated = response(request)
        truncated.writeUInt16BE(24, 2)
        invalid.push(truncated)
        const badAttribute = response(request)
        badAttribute.writeUInt16BE(100, 30)
        invalid.push(badAttribute)
        for (const packet of invalid) relay.send(packet, peer.port, peer.address)
        await delay(30)
        relay.send(response(request), peer.port, peer.address)
      })()
    })
    try {
      assert.deepEqual(await probeTurnAlternate('127.0.0.1', port), { ip: '192.0.2.10', port: 3478 })
      await sends
    } finally {
      stranger.close()
    }
  })

  it('leaves a non-redirecting server unchanged', async () => {
    relay.on('message', (request, peer) => relay.send(response(request, 401), peer.port, peer.address))
    const input = [{ urls: `turn:127.0.0.1:${port}`, username: 'u', credential: 'p' }]
    assert.deepEqual(await resolveTurnRedirects(input), input)
  })

  it('does not probe TCP, TLS, STUN or unsupported URLs', async () => {
    let probes = 0
    relay.on('message', () => { probes++ })
    const urls = [
      `turn:127.0.0.1:${port}?transport=tcp`, `turns:127.0.0.1:${port}`,
      `stun:127.0.0.1:${port}`, 'turn:[::1]:3478', 'turn:127.0.0.1:99999',
      `turn:127.0.0.1:${port}?transport=unknown`
    ]
    assert.deepEqual(await resolveTurnRedirects([{ urls }]), [{ urls }])
    await delay(20)
    assert.equal(probes, 0)
  })

  it('retries after a timeout and refreshes successful redirects on later joins', async () => {
    const input = [{ urls: `turn:127.0.0.1:${port}` }]
    assert.deepEqual(await resolveTurnRedirects(input, { timeoutMs: 30 }), input)
    let attempts = 0
    relay.on('message', (request, peer) => {
      attempts++
      relay.send(response(request, 300, [192, 0, 2, attempts]), peer.port, peer.address)
    })
    assert.equal((await resolveTurnRedirects(input))[0].urls, 'turn:192.0.2.1:3478')
    assert.equal((await resolveTurnRedirects(input))[0].urls, 'turn:192.0.2.2:3478')
  })

  it('aborts an outstanding probe and does not start an already-aborted probe', async () => {
    const controller = new AbortController()
    const received = once(relay, 'message')
    const pending = probeTurnAlternate('127.0.0.1', port, { signal: controller.signal })
    await received
    controller.abort()
    assert.equal(await pending, null)
    let probes = 0
    relay.on('message', () => { probes++ })
    assert.equal(await probeTurnAlternate('127.0.0.1', port, { signal: controller.signal }), null)
    await delay(20)
    assert.equal(probes, 0)
  })

  it('does not create a peer after close during a probe', async () => {
    const client = new Client(1n, '127.0.0.1', {
      iceServers: [{ urls: `turn:127.0.0.1:${port}`, username: 'u', credential: 'p' }]
    })
    let peers = 0
    client.webrtc = { ...client.webrtc, RTCPeerConnection: class { constructor () { peers++ } } }
    try {
      const received = once(relay, 'message')
      const pending = client.createOffer()
      await received
      client.close()
      await pending
      assert.equal(peers, 0)
      assert.equal(client.rtcConnection, null)
    } finally { client.close() }
  })

  it('discards a timed-out attempt when a retry starts before its lookup settles', async () => {
    const client = new Client(1n, '127.0.0.1', { responseTimeoutMs: 20 })
    const lookups = []
    const configurations = []
    client.webrtc = {
      resolveIceServers: (servers, { signal }) => new Promise(resolve => lookups.push({ resolve, signal })),
      RTCPeerConnection: class {
        constructor (config) { configurations.push(config); throw new Error('stop test at peer creation') }
      }
    }
    client.signalHandler = () => {}
    client.on('error', () => {})
    try {
      const disconnected = once(client, 'disconnect')
      client.connect()
      await disconnected
      assert.equal(lookups[0].signal.aborted, true)
      client.responseTimeoutMs = 1000
      client.connect()
      lookups[1].resolve([{ urls: 'stun:new.example' }])
      await delay(0)
      lookups[0].resolve([{ urls: 'stun:old.example' }])
      await delay(0)
      assert.deepEqual(configurations, [{ iceServers: [{ urls: 'stun:new.example' }] }])
      assert.deepEqual(client.credentials, [])
    } finally { client.close() }
  })
})
