const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')

const { Connection } = require('./connection')
const { SignalType, SignalStructure } = require('./signalling')

const { getRandomUint64, createPacketData, prepareSecurePacket, processSecurePacket } = require('./util')
const { PeerConnection } = require('node-datachannel')
const { PACKET_TYPE, createSerializer, createDeserializer } = require('./serializer')

const debug = require('debug')('minecraft-protocol')

const PORT = 7551
const BROADCAST_ADDRESS = '255.255.255.255'

class Client extends EventEmitter {
  constructor (networkId, broadcastAddress = BROADCAST_ADDRESS) {
    super()

    this.serverNetworkId = networkId

    this.broadcastAddress = broadcastAddress

    this.networkId = getRandomUint64()

    this.connectionId = getRandomUint64()

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

    this.credentials = []

    this.signalHandler = this.sendDiscoveryMessage

    this.sendDiscoveryRequest()

    this.pingInterval = setInterval(() => {
      this.sendDiscoveryRequest()
    }, 2000)
  }

  async handleCandidate (signal) {
    this.rtcConnection.addRemoteCandidate(signal.data, '0')
  }

  async handleAnswer (signal) {
    this.rtcConnection.setRemoteDescription(signal.data, 'answer')
  }

  async createOffer () {
    this.rtcConnection = new PeerConnection('client', { iceServers: this.credentials })

    this.connection = new Connection(this, this.connectionId, this.rtcConnection)

    this.rtcConnection.onLocalCandidate(candidate => {
      this.signalHandler(
        new SignalStructure(SignalType.CandidateAdd, this.connectionId, candidate, this.serverNetworkId)
      )
    })

    this.rtcConnection.onLocalDescription(desc => {
      const pattern = /o=rtc \d+ 0 IN IP4 127\.0\.0\.1/

      const newOLine = `o=- ${this.networkId} 2 IN IP4 127.0.0.1`

      desc = desc.replace(pattern, newOLine)

      debug('client ICE local description changed', desc)
      this.signalHandler(
        new SignalStructure(SignalType.ConnectRequest, this.connectionId, desc, this.serverNetworkId)
      )
    })

    this.rtcConnection.onStateChange(state => {
      debug('Client state changed', state)
      if (state === 'connected') this.emit('connected', this.connection)
      if (state === 'closed' || state === 'disconnected' || state === 'failed') this.emit('disconnect', this.connectionId, 'disconnected')
    })

    setTimeout(() => {
      this.connection.setChannels(
        this.rtcConnection.createDataChannel('ReliableDataChannel'),
        this.rtcConnection.createDataChannel('UnreliableDataChannel')
      )
    }, 500)
  }

  processPacket (buffer, rinfo) {
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
  }

  handleResponse (packet, rinfo) {
    const senderId = BigInt(packet.params.sender_id)
    this.addresses.set(senderId, rinfo)
    this.responses.set(senderId, packet.params)
    this.emit('pong', packet.params)
  }

  handleMessage (packet) {
    const data = packet.params.data

    if (data === 'Ping') {
      return
    }

    const signal = SignalStructure.fromString(data)

    signal.networkId = packet.params.sender_id

    this.handleSignal(signal)
  }

  handleSignal (signal) {
    switch (signal.type) {
      case SignalType.ConnectResponse:
        this.handleAnswer(signal)
        break
      case SignalType.CandidateAdd:
        this.handleCandidate(signal)
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

    if (!rinfo) {
      return
    }

    const packetData = createPacketData('discovery_message', PACKET_TYPE.DISCOVERY_MESSAGE, this.networkId,
      {
        recipient_id: BigInt(signal.networkId),
        data: signal.toString()
      }
    )

    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, rinfo.port, rinfo.address)
  }

  async connect () {
    this.running = true

    await this.createOffer()
  }

  send (buffer) {
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
    this.connection?.close()
    setTimeout(() => this.socket.close(), 100)
    this.connection = null
    this.running = false
    this.removeAllListeners()
  }
}

module.exports = { Client }
