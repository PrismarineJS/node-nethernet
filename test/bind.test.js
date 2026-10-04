/* eslint-env mocha */
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { Server } = require('nethernet')

describe('discovery bind address', () => {
  for (const host of [undefined, '127.0.0.1']) {
    it(`binds to ${host ?? 'all IPv4 interfaces by default'}`, async () => {
      const server = new Server({ host })
      try {
        await server.listen()
        assert.equal(server.socket.address().address, host ?? '0.0.0.0')
        assert.equal(server.socket.address().port, 7551)
      } finally {
        const closed = once(server, 'close')
        server.close()
        await closed
      }
    })
  }
})
