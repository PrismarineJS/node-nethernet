/* eslint-env mocha */
// Regression for the discovery_message length-prefix compatibility fix. A Minecraft client that sends a non-trickle
// answer with all ICE candidates inline undercounts the length prefixes it writes, so protodef truncates the parsed
// signal even though the whole payload is present in the checksum-validated datagram. These fixtures are synthetic
// (no real identity assertions or ICE credentials): a valid packet is built with our own serializer, then its length
// prefixes are deliberately shortened to reproduce the undercount without any fragmentation machinery.
const assert = require('assert')
const { createSerializer, createDeserializer } = require('../src/transforms/serializer')
const { encrypt, calculateChecksum } = require('../src/crypto')
const { createPacketData, processSecurePacket } = require('../src/signalling/lan')

// Byte layout of a discovery_message plaintext (little-endian): outer encapsulated lu16 (2) + type lu16 (2) +
// sender_id lu64 (8) + reserved (8) + recipient_id lu64 (8) + data pstring lu32 (4) + data.
const OUTER_LEN_OFFSET = 0
const DATA_LEN_OFFSET = 28
const DATA_OFFSET = 32

// A large answer with many inline candidates and a full SDP trailer, comfortably over the ~244-byte shortfall.
function buildLargeSignal () {
  const cands = []
  for (let i = 0; i < 10; i++) cands.push(`a=candidate:${1000000000 + i} 1 udp ${2122000000 + i} 10.0.0.${i} ${50000 + i} typ host generation 0 network-id ${i}`)
  const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS', 'm=application 50000 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 10.0.0.1', ...cands, 'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdef0123456789abcdef', 'a=ice-options:trickle', 'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF', 'a=setup:active', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144'].join('\r\n')
  return `CONNECTRESPONSE 12066214442905225968 ${sdp}`
}

function plaintextFor (signal) {
  const serializer = createSerializer()
  return serializer.createPacketBuffer(createPacketData('discovery_message', 2, 111n, { recipient_id: 222n, data: signal }))
}

function secureFrom (plaintext) {
  return Buffer.concat([calculateChecksum(plaintext), encrypt(plaintext)])
}

describe('discovery_message length-prefix truncation', () => {
  const deserializer = createDeserializer()
  const signal = buildLargeSignal()
  const plaintext = plaintextFor(signal)

  it('lays the data field out at the documented offsets', () => {
    // Confirms the byte accounting the fix relies on. The outer lu16 wraps the 30-byte inner header plus the data.
    const dataBytes = Buffer.byteLength(signal, 'utf8')
    assert.strictEqual(plaintext.readUInt32LE(DATA_LEN_OFFSET), dataBytes, 'data lu32 counts the signal bytes')
    assert.strictEqual(plaintext.readUInt16LE(OUTER_LEN_OFFSET), 30 + dataBytes, 'outer lu16 = 30-byte inner header + data')
    assert.strictEqual(plaintext.toString('utf8', DATA_OFFSET), signal, 'data begins at offset 32')
    assert.ok(dataBytes > 1200, 'fixture is large enough to exercise the undercount')
  })

  it('returns a correctly framed packet unchanged', () => {
    const out = processSecurePacket(secureFrom(plaintext), deserializer)
    assert.strictEqual(out.name, 'discovery_message')
    assert.strictEqual(out.params.data, signal)
  })

  it('recovers the full signal when only the inner data lu32 is undercounted', () => {
    const short = Buffer.from(plaintext)
    short.writeUInt32LE(1140, DATA_LEN_OFFSET) // client-style undercount, cutting the SDP trailer
    const out = processSecurePacket(secureFrom(short), deserializer)
    assert.strictEqual(Buffer.byteLength(out.params.data, 'utf8'), Buffer.byteLength(signal, 'utf8'))
    assert.strictEqual(out.params.data, signal)
  })

  it('recovers the full signal when both the outer lu16 and inner lu32 are undercounted', () => {
    const short = Buffer.from(plaintext)
    short.writeUInt16LE(1172, OUTER_LEN_OFFSET)
    short.writeUInt32LE(1140, DATA_LEN_OFFSET)
    const out = processSecurePacket(secureFrom(short), deserializer)
    assert.strictEqual(out.params.data, signal)
  })

  it('does not extend a small, correctly counted discovery_message', () => {
    const small = 'CANDIDATEADD 12066214442905225968 candidate:1 1 udp 2122000000 10.0.0.1 50000 typ host'
    const out = processSecurePacket(secureFrom(plaintextFor(small)), deserializer)
    assert.strictEqual(out.params.data, small)
  })

  it('ignores an undercounted outer length when the inner length is correct', () => {
    const short = Buffer.from(plaintext)
    short.writeUInt16LE(1172, OUTER_LEN_OFFSET)
    assert.strictEqual(processSecurePacket(secureFrom(short), deserializer).params.data, signal)
  })

  it('uses byte boundaries when the prefix splits the final UTF-8 character', () => {
    const text = 'CONNECTRESPONSE 42 v=0\r\ns=é'
    const short = plaintextFor(text)
    short.writeUInt32LE(Buffer.byteLength(text) - 1, DATA_LEN_OFFSET)
    assert.strictEqual(processSecurePacket(secureFrom(short), deserializer).params.data, text)
  })

  it('does not extend other signalling messages', () => {
    const text = signal.replace('CONNECTRESPONSE', 'CONNECTREQUEST')
    const short = plaintextFor(text)
    short.writeUInt32LE(100, DATA_LEN_OFFSET)
    assert.strictEqual(processSecurePacket(secureFrom(short), deserializer).params.data, text.slice(0, 100))
  })

  it('does not extend discovery advertisements', () => {
    const advertisement = createSerializer().createPacketBuffer(createPacketData('discovery_response', 1, 111n, { data: signal }))
    advertisement.writeUInt32LE(100, 20)
    assert.strictEqual(processSecurePacket(secureFrom(advertisement), deserializer).params.data, signal.slice(0, 100))
  })

  it('does not absorb a second encapsulated discovery frame', () => {
    const batched = Buffer.concat([plaintext, plaintextFor('Ping')])
    assert.strictEqual(processSecurePacket(secureFrom(batched), deserializer).params.data, signal)
  })

  it('does not recover a short answer across an appended binary frame', () => {
    const short = Buffer.from(plaintext)
    short.writeUInt32LE(100, DATA_LEN_OFFSET)
    const batched = Buffer.concat([short, plaintextFor('Ping')])
    assert.strictEqual(processSecurePacket(secureFrom(batched), deserializer).params.data, signal.slice(0, 100))
  })

  it('still rejects an invalid checksum', () => {
    const bad = secureFrom(plaintext)
    bad[0] ^= 0xff
    assert.throws(() => processSecurePacket(bad, deserializer), /Checksum mismatch/)
  })
})
