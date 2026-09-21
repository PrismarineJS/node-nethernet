const { RTCPeerConnection } = require('werift')

class WeriftPeerConnection extends RTCPeerConnection {
  createDataChannel (label, options) {
    const channel = super.createDataChannel(label, options)
    // Werift 0.24.4 overwrites DCEP's unordered bit when maxRetransmits is set.
    // Our channels are created before negotiation, so their OPEN is still queued.
    if (!channel.ordered) {
      const [, , open] = this.sctpTransport.dataChannelQueue.find(([queued]) => queued === channel)
      open[1] |= 0x80
    }
    return channel
  }

  async setRemoteDescription (description) {
    await super.setRemoteDescription(description)
    // Werift accepts empty SDP; NetherNet requires a data-channel transport.
    if (!this.sctp) throw new Error('NetherNet requires an SCTP data-channel description')
  }

  setLocalDescription (description) {
    // Werift supplies Google STUN even for iceServers: []. Respect the caller's
    // configuration, including LAN-only connections and TURN-only credentials.
    const hasStun = this.getConfiguration().iceServers.some(server =>
      [server.urls].flat().some(url => /^stuns?:/.test(url)))
    if (!hasStun) {
      for (const ice of this.iceTransports) ice.connection.stunServer = undefined
    }
    return super.setLocalDescription(description)
  }

  close () {
    // Werift 0.24.4 closes DTLS before SCTP, preventing the SCTP abort from
    // reaching the remote peer. Stop SCTP while its transport is still open.
    this.closePromise ??= this.closeTransport()
    return this.closePromise
  }

  async closeTransport () {
    try {
      if (this.sctp?.sctp.state === 'connected') {
        await this.sctpTransport.stop()
        // Werift queues UDP sends without awaiting their callbacks.
        await new Promise(resolve => setImmediate(resolve))
      }
    } finally {
      await super.close()
    }
  }
}

module.exports = { RTCPeerConnection: WeriftPeerConnection }
