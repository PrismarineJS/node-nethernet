/* eslint-env mocha */
const assert = require('node:assert/strict')
const { Client, ErrorCode, Server, SignalStructure, SignalType } = require('nethernet')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function cleanupClient (client) {
  client.clearNegotiationTimeouts?.()
  clearInterval(client.pingInterval)
  client.socket.close()
}

function cleanupServer (server) {
  if (server.acceptTimeouts) {
    for (const acceptTimeout of server.acceptTimeouts.values()) {
      clearTimeout(acceptTimeout)
    }
    server.acceptTimeouts.clear()
  }

  if (server.socket) {
    server.socket.close()
  }
}

describe('signalling', function () {
  this.timeout(10000)

  it('signals CONNECTERROR when the client cannot apply an answer', async () => {
    const client = new Client(1n, '127.0.0.1')
    let outgoingSignal = null
    let closeReason = null

    client.signalHandler = (signal) => {
      outgoingSignal = signal
    }

    client.connection = {
      close: (reason) => {
        closeReason = reason
      }
    }

    client.rtcConnection = {
      setRemoteDescription: async () => {
        throw new Error('boom')
      }
    }

    try {
      await client.handleAnswer(new SignalStructure(SignalType.ConnectResponse, 1n, 'invalid-answer', 5n))
    } finally {
      cleanupClient(client)
    }

    assert.ok(outgoingSignal)
    assert.equal(outgoingSignal.type, SignalType.ConnectError)
    assert.equal(outgoingSignal.connectionId, client.connectionId)
    assert.equal(outgoingSignal.networkId, 5n)
    assert.equal(outgoingSignal.data, String(ErrorCode.FailedToSetRemoteDescription))
    assert.equal(closeReason, `connecterror:${ErrorCode.FailedToSetRemoteDescription}`)
  })

  it('ignores signals for a different connection id', () => {
    const client = new Client(1n, '127.0.0.1')
    let called = false

    client.handleAnswer = () => {
      called = true
    }

    try {
      client.handleSignal(new SignalStructure(SignalType.ConnectResponse, client.connectionId + 1n, 'answer', 1n))
    } finally {
      cleanupClient(client)
    }

    assert.equal(called, false)
  })

  it('signals CONNECTERROR when the server cannot apply an offer', async () => {
    const server = new Server()
    let outgoingSignal = null

    await server.handleOffer(
      new SignalStructure(SignalType.ConnectRequest, 7n, 'invalid-offer', 11n),
      (signal) => {
        outgoingSignal = signal
      }
    )

    assert.ok(outgoingSignal)
    assert.equal(outgoingSignal.type, SignalType.ConnectError)
    assert.equal(outgoingSignal.connectionId, 7n)
    assert.equal(outgoingSignal.networkId, 11n)
    assert.equal(outgoingSignal.data, String(ErrorCode.FailedToSetRemoteDescription))
  })

  it('signals CONNECTERROR when the client times out waiting for a response', async () => {
    const client = new Client(1n, '127.0.0.1', { responseTimeoutMs: 10 })
    let outgoingSignal = null
    let closeReason = null

    client.signalHandler = (signal) => {
      outgoingSignal = signal
    }

    client.createOffer = () => { }

    try {
      client.connect()
      client.connection = {
        close: (reason) => {
          closeReason = reason
        }
      }
      await delay(30)
    } finally {
      cleanupClient(client)
    }

    assert.ok(outgoingSignal)
    assert.equal(outgoingSignal.type, SignalType.ConnectError)
    assert.equal(outgoingSignal.data, String(ErrorCode.NegotiationTimeoutWaitingForResponse))
    assert.equal(closeReason, `connecterror:${ErrorCode.NegotiationTimeoutWaitingForResponse}`)
  })

  it('signals CONNECTERROR when the client becomes inactive after receiving an answer', async () => {
    const client = new Client(1n, '127.0.0.1', { inactivityTimeoutMs: 10 })
    let outgoingSignal = null
    let closeReason = null

    client.signalHandler = (signal) => {
      outgoingSignal = signal
    }

    client.connection = {
      close: (reason) => {
        closeReason = reason
      }
    }

    client.rtcConnection = {
      setRemoteDescription: async () => { }
    }

    try {
      await client.handleAnswer(new SignalStructure(SignalType.ConnectResponse, client.connectionId, 'v=0\r\n', 1n))
      await delay(30)
    } finally {
      cleanupClient(client)
    }

    assert.ok(outgoingSignal)
    assert.equal(outgoingSignal.type, SignalType.ConnectError)
    assert.equal(outgoingSignal.data, String(ErrorCode.InactivityTimeout))
    assert.equal(closeReason, `connecterror:${ErrorCode.InactivityTimeout}`)
  })

  it('preserves remote CONNECTERROR codes on the server close reason', () => {
    const server = new Server({ networkId: 11n })
    let closeReason = null

    server.connections.set(7n, {
      close: (reason) => {
        closeReason = reason
      }
    })

    server.handleMessage({
      params: {
        recipient_id: 11n,
        sender_id: 13n,
        data: new SignalStructure(SignalType.ConnectError, 7n, String(ErrorCode.CandidateAdd), 13n).toString()
      }
    }, { port: 19132, address: '127.0.0.1' })

    assert.equal(closeReason, `connecterror:${ErrorCode.CandidateAdd}`)
  })

  it('signals CONNECTERROR when the server times out waiting for accept', async () => {
    const server = new Server({ acceptTimeoutMs: 10 })
    let outgoingSignal = null
    let closeReason = null
    const connection = {
      address: 7n,
      close: (reason) => {
        closeReason = reason
      }
    }

    server.connections.set(7n, connection)

    try {
      server.armAcceptTimeout(
        connection,
        new SignalStructure(SignalType.ConnectRequest, 7n, 'offer', 11n),
        (signal) => {
          outgoingSignal = signal
        }
      )
      await delay(30)
    } finally {
      cleanupServer(server)
    }

    assert.ok(outgoingSignal)
    assert.equal(outgoingSignal.type, SignalType.ConnectError)
    assert.equal(outgoingSignal.data, String(ErrorCode.NegotiationTimeoutWaitingForAccept))
    assert.equal(closeReason, `connecterror:${ErrorCode.NegotiationTimeoutWaitingForAccept}`)
  })

  it('drops malformed discovery packets without throwing', () => {
    const client = new Client(1n, '127.0.0.1')
    const server = new Server()

    try {
      assert.doesNotThrow(() => client.processPacket(Buffer.alloc(1), { port: 19132, address: '127.0.0.1' }))
      assert.doesNotThrow(() => server.processPacket(Buffer.alloc(1), { port: 19132, address: '127.0.0.1' }))
    } finally {
      cleanupClient(client)
      cleanupServer(server)
    }
  })

  it('normalizes string ICE server URLs for the WebRTC backend', () => {
    const iceServerUrl = 'stun:stun.example.com:3478'
    const client = new Client(1n, '127.0.0.1', { iceServers: [iceServerUrl] })
    const server = new Server({ credentials: [iceServerUrl] })

    try {
      assert.deepEqual(client.credentials, [{ urls: iceServerUrl }])
      assert.deepEqual(server.credentials, [{ urls: iceServerUrl }])
    } finally {
      cleanupClient(client)
    }
  })

  it('reports invalid WebRTC configuration without an unhandled rejection', () => {
    const client = new Client(1n, '127.0.0.1', { iceServers: [null] })
    let reportedError = null
    let outgoingSignal = null

    client.once('error', error => {
      reportedError = error
    })
    client.signalHandler = signal => {
      outgoingSignal = signal
    }

    try {
      assert.doesNotThrow(() => client.connect())
      assert.match(reportedError.message, /Failed to create peer connection/)
      assert.equal(outgoingSignal.type, SignalType.ConnectError)
      assert.equal(outgoingSignal.data, String(ErrorCode.FailedToCreatePeerConnection))
    } finally {
      cleanupClient(client)
    }
  })
})
