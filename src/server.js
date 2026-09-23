const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { getWebRTC } = require('./webrtc')

const { Connection } = require('./connection')
const { ErrorCode, SignalStructure, SignalType } = require('./signalling/messages')

const { PACKET_TYPE, createSerializer, createDeserializer } = require('./transforms/serializer')

const { getRandomUint64, normalizeIceServers, validateIceServers } = require('./util')
const { createPacketData, prepareSecurePacket, processSecurePacket } = require('./signalling/lan')

const debug = require('debug')('nethernet')
const DEFAULT_ACCEPT_TIMEOUT_MS = 5_000

const EXPECTED_CHANNELS = {
  ReliableDataChannel: {
    ordered: true,
    maxRetransmits: null
  },
  UnreliableDataChannel: {
    ordered: false,
    maxRetransmits: 0
  }
}

function isExpectedDataChannel (channel) {
  return Object.hasOwn(EXPECTED_CHANNELS, channel.label)
}

class Server extends EventEmitter {
  constructor (options = {}) {
    super()

    this.webrtc = getWebRTC(options.webrtcBackend)

    this.options = options

    this.networkId = options.networkId ?? getRandomUint64()
    this.credentials = normalizeIceServers(options.credentials ?? options.iceServers)
    this.acceptTimeoutMs = options.acceptTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS

    this.connections = new Map()
    this.acceptTimeouts = new Map()
    this._closed = false

    this.serializer = createSerializer()
    this.deserializer = createDeserializer()
  }

  handleConnectionClosed (connection, reason = 'disconnected') {
    if (this.connections.get(connection.address) !== connection) return
    this.clearAcceptTimeout(connection.address)
    this.connections.delete(connection.address)
    this.emit('closeConnection', connection.address, reason)
  }

  clearAcceptTimeout (connectionId) {
    const acceptTimeout = this.acceptTimeouts.get(connectionId)
    if (!acceptTimeout) {
      return
    }

    clearTimeout(acceptTimeout)
    this.acceptTimeouts.delete(connectionId)
  }

  armAcceptTimeout (connection, signal, respond) {
    this.clearAcceptTimeout(connection.address)

    if (this.acceptTimeoutMs <= 0) {
      return
    }

    const acceptTimeout = setTimeout(() => {
      this.acceptTimeouts.delete(connection.address)

      if (this.connections.get(connection.address) !== connection) {
        return
      }

      try {
        this.signalError(respond, signal, ErrorCode.NegotiationTimeoutWaitingForAccept)
      } catch (err) {
        debug('Failed to signal accept timeout:', err)
      }

      connection.close(`connecterror:${ErrorCode.NegotiationTimeoutWaitingForAccept}`)
    }, this.acceptTimeoutMs)

    this.acceptTimeouts.set(connection.address, acceptTimeout)
  }

  signalError (respond, signal, code) {
    respond(new SignalStructure(SignalType.ConnectError, signal.connectionId, String(code), signal.networkId))
  }

  async handleCandidate (signal, respond) {
    const conn = this.connections.get(signal.connectionId)

    if (conn) {
      try {
        const candidate = { candidate: signal.data, sdpMid: '0', sdpMLineIndex: 0 }
        await conn.rtcConnection.addIceCandidate(candidate)
        debug('Added remote ICE candidate')
      } catch (err) {
        debug('Failed to add remote candidate:', err)
        conn.close('candidateaddfailed')
        if (respond) {
          this.signalError(respond, signal, ErrorCode.CandidateAdd)
        }
      }
    } else {
      debug('Connection not found', signal.connectionId)
    }
  }

  async handleOffer (signal, respond, credentials = this.credentials) {
    if (this._closed || this.connections.has(signal.connectionId)) return
    let rtcConnection
    try {
      rtcConnection = new this.webrtc.RTCPeerConnection({ iceServers: validateIceServers(normalizeIceServers(credentials)) })
    } catch (err) {
      debug('Failed to create RTCPeerConnection:', err)
      this.signalError(respond, signal, ErrorCode.FailedToCreatePeerConnection)
      return
    }

    const connection = new Connection(this, signal.connectionId, rtcConnection)
    const registeredChannels = new Set()
    let hasEmittedOpen = false

    const emitOpenConnection = () => {
      if (hasEmittedOpen || registeredChannels.size !== Object.keys(EXPECTED_CHANNELS).length) {
        return
      }

      if (rtcConnection.connectionState !== 'connected') {
        return
      }

      this.clearAcceptTimeout(connection.address)
      hasEmittedOpen = true
      this.emit('openConnection', connection)
    }

    this.connections.set(signal.connectionId, connection)

    debug('Received offer', signal.connectionId)

    rtcConnection.onicecandidate = (event) => {
      if (event.candidate) {
        debug('Sending ICE candidate to client')
        const signalStruct = new SignalStructure(SignalType.CandidateAdd, signal.connectionId, event.candidate.candidate, signal.networkId)

        respond(signalStruct)
      }
    }

    rtcConnection.ondatachannel = (event) => {
      const channel = event.channel
      debug('Received data channel', channel.label)

      if (!isExpectedDataChannel(channel)) {
        debug('Invalid data channel opened', channel.label)
        this.signalError(respond, signal, ErrorCode.IncomingConnectionIgnored)
        connection.close('invaliddatachannel')
        return
      }

      if (registeredChannels.has(channel.label)) {
        debug('Duplicate data channel opened', channel.label)
        this.signalError(respond, signal, ErrorCode.IncomingConnectionIgnored)
        connection.close('duplicatedatachannel')
        return
      }

      channel.binaryType = 'arraybuffer'
      registeredChannels.add(channel.label)

      if (channel.label === 'ReliableDataChannel') connection.setChannels(channel)
      if (channel.label === 'UnreliableDataChannel') connection.setChannels(null, channel)

      emitOpenConnection()
    }

    rtcConnection.onconnectionstatechange = () => {
      const state = rtcConnection.connectionState
      debug('Server RTC state changed', state)
      if (state === 'connected') {
        emitOpenConnection()
      }
      if (state === 'closed' || state === 'disconnected' || state === 'failed') {
        connection.notifyClosed('disconnected')
      }
    }

    rtcConnection.oniceconnectionstatechange = () => {
      const state = rtcConnection.iceConnectionState
      debug('Server ICE state changed:', state)
      if (state === 'failed') {
        connection.notifyClosed('disconnected')
      }
    }

    try {
      const offer = { type: 'offer', sdp: signal.data }
      await rtcConnection.setRemoteDescription(offer)
      if (connection.closed) return
      debug('Set remote description (offer)')
    } catch (err) {
      debug('Failed to set remote description (offer):', err)
      if (connection.closed) return
      this.signalError(respond, signal, ErrorCode.FailedToSetRemoteDescription)
      connection.close('offerfailed')
      return
    }

    let answer
    try {
      answer = await rtcConnection.createAnswer()
      if (connection.closed) return
    } catch (err) {
      debug('Failed to create answer:', err)
      if (connection.closed) return
      this.signalError(respond, signal, ErrorCode.FailedToCreateAnswer)
      connection.close('answerfailed')
      return
    }

    try {
      await rtcConnection.setLocalDescription(answer)
      if (connection.closed) return
      debug('Created and set local description (answer)')
    } catch (err) {
      debug('Failed to set local description (answer):', err)
      if (connection.closed) return
      this.signalError(respond, signal, ErrorCode.FailedToSetLocalDescription)
      connection.close('answerfailed')
      return
    }

    try {
      respond(
        new SignalStructure(SignalType.ConnectResponse, signal.connectionId, rtcConnection.localDescription.sdp, signal.networkId)
      )
      this.armAcceptTimeout(connection, signal, respond)
    } catch (err) {
      debug('Failed to signal answer:', err)
      this.signalError(respond, signal, ErrorCode.SignalingFailedToSend)
      connection.close('signalingfailed')
    }
  }

  processPacket (buffer, rinfo) {
    try {
      const parsedPacket = processSecurePacket(buffer, this.deserializer)
      debug('Received packet', parsedPacket)

      switch (parsedPacket.name) {
        case 'discovery_request':
          this.handleRequest(rinfo)
          break
        case 'discovery_response':
          break
        case 'discovery_message':
          this.handleMessage(parsedPacket, rinfo)
          break
        default:
          throw new Error('Unknown packet type')
      }
    } catch (err) {
      debug('Dropping invalid discovery packet:', err)
    }
  }

  setAdvertisement (buffer) {
    this.advertisement = buffer
  }

  handleRequest (rinfo) {
    const data = this.advertisement

    if (!data) {
      throw new Error('Advertisement data not set yet')
    }

    const packetData = createPacketData('discovery_response', PACKET_TYPE.DISCOVERY_RESPONSE, this.networkId,
      {
        data: data.toString('hex')
      }
    )

    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, rinfo.port, rinfo.address)
  }

  handleMessage (packet, rinfo) {
    if (BigInt(packet.params.recipient_id).toString() !== this.networkId.toString()) {
      return
    }

    const data = packet.params.data
    debug('Received discovery message', data)
    if (data === 'Ping' || data === '') {
      return
    }

    const respond = (signal) => {
      const packetData = createPacketData('discovery_message', PACKET_TYPE.DISCOVERY_MESSAGE, this.networkId,
        {
          recipient_id: BigInt(signal.networkId),
          data: signal.toString()
        }
      )

      const packetToSend = prepareSecurePacket(this.serializer, packetData)
      this.socket.send(packetToSend, rinfo.port, rinfo.address)
    }

    const signal = SignalStructure.fromString(data)

    signal.networkId = packet.params.sender_id

    switch (signal.type) {
      case SignalType.ConnectRequest:
        this.handleOffer(signal, respond)
        break
      case SignalType.CandidateAdd:
        this.handleCandidate(signal, respond)
        break
      case SignalType.ConnectError:
        this.connections.get(signal.connectionId)?.close(`connecterror:${signal.data}`)
        break
    }
  }

  async listen () {
    if (this._closed) throw new Error('Server is closed; create a new Server')
    this.socket = dgram.createSocket('udp4')

    this.socket.on('message', (buffer, rinfo) => {
      this.processPacket(buffer, rinfo)
    })

    await new Promise((resolve, reject) => {
      const failFn = e => reject(e)
      this.socket.once('error', failFn)
      this.socket.bind(7551, this.options.host ?? '0.0.0.0', () => {
        this.socket.removeListener('error', failFn)
        resolve(true)
      })
    })
  }

  close (reason) {
    debug('Closing server', reason)
    if (this._closed) return
    this._closed = true
    for (const conn of this.connections.values()) {
      conn.close(reason)
    }
    const finish = () => {
      this.emit('close', reason)
      this.removeAllListeners()
    }
    if (!this.socket) return finish()
    this.socket.close(finish)
  }
}

module.exports = { Server }
