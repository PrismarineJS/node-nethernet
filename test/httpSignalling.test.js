/* eslint-env mocha */
const assert = require('assert')
const http = require('http')
const { once } = require('events')
const { generateKeyPairSync } = require('crypto')
const JWT = require('jsonwebtoken')
const { Client, pingHttp } = require('..')
const { verifyServerIdentity } = require('../src/signalling/sdpIdentity')
const { signallingUrl } = require('../src/signalling/http')

const keys = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
const digest = 'AA:BB:CC:DD'
function signedAnswer ({ expiresIn = 60, wrongSigner = false } = {}) {
  const cpk = keys.publicKey.export({ format: 'jwk' })
  const token = JWT.sign({ cpk }, keys.privateKey, { algorithm: 'ES384', expiresIn })
  const signer = wrongSigner ? generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey : keys.privateKey
  const signature = JWT.sign({ fingerprint: [{ algorithm: 'sha-256', digest }] }, signer, { algorithm: 'ES384', noTimestamp: true }).split('.')
  const assertion = JSON.stringify({ token, fingerprints: `${signature[0]}..${signature[2]}` })
  const identity = Buffer.from(JSON.stringify({ idp: { protocol: 'default', domain: 'untrusted-display-name' }, assertion })).toString('base64')
  return `v=0\r\na=fingerprint:sha-256 ${digest}\r\na=identity:${identity}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`
}

function createTestClient ({ http, responseTimeoutMs = 5000 }) {
  return new Client(0n, '127.0.0.1', {
    http,
    responseTimeoutMs,
    identity: { privateKey: keys.privateKey, token: JWT.sign({ cpk: keys.publicKey.export({ format: 'jwk' }) }, keys.privateKey, { algorithm: 'ES384' }) }
  })
}

// Fixtures use real signatures; the public-key pin is independent of token claims.
describe('Nethernet HTTP identity', () => {
  it('verifies signatures, strips the assertion, and keeps the key fingerprint stable across tokens', () => {
    const first = verifyServerIdentity(signedAnswer())
    const second = verifyServerIdentity(signedAnswer({ expiresIn: 120 }))
    assert.match(first.fingerprint, /^sha256:[a-f0-9]{64}$/)
    assert.strictEqual(first.fingerprint, second.fingerprint)
    assert(!first.sdp.includes('a=identity:'))
    assert(first.sdp.includes(`a=fingerprint:sha-256 ${digest}`))
  })
  for (const [name, change] of [
    ['missing assertion', sdp => sdp.replace(/^a=identity:.*\r\n/m, '')],
    ['duplicate assertion', sdp => sdp + sdp.match(/^a=identity:.*$/m)[0]],
    ['changed DTLS fingerprint', sdp => sdp.replace(digest, '01:02:03:04')],
    ['missing DTLS fingerprint', sdp => sdp.replace(/^a=fingerprint:.*\r\n/m, '')],
    ['expired token', () => signedAnswer({ expiresIn: -60 })],
    ['wrong fingerprint signer', () => signedAnswer({ wrongSigner: true })]
  ]) {
    it(`rejects ${name}`, () => assert.throws(() => verifyServerIdentity(change(signedAnswer()))))
  }
})

describe('Nethernet HTTP discovery and trust', function () {
  this.timeout(10000)
  let server, client
  const originalFetch = fetch
  afterEach(async () => {
    global.fetch = originalFetch
    client?.close()
    client = undefined
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      server = undefined
    }
  })
  async function listen (handler) {
    server = http.createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return { http: { url: `http://127.0.0.1:${server.address().port}` } }
  }

  it('preserves optional discovery metadata and empty responses', async () => {
    let body = ''
    const options = await listen((req, res) => res.end(body))
    assert.deepStrictEqual(await pingHttp(options.http.url), { raw: '' })
    body = JSON.stringify({ name: 'Test', protocol: 2193 })
    assert.deepStrictEqual(await pingHttp(options.http.url), { name: 'Test', protocol: 2193, raw: body })
  })

  it('aborts HTTP discovery with the caller’s reason', async () => {
    const options = await listen(() => {})
    const controller = new AbortController()
    const pending = pingHttp(options.http.url, { signal: controller.signal })
    await once(server, 'request')
    const reason = new Error('cancel HTTP discovery')
    controller.abort(reason)
    await assert.rejects(pending, error => error === reason)
  })

  it('does not follow discovery redirects', async () => {
    const options = await listen((req, res) => {
      res.writeHead(302, { location: '/elsewhere' })
      res.end()
    })
    await assert.rejects(pingHttp(options.http.url), /fetch failed/)
  })

  it('rejects non-HTTP origins and paths', () => {
    assert.throws(() => signallingUrl('ftp://example.com'), /HTTP\(S\) origin/)
    assert.throws(() => signallingUrl('https://example.com/path'), /HTTP\(S\) origin/)
  })

  it('posts a complete signed offer and reports numeric rejections', async () => {
    let request
    let body = ''
    const options = await listen((req, res) => {
      request = req
      req.on('data', data => { body += data })
      req.on('end', () => res.end('37'))
    })
    client = createTestClient(options)
    const failure = once(client, 'error')
    client.connect()
    assert.match((await failure)[0].message, /rejected the offer: 37/)
    assert.strictEqual(request.headers['content-type'], 'application/sdp')
    assert.match(request.url, /^\/v1\/join\/\d+$/)
    assert.match(body, /^a=candidate:/m)
    assert(body.indexOf('a=identity:') < body.indexOf('m='))
    verifyServerIdentity(body)
    assert.strictEqual(client.pingInterval, undefined)
    assert.strictEqual(client._closed, true)
  })

  it('aborts an outstanding exchange on close', async () => {
    const options = await listen(() => {})
    client = createTestClient(options)
    client.on('error', error => { throw error })
    const request = once(server, 'request')
    client.connect()
    const [req, res] = await request
    req.resume()
    const closed = once(res, 'close')
    client.close()
    await closed
  })

  it('bounds an approval callback that never finishes', async () => {
    const options = await listen((req, res) => { req.resume(); res.end(signedAnswer()) })
    let prompted
    const prompt = new Promise(resolve => { prompted = resolve })
    options.responseTimeoutMs = 1500
    options.http.onServerKey = () => { prompted(); return new Promise(() => {}) }
    client = createTestClient(options)
    const failure = once(client, 'disconnect')
    client.connect()
    await prompt
    assert.match((await failure)[1], /connecterror:/)
    assert.strictEqual(client.connection, null)
  })

  it('does not apply an answer approved after the client closes', async () => {
    const options = await listen((req, res) => { req.resume(); res.end(signedAnswer()) })
    let approve, prompted
    const prompt = new Promise(resolve => { prompted = resolve })
    options.http.onServerKey = () => { prompted(); return new Promise(resolve => { approve = resolve }) }
    client = createTestClient(options)
    let applied = false
    client.handleAnswer = async () => { applied = true }
    client.on('error', error => { throw error })
    client.connect()
    await prompt
    client.close()
    approve(true)
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(applied, false)
  })

  for (const valid of [true, false]) {
    it(`checks the identity on HTTPS even with TLS trust (${valid ? 'valid' : 'invalid'} signature)`, async () => {
      global.fetch = async () => new Response(signedAnswer({ wrongSigner: !valid }))
      client = createTestClient({
        http: {
          url: 'https://server.example.com',
          onServerKey: () => { throw new Error('HTTPS must not prompt for an unknown key') }
        }
      })
      const received = new Promise(resolve => { client.handleAnswer = async ({ data }) => resolve(data) })
      const failure = once(client, 'error')
      client.connect()
      if (valid) assert(!(await received).includes('a=identity:'))
      else assert.match((await failure)[0].message, /invalid signature/)
    })
  }

  for (const policy of ['unknown', 'pinned', 'wrong-pin', 'approve', 'deny']) {
    it(`handles the ${policy} server-key policy before applying the SDP`, async () => {
      const answer = signedAnswer()
      const fingerprint = verifyServerIdentity(answer).fingerprint
      const options = await listen((req, res) => { req.resume(); res.end(answer) })
      let approvals = 0
      options.http.serverKey = policy === 'pinned' ? fingerprint : policy === 'wrong-pin' ? 'sha256:wrong' : undefined
      options.http.onServerKey = policy === 'unknown' ? undefined : async key => { approvals++; assert.strictEqual(key, fingerprint); return policy !== 'deny' }
      client = createTestClient(options)
      const received = new Promise(resolve => { client.handleAnswer = async ({ data }) => resolve(data) })
      const failure = once(client, 'error')
      client.connect()
      if (policy === 'pinned' || policy === 'approve') {
        const sdp = await received
        assert(!sdp.includes('a=identity:'))
        assert.strictEqual(approvals, policy === 'approve' ? 1 : 0)
      } else {
        assert.match((await failure)[0].message, /Untrusted Nethernet server key/)
        assert.strictEqual(approvals, policy === 'deny' ? 1 : 0)
      }
    })
  }
})
