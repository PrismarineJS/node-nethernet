/* eslint-env mocha */
const assert = require('assert')
const { resolveTurnRedirects } = require('../src/turnRedirect')

// Network-free tests: seed the per-call cache so no STUN probe is sent. resolveTurnRedirects should rewrite a plain
// turn: URL to its cached ALTERNATE-SERVER, leave a non-redirecting turn: URL as-is, and never touch turns:/stun:.
describe('turnRedirect.resolveTurnRedirects', function () {
  it('rewrites a turn: URL that redirects (300 Try Alternate) to its alternate', async function () {
    const cache = new Map([['gateway-world.example:3478', { ip: '20.202.32.149', port: 3478 }]])
    const out = await resolveTurnRedirects([{ urls: 'turn:gateway-world.example:3478', username: 'u', credential: 'p' }], { cache })
    assert.strictEqual(out[0].urls, 'turn:20.202.32.149:3478')
    assert.strictEqual(out[0].username, 'u') // credentials preserved
  })

  it('leaves a turn: URL unchanged when there is no redirect', async function () {
    const cache = new Map([['relay.example:3478', null]])
    const out = await resolveTurnRedirects([{ urls: 'turn:relay.example:3478' }], { cache })
    assert.strictEqual(out[0].urls, 'turn:relay.example:3478')
  })

  it('never probes or rewrites turns: (TLS) or stun: URLs', async function () {
    const cache = new Map()
    const out = await resolveTurnRedirects([
      { urls: 'turns:secure.example:5349' },
      { urls: 'stun:stun.example:3478' }
    ], { cache })
    assert.strictEqual(out[0].urls, 'turns:secure.example:5349')
    assert.strictEqual(out[1].urls, 'stun:stun.example:3478')
    assert.strictEqual(cache.size, 0) // nothing probed
  })

  it('preserves a query string on a rewritten turn: URL', async function () {
    const cache = new Map([['g.example:3478', { ip: '1.2.3.4', port: 3479 }]])
    const out = await resolveTurnRedirects([{ urls: 'turn:g.example:3478?transport=udp' }], { cache })
    assert.strictEqual(out[0].urls, 'turn:1.2.3.4:3479?transport=udp')
  })
})
