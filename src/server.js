const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { PeerConnection } = require('node-datachannel')

const { Connection } = require('./connection')
const { SignalStructure, SignalType } = require('./signalling')

const { PACKET_TYPE, createSerializer, createDeserializer } = require('./serializer')

const { getRandomUint64, createPacketData, prepareSecurePacket, processSecurePacket } = require('./util')

const debug = require('debug')('nethernet')

class Server extends EventEmitter {
  constructor (options = {}) {
    super()

    this.options = options

    this.networkId = options.networkId ?? getRandomUint64()

    this.connections = new Map()

    this.serializer = createSerializer()
    this.deserializer = createDeserializer()
  }

  async handleCandidate (signal) {
    const conn = this.connections.get(signal.connectionId)

    if (conn) {
      conn.rtcConnection.addRemoteCandidate(signal.data, '0')
    } else {
      debug('Connection not found', signal.connectionId)
    }
  }

  async handleOffer (signal, respond, credentials = []) {
    const rtcConnection = new PeerConnection('server', { iceServers: credentials })

    const connection = new Connection(this, signal.connectionId, rtcConnection)

    this.connections.set(signal.connectionId, connection)

    debug('Received offer', signal.connectionId)

    rtcConnection.onLocalDescription(description => {
      debug('Local description', description)
      respond(
        new SignalStructure(SignalType.ConnectResponse, signal.connectionId, description, signal.networkId)
      )
    })

    rtcConnection.onLocalCandidate(candidate => {
      respond(
        new SignalStructure(SignalType.CandidateAdd, signal.connectionId, candidate, signal.networkId)
      )
    })

    rtcConnection.onDataChannel(channel => {
      debug('Received data channel', channel.getLabel())
      if (channel.getLabel() === 'ReliableDataChannel') connection.setChannels(channel)
      if (channel.getLabel() === 'UnreliableDataChannel') connection.setChannels(null, channel)
    })

    rtcConnection.onStateChange(state => {
      debug('Server RTC state changed', state)
      if (state === 'connected') this.emit('openConnection', connection)
      if (state === 'closed' || state === 'disconnected' || state === 'failed') this.emit('closeConnection', signal.connectionId, 'disconnected')
    })

    rtcConnection.setRemoteDescription(signal.data, 'offer')
  }

  processPacket (buffer, rinfo) {
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
    const data = packet.params.data
    if (data === 'Ping') {
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
        this.handleCandidate(signal)
        break
    }
  }

  async listen () {
    this.socket = dgram.createSocket('udp4')

    this.socket.on('message', (buffer, rinfo) => {
      this.processPacket(buffer, rinfo)
    })

    await new Promise((resolve, reject) => {
      const failFn = e => reject(e)
      this.socket.once('error', failFn)
      this.socket.bind(7551, () => {
        this.socket.removeListener('error', failFn)
        resolve(true)
      })
    })
  }

  close (reason) {
    debug('Closing server', reason)
    for (const conn of this.connections.values()) {
      conn.close()
    }

    this.socket.close(() => {
      this.emit('close', reason)
      this.removeAllListeners()
    })
  }
}

module.exports = { Server }
