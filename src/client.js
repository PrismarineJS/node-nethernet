const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { Connection } = require('./connection')
const { ErrorCode, SignalType, SignalStructure } = require('./signalling')

const { getRandomUint64, normalizeIceServers, createPacketData, prepareSecurePacket, processSecurePacket } = require('./util')
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('@roamhq/wrtc')
const { PACKET_TYPE, createSerializer, createDeserializer } = require('./serializer')

const debug = require('debug')('nethernet')

const PORT = 7551
const BROADCAST_ADDRESS = '255.255.255.255'
const SOCKET_CLOSE_TIMEOUT_MS = 100
const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5_000

class Client extends EventEmitter {
  constructor (networkId, broadcastAddress = BROADCAST_ADDRESS, options = {}) {
    super()

    this.serverNetworkId = networkId

    this.broadcastAddress = broadcastAddress

    this.networkId = options.networkId ?? getRandomUint64()

    this.connectionId = options.connectionId ?? getRandomUint64()

    this.socket = dgram.createSocket('udp4')

    this.socket.on('message', (buffer, rinfo) => {
      this.processPacket(buffer, rinfo)
    })

    this.socket.bind(() => {
      this.socket.setBroadcast(true)
    })

    this.serializer = createSerializer()
    this.deserializer = createDeserializer()

    this.responses = new Map()
    this.addresses = new Map()

    this.credentials = normalizeIceServers(options.credentials ?? options.iceServers)
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS

    this._signalHandler = this.sendDiscoveryMessage.bind(this)

    this.sendDiscoveryRequest()

    this.pingInterval = setInterval(() => {
      this.sendDiscoveryRequest()
    }, 2000)

    this._hasEmittedConnected = false
    this._pendingConnect = false
    this._externalSignaling = false
    this._negotiationTimeout = null
  }

  // Auto-detect external signalling when handler is replaced
  set signalHandler (handler) {
    this._signalHandler = handler
    this._externalSignaling = true
    debug('Signal handler set, external signaling:', this._externalSignaling)
  }

  get signalHandler () {
    return this._signalHandler
  }

  reportError (error) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    } else {
      debug(error)
    }
  }

  startOffer () {
    try {
      const result = this.createOffer()
      result?.catch?.(err => this.reportError(err))
    } catch (err) {
      this.reportError(err)
    }
  }

  handleConnectionClosed (connection, reason = 'disconnected') {
    this.clearNegotiationTimeouts()

    if (this.connection === connection) {
      this.connection = null
    }
    if (this.rtcConnection === connection.rtcConnection) {
      this.rtcConnection = null
    }
    this.emit('disconnect', connection.address, reason)
  }

  signalError (networkId, code) {
    if (networkId == null) {
      return
    }

    this._signalHandler(new SignalStructure(SignalType.ConnectError, this.connectionId, String(code), networkId))
  }

  clearNegotiationTimeouts () {
    if (this._negotiationTimeout) {
      clearTimeout(this._negotiationTimeout)
      this._negotiationTimeout = null
    }
  }

  armNegotiationTimeout (code, timeoutMs) {
    this.clearNegotiationTimeouts()

    if (timeoutMs <= 0) {
      return
    }

    this._negotiationTimeout = setTimeout(() => {
      this.failNegotiation(this.serverNetworkId, code)
    }, timeoutMs)
  }

  failNegotiation (networkId, code) {
    this.clearNegotiationTimeouts()

    try {
      this.signalError(networkId, code)
    } catch (err) {
      debug('Failed to signal local error:', err)
    }

    const reason = `connecterror:${code}`

    if (this.connection) {
      this.connection.close(reason)
      return
    }

    this.rtcConnection?.close()
    this.rtcConnection = null
  }

  isExpectedSignal (signal) {
    if (signal.connectionId?.toString() !== this.connectionId.toString()) {
      debug('Ignoring signal for unexpected connection:', signal.connectionId)
      return false
    }

    if (signal.networkId != null && signal.networkId.toString() !== this.serverNetworkId.toString()) {
      debug('Ignoring signal from unexpected network:', signal.networkId)
      return false
    }

    return true
  }

  async handleCandidate (signal) {
    try {
      if (!this.rtcConnection) {
        debug('No RTC connection, ignoring candidate')
        return
      }

      const candidate = new RTCIceCandidate({ candidate: signal.data, sdpMid: '0', sdpMLineIndex: 0 })

      await this.rtcConnection.addIceCandidate(candidate)
      debug('Added remote ICE candidate')
    } catch (err) {
      debug('Failed to add remote candidate:', err)
      this.failNegotiation(signal.networkId, ErrorCode.CandidateAdd)
    }
  }

  async handleAnswer (signal) {
    this.clearNegotiationTimeouts()

    try {
      const answer = new RTCSessionDescription({ type: 'answer', sdp: signal.data })
      await this.rtcConnection.setRemoteDescription(answer)
      debug('Set remote description (answer)')
      this.armNegotiationTimeout(ErrorCode.InactivityTimeout, this.inactivityTimeoutMs)
    } catch (err) {
      debug('Failed to set remote description:', err)
      this.failNegotiation(signal.networkId, ErrorCode.FailedToSetRemoteDescription)
    }
  }

  async createOffer () {
    debug('Creating RTCPeerConnection with ICE servers:', this.credentials)

    try {
      this.rtcConnection = new RTCPeerConnection({ iceServers: this.credentials })
    } catch (err) {
      debug('Failed to create RTCPeerConnection:', err)
      this.failNegotiation(this.serverNetworkId, ErrorCode.FailedToCreatePeerConnection)
      this.reportError(new Error(`Failed to create peer connection: ${err.message}`))
      return
    }
    const rtcConnection = this.rtcConnection

    this.connection = new Connection(this, this.connectionId, rtcConnection)

    rtcConnection.onicecandidate = (event) => {
      if (event.candidate) {
        debug('Sending CandidateAdd to networkId:', this.serverNetworkId)
        const signal = new SignalStructure(SignalType.CandidateAdd, this.connectionId, event.candidate.candidate, this.serverNetworkId)

        this._signalHandler(signal)
      }
    }

    rtcConnection.onconnectionstatechange = () => {
      const state = rtcConnection.connectionState
      debug('Client connection state changed:', state)
      if (state === 'connected' && !this._hasEmittedConnected) {
        this.clearNegotiationTimeouts()
        this._hasEmittedConnected = true
        this.emit('connected', this.connection)
      }
      if (state === 'closed' || state === 'disconnected' || state === 'failed') {
        this.connection?.notifyClosed('disconnected')
      }
    }

    rtcConnection.oniceconnectionstatechange = () => {
      const state = rtcConnection.iceConnectionState
      debug('Client ICE state changed:', state)
      if (state === 'failed') {
        this.connection?.notifyClosed('disconnected')
      }
    }

    const reliableChannel = rtcConnection.createDataChannel('ReliableDataChannel', { ordered: true })
    const unreliableChannel = rtcConnection.createDataChannel('UnreliableDataChannel', { ordered: false, maxRetransmits: 0 })

    reliableChannel.binaryType = 'arraybuffer'
    unreliableChannel.binaryType = 'arraybuffer'

    this.connection.setChannels(reliableChannel, unreliableChannel)

    let offer
    try {
      offer = await this.rtcConnection.createOffer()
    } catch (err) {
      debug('Failed to create offer:', err)
      this.failNegotiation(this.serverNetworkId, ErrorCode.FailedToCreateOffer)
      this.reportError(new Error(`Failed to create offer: ${err.message}`))
      return
    }

    try {
      await this.rtcConnection.setLocalDescription(offer)
    } catch (err) {
      debug('Failed to set local description:', err)
      this.failNegotiation(this.serverNetworkId, ErrorCode.FailedToSetLocalDescription)
      this.reportError(new Error(`Failed to set local description: ${err.message}`))
      return
    }

    try {
      const localDesc = this.rtcConnection.localDescription

      this._signalHandler(
        new SignalStructure(SignalType.ConnectRequest, this.connectionId, localDesc.sdp, this.serverNetworkId)
      )
    } catch (err) {
      debug('Failed to signal offer:', err)
      this.failNegotiation(this.serverNetworkId, ErrorCode.SignalingFailedToSend)
      this.reportError(new Error(`Failed to signal offer: ${err.message}`))
    }
  }

  processPacket (buffer, rinfo) {
    try {
      const parsedPacket = processSecurePacket(buffer, this.deserializer)
      debug('Received packet', parsedPacket)

      switch (parsedPacket.name) {
        case 'discovery_request':
          break
        case 'discovery_response':
          this.handleResponse(parsedPacket, rinfo)
          break
        case 'discovery_message':
          this.handleMessage(parsedPacket)
          break
        default:
          throw new Error('Unknown packet type')
      }
    } catch (err) {
      debug('Dropping invalid discovery packet:', err)
    }
  }

  handleResponse (packet, rinfo) {
    const senderId = BigInt(packet.params.sender_id)
    this.addresses.set(senderId, rinfo)
    this.responses.set(senderId, packet.params)
    this.emit('pong', packet.params)

    // If connect() was called before discovery completed, initiate connection now
    const serverIdMatches = senderId.toString() === this.serverNetworkId.toString()
    if (this._pendingConnect && serverIdMatches) {
      this._pendingConnect = false
      this.armNegotiationTimeout(ErrorCode.NegotiationTimeoutWaitingForResponse, this.responseTimeoutMs)
      this.startOffer()
    }
  }

  handleMessage (packet) {
    if (BigInt(packet.params.recipient_id).toString() !== this.networkId.toString()) {
      return
    }

    const data = packet.params.data

    if (data === 'Ping' || data === '') {
      return
    }

    const signal = SignalStructure.fromString(data)

    signal.networkId = packet.params.sender_id

    this.handleSignal(signal)
  }

  handleSignal (signal) {
    if (!this.isExpectedSignal(signal)) {
      return
    }

    switch (signal.type) {
      case SignalType.ConnectResponse:
        this.handleAnswer(signal)
        break
      case SignalType.CandidateAdd:
        this.handleCandidate(signal)
        break
      case SignalType.ConnectError:
        this.connection?.close(`connecterror:${signal.data}`)
        break
    }
  }

  sendDiscoveryRequest () {
    const packetData = createPacketData('discovery_request', PACKET_TYPE.DISCOVERY_REQUEST, this.networkId)

    const packetToSend = prepareSecurePacket(this.serializer, packetData)

    this.socket.send(packetToSend, PORT, this.broadcastAddress)
  }

  sendDiscoveryMessage (signal) {
    const rinfo = this.addresses.get(BigInt(signal.networkId))

    const packetData = createPacketData('discovery_message', PACKET_TYPE.DISCOVERY_MESSAGE, this.networkId,
      {
        recipient_id: BigInt(signal.networkId),
        data: signal.toString()
      }
    )

    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, rinfo.port, rinfo.address)
  }

  connect () {
    this.running = true
    this._hasEmittedConnected = false

    const hasAddress = this.addresses.has(this.serverNetworkId)

    if (this._externalSignaling || hasAddress) {
      this.armNegotiationTimeout(ErrorCode.NegotiationTimeoutWaitingForResponse, this.responseTimeoutMs)
      this.startOffer()
    } else {
      this._pendingConnect = true
    }
  }

  send (buffer) {
    if (!this.connection) {
      throw new Error('Connection is not open')
    }

    this.connection.send(buffer)
  }

  ping () {
    this.running = true

    this.sendDiscoveryRequest()
  }

  close (reason) {
    debug('Closing client', reason)
    if (!this.running) return
    clearInterval(this.pingInterval)
    this.clearNegotiationTimeouts()
    this.connection?.close(reason)
    setTimeout(() => this.socket.close(), SOCKET_CLOSE_TIMEOUT_MS)
    this.connection = null
    this.rtcConnection = null
    this.running = false
    this.removeAllListeners()
  }
}

module.exports = { Client }
