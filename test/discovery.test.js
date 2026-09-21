/* eslint-env mocha */
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('../src/serializer')
const { encrypt, calculateChecksum } = require('../src/crypto')
const { createPacketData, processSecurePacket } = require('../src/util')

const serializer = createSerializer()
const deserializer = createDeserializer()

// Synthetic SDP: no live credentials or addresses. The declared length below
// cuts through ice-pwd, leaving the fingerprint and SCTP attributes in the tail.
const answer = 'CONNECTRESPONSE 42 ' + [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  ...Array.from({ length: 16 }, (_, i) => `a=candidate:${i} 1 udp 2122260223 192.0.2.1 ${40000 + i} typ host`),
  'a=ice-ufrag:test',
  'a=ice-pwd:synthetic-password',
  'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'),
  'a=setup:active',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  ''
].join('\r\n')

function message (data = answer) {
  return serializer.createPacketBuffer(createPacketData('discovery_message', 2, 1n, { recipient_id: 2n, data }))
}

function secure (plain) {
  return Buffer.concat([calculateChecksum(plain), encrypt(plain)])
}

function decode (plain) {
  return processSecurePacket(secure(plain), deserializer)
}

describe('LAN discovery answer lengths', () => {
  for (const prefix of ['outer', 'inner', 'both']) {
    it(`recovers the complete answer with an undercounted ${prefix} length`, () => {
      const plain = message()
      const length = Buffer.byteLength(answer.slice(0, answer.indexOf('a=ice-pwd:') + 'a=ice-p'.length))
      // Offsets are from the start of decrypted plaintext, including lu16 length.
      assert.equal(plain.readUInt32LE(28), Buffer.byteLength(answer))
      assert.equal(plain.readUInt16LE(0), plain.length - 2)
      assert.equal(plain.subarray(32).toString(), answer)
      if (prefix !== 'inner') plain.writeUInt16LE(30 + length, 0)
      if (prefix !== 'outer') plain.writeUInt32LE(length, 28)
      if (prefix !== 'outer') assert.equal(deserializer.parsePacketBuffer(plain).data.params.data.endsWith('a=ice-p'), true)
      const decoded = decode(plain)
      assert.equal(decoded.params.data, answer)
      assert.equal(BigInt(decoded.params.sender_id), 1n)
      assert.equal(BigInt(decoded.params.recipient_id), 2n)
    })
  }

  it('preserves a correctly framed large answer', () => {
    assert.equal(decode(message()).params.data, answer)
  })

  it('uses byte boundaries even when a short prefix splits a UTF-8 character', () => {
    const text = answer.replace('s=-', 's=世界')
    const plain = message(text)
    plain.writeUInt32LE(Buffer.byteLength(text.slice(0, text.indexOf('世界'))) + 1, 28)
    assert.equal(decode(plain).params.data, text)
  })

  it('does not recover other signalling messages', () => {
    const text = answer.replace('CONNECTRESPONSE', 'CONNECTREQUEST')
    const plain = message(text)
    plain.writeUInt32LE(100, 28)
    assert.equal(decode(plain).params.data, text.slice(0, 100))
  })

  it('does not extend discovery advertisements', () => {
    const plain = serializer.createPacketBuffer(createPacketData('discovery_response', 1, 1n, { data: answer }))
    plain.writeUInt32LE(100, 20)
    assert.equal(decode(plain).params.data, answer.slice(0, 100))
  })

  it('does not absorb another encapsulated discovery frame', () => {
    const plain = Buffer.concat([message(), message('CANDIDATEADD 42 candidate:test')])
    assert.equal(decode(plain).params.data, answer)
  })

  it('does not extend a short answer across a trailing binary frame', () => {
    const plain = message()
    plain.writeUInt32LE(100, 28)
    assert.equal(decode(Buffer.concat([plain, message('Ping')])).params.data, answer.slice(0, 100))
  })

  it('checks the checksum before recovering an answer', () => {
    const plain = message()
    plain.writeUInt32LE(100, 28)
    const wire = secure(plain)
    wire[0] ^= 1
    assert.throws(() => processSecurePacket(wire, deserializer), /Checksum mismatch/)
  })
})
