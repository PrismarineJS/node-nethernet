const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')

const { Connection } = require('./connection')
const { SignalType, SignalStructure } = require('./signalling')

const { getBroadcastAddress } = require('./net')
const { PACKET_TYPE } = require('./discovery/packets/Packet')
const { RequestPacket } = require('./discovery/packets/RequestPacket')
const { MessagePacket } = require('./discovery/packets/MessagePacket')
const { ResponsePacket } = require('./discovery/packets/ResponsePacket')
const { decrypt, encrypt, calculateChecksum } = require('./discovery/crypto')

const { getRandomUint64 } = require('./util')
const { PeerConnection } = require('node-datachannel')

const debug = require('debug')('minecraft-protocol')

const PORT = 7551
const BROADCAST_ADDRESS = getBroadcastAddress()

class Client extends EventEmitter {
  constructor (networkId) {
    super()

    this.serverNetworkId = networkId

    this.networkId = getRandomUint64()

    this.connectionId = getRandomUint64()

    this.socket = dgram.createSocket('udp4')

    this.socket.on('message', (buffer, rinfo) => {
      this.processPacket(buffer, rinfo)
    })

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
    if (buffer.length < 32) {
      throw new Error('Packet is too short')
    }

    const decryptedData = decrypt(buffer.slice(32))
    const checksum = calculateChecksum(decryptedData)

    if (Buffer.compare(buffer.slice(0, 32), checksum) !== 0) {
      throw new Error('Checksum mismatch')
    }

    const packetType = decryptedData.readUInt16LE(2)

    debug('Received packet', packetType)

    switch (packetType) {
      case PACKET_TYPE.DISCOVERY_REQUEST:
        break
      case PACKET_TYPE.DISCOVERY_RESPONSE:
        this.handleResponse(new ResponsePacket(decryptedData).decode(), rinfo)
        break
      case PACKET_TYPE.DISCOVERY_MESSAGE:
        this.handleMessage(new MessagePacket(decryptedData).decode())
        break
      default:
        throw new Error('Unknown packet type')
    }
  }

  handleResponse (packet, rinfo) {
    this.addresses.set(packet.senderId, rinfo)
    this.responses.set(packet.senderId, packet.data)
    this.emit('pong', packet)
  }

  handleMessage (packet) {
    if (packet.data === 'Ping') {
      return
    }

    const signal = SignalStructure.fromString(packet.data)

    signal.networkId = packet.senderId

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
    const requestPacket = new RequestPacket()

    requestPacket.senderId = this.networkId

    requestPacket.encode()

    const buf = requestPacket.getBuffer()

    const packetToSend = Buffer.concat([calculateChecksum(buf), encrypt(buf)])

    this.socket.send(packetToSend, PORT, BROADCAST_ADDRESS)
  }

  sendDiscoveryMessage (signal) {
    const rinfo = this.addresses.get(signal.networkId)

    if (!rinfo) {
      return
    }

    const messagePacket = new MessagePacket()

    messagePacket.senderId = this.networkId
    messagePacket.recipientId = BigInt(signal.networkId)
    messagePacket.data = signal.toString()
    messagePacket.encode()

    const buf = messagePacket.getBuffer()

    const packetToSend = Buffer.concat([calculateChecksum(buf), encrypt(buf)])

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
