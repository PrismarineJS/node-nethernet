/* eslint-env mocha */
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { execFileSync } = require('node:child_process')
const { generateKeyPairSync } = require('node:crypto')
const { Client, Server } = require('nethernet')
const { getWebRTC } = require('../src/webrtc')

const backends = process.env.TEST_NATIVE_WEBRTC ? ['werift', 'wrtc'] : ['werift']

describe('WebRTC backends', function () {
  this.timeout(15000)

  it('defaults to pure JS and falls back only when loading auto fails', () => {
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict')
      const Module = require('node:module')
      const load = Module._load
      let attempts = 0
      Module._load = function (name, ...args) {
        if (name === '@roamhq/wrtc') {
          attempts++
          throw new Error('native unavailable')
        }
        return load.call(this, name, ...args)
      }
      const { getWebRTC } = require('./src/webrtc')
      const pure = getWebRTC()
      assert.equal(attempts, 0)
      assert.equal(getWebRTC('auto'), pure)
      assert.equal(attempts, 1)
      assert.throws(() => getWebRTC('wrtc'), error => {
        assert(error.message.includes('working @roamhq/wrtc installation'))
        assert.equal(error.cause.message, 'native unavailable')
        return true
      })
      assert.throws(() => getWebRTC('typo'), /Unknown WebRTC backend/)
    `], { cwd: require('node:path').join(__dirname, '..'), timeout: 5000, stdio: 'pipe' })
  })

  if (process.env.TEST_NATIVE_WEBRTC) {
    it('auto selects an installed native backend', () => {
      assert.equal(getWebRTC('auto'), require('@roamhq/wrtc'))
      assert.equal(getWebRTC('auto').resolveIceServers, undefined)
      assert.equal(getWebRTC('wrtc').resolveIceServers, undefined)
    })
  }

  for (const clientBackend of backends) {
    for (const serverBackend of backends) {
      it(`${clientBackend} client / ${serverBackend} server: identity, packets, disconnect and reconnect`, async () => {
        const server = new Server({ webrtcBackend: serverBackend, host: '127.0.0.1' })
        server.setAdvertisement(Buffer.from('backend test'))
        await server.listen()
        const identity = { privateKey: generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey, token: 'test-token' }
        const client = new Client(server.networkId, '127.0.0.1', { webrtcBackend: clientBackend, identity })
        const sendSignal = client.signalHandler
        let signedOffers = 0
        client._signalHandler = signal => {
          if (signal.type === 'CONNECTREQUEST') {
            assert.match(signal.data, /a=identity:/)
            signedOffers++
          }
          sendSignal(signal)
        }
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const opened = once(server, 'openConnection')
            const connected = once(client, 'connected')
            client.connect()
            const [[remote], [local]] = await Promise.all([opened, connected])
            assert.equal(local.reliable.ordered, true)
            assert.equal(local.unreliable.ordered, false)
            assert.equal(local.unreliable.maxRetransmits, 0)
            assert.equal(remote.unreliable.maxRetransmits, 0)
            assert.equal(remote.unreliable.ordered, false)
            const payload = Buffer.alloc(25000, attempt + 1)
            const received = once(server, 'encapsulated')
            client.send(payload)
            assert.deepEqual((await received)[0], payload)
            const echoed = once(client, 'encapsulated')
            remote.send(payload)
            assert.deepEqual((await echoed)[0], payload)
            const disconnected = once(client, 'disconnect')
            remote.close()
            await disconnected
            assert.equal(server.connections.size, 0)
          }
          assert.equal(signedOffers, 2)
        } finally {
          client.close()
          const closed = once(server, 'close')
          server.close()
          await closed
        }
      })
    }
  }
})
