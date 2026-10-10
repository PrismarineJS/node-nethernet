const { encrypt, calculateChecksum, decrypt } = require('../crypto')

// Outer length + type + sender + reserved + recipient + string length.
const DISCOVERY_MESSAGE_DATA_OFFSET = 2 + 2 + 8 + 8 + 8 + 4

const createPacketData = (packetName, packetId, senderId, additionalParams = {}) => {
  return {
    name: packetName,
    params: {
      sender_id: senderId,
      reserved: Buffer.alloc(8),
      ...additionalParams
    }
  }
}

const prepareSecurePacket = (serializer, packetData) => {
  const buf = serializer.createPacketBuffer(packetData)

  const checksum = calculateChecksum(buf)
  const encryptedData = encrypt(buf)

  return Buffer.concat([checksum, encryptedData])
}

const processSecurePacket = (buffer, deserializer) => {
  if (buffer.length < 32) {
    throw new Error('Packet is too short')
  }

  const decryptedData = decrypt(buffer.slice(32))

  const checksum = calculateChecksum(decryptedData)
  if (Buffer.compare(buffer.slice(0, 32), checksum) !== 0) {
    throw new Error('Checksum mismatch')
  }

  const packet = deserializer.parsePacketBuffer(decryptedData)
  const { name, params } = packet.data

  // Retail LAN hosts can undercount the length of an inline-candidate SDP answer
  // (#23). Recover its tail from this checksum-validated datagram only.
  if (name === 'discovery_message' && params.data.startsWith('CONNECTRESPONSE ') && packet.metadata.size < decryptedData.length) {
    const data = decryptedData.subarray(DISCOVERY_MESSAGE_DATA_OFFSET)
    // SDP has no NUL bytes. An appended discovery frame does (its uint16 type),
    // so do not absorb binary framing into the answer. This is not batch parsing.
    if (!data.includes(0)) params.data = data.toString('utf8')
  }

  return { name, params }
}

module.exports = { createPacketData, prepareSecurePacket, processSecurePacket }
