/* eslint-env mocha */
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { execFileSync } = require('node:child_process')
const { Client, Server, ErrorCode, SignalType, SignalStructure } = require('nethernet')
const { Connection } = require('../src/connection')

describe('lifecycle', function () {
  this.timeout(10000)

  it('times out during discovery, ignores late responses, and allows a new attempt', async () => {
    const client = new Client(1n, '127.0.0.1', { responseTimeoutMs: 20 })
    try {
      const disconnected = once(client, 'disconnect')
      client.connect()
      const firstId = client.connectionId
      const [, reason] = await disconnected
      assert.equal(reason, `connecterror:${ErrorCode.NegotiationTimeoutWaitingForResponse}`)
      let offers = 0
      client.createOffer = async () => { offers++ }
      client.handleResponse({ params: { sender_id: 1n } }, { address: '127.0.0.1', port: 7551 })
      assert.equal(offers, 0)
      client.connect()
      assert.notEqual(client.connectionId, firstId)
      client.connect()
      assert.equal(offers, 1)
    } finally {
      client.close()
    }
  })

  it('cancels pending discovery and makes close safe before connect', () => {
    for (const connectFirst of [false, true]) {
      const client = new Client(1n, '127.0.0.1')
      if (connectFirst) client.connect()
      client.close()
      client.close()
      client.createOffer = () => assert.fail('cancelled discovery created an offer')
      client.handleResponse({ params: { sender_id: 1n } }, { address: '127.0.0.1', port: 7551 })
      assert.throws(() => client.connect(), /Client is closed/)
    }
    const server = new Server()
    server.close()
    server.close()
  })

  it('releases native resources once on remote close and rejects later sends', () => {
    let peerCloses = 0
    let channelCloses = 0
    let notifications = 0
    const conn = new Connection({ handleConnectionClosed: () => { notifications++ } }, 1n, {
      close: () => { peerCloses++ }
    })
    const channel = { close: () => { channelCloses++; channel.onclose() } }
    conn.setChannels(channel)
    conn.notifyClosed()
    conn.close()
    assert.equal(peerCloses, 1)
    assert.equal(channelCloses, 1)
    assert.equal(notifications, 1)
    assert.throws(() => conn.send(Buffer.from('late')), /closed/)
  })

  it('exits naturally after repeated offer cancellation without forced process exit', () => {
    execFileSync(process.execPath, ['-e', `
      const { Client } = require('./')
      async function run () {
        for (let i = 0; i < 3; i++) {
          const client = new Client(1n, '127.0.0.1')
          client.signalHandler = () => {}
          client.connect()
          await new Promise(resolve => setTimeout(resolve, 30))
          client.close()
        }
      }
      run().catch(error => { console.error(error); process.exitCode = 1 })
    `], { cwd: require('node:path').join(__dirname, '..'), timeout: 5000, stdio: 'pipe' })
  })

  it('reconnects and exchanges fragmented payloads over delayed external signalling', async () => {
    const server = new Server({ networkId: 1n })
    const client = new Client(1n, '127.0.0.1', { networkId: 2n })
    let inbound = Promise.resolve()
    let outbound = Promise.resolve()
    const delay = () => new Promise(resolve => setTimeout(resolve, 5))
    const respond = signal => {
      outbound = outbound.then(async () => {
        await delay()
        const incoming = new SignalStructure(signal.type, signal.connectionId, signal.data, server.networkId)
        if (signal.type === SignalType.ConnectResponse) await client.handleAnswer(incoming)
        else if (signal.type === SignalType.CandidateAdd) await client.handleCandidate(incoming)
        else client.handleSignal(incoming)
      })
    }
    client.signalHandler = signal => {
      inbound = inbound.then(async () => {
        await delay()
        const incoming = new SignalStructure(signal.type, signal.connectionId, signal.data, client.networkId)
        if (signal.type === SignalType.ConnectRequest) await server.handleOffer(incoming, respond)
        else if (signal.type === SignalType.CandidateAdd) await server.handleCandidate(incoming, respond)
      })
    }
    try {
      let previousId
      for (let i = 0; i < 2; i++) {
        const connected = once(client, 'connected')
        const opened = once(server, 'openConnection')
        client.connect()
        const [[connection], [remote]] = await Promise.all([connected, opened])
        assert.notEqual(connection.address, previousId)
        previousId = connection.address
        const received = once(server, 'encapsulated')
        const payload = Buffer.alloc(25000, i + 1)
        client.send(payload)
        const [actual] = await received
        assert.deepEqual(actual, payload)
        await inbound
        await outbound
        const disconnected = once(client, 'disconnect')
        remote.close()
        await disconnected
        await connection.rtcConnection.close()
        assert.equal(connection.rtcConnection.connectionState, 'closed')
        assert.equal(server.connections.size, 0)
      }
    } finally {
      client.close()
      server.close()
      await inbound
      await outbound
    }
  })
})
