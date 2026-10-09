/* eslint-env mocha */
const assert = require('node:assert')
const { encrypt, decrypt, calculateChecksum } = require('../src/crypto')
const { prepareSecurePacket, processSecurePacket } = require('../src/util')

describe('crypto wire format (NetherNet AES-256-ECB compatibility)', function () {
  it('round-trips encrypt/decrypt', function () {
    const data = Buffer.from('0123456789abcdef')
    assert.deepStrictEqual(decrypt(encrypt(data)), data)
  })

  it('pads with PKCS7 only, with no IV prepended', function () {
    // ECB ciphertext length is just the PKCS7-padded plaintext length. A
    // prepended 16-byte IV (e.g. from switching to CBC) would silently add
    // 16 extra bytes and break interop with real NetherNet peers.
    const data = Buffer.alloc(32, 1)
    const pkcs7PaddedLength = (Math.floor(data.length / 16) + 1) * 16
    assert.strictEqual(encrypt(data).length, pkcs7PaddedLength)
  })

  it('is deterministic for the same input (no random IV)', function () {
    // ECB with a fixed key has no randomness. If this ever starts failing,
    // a mode change (e.g. CBC with a random IV) has likely been reintroduced.
    const data = Buffer.alloc(16, 2)
    assert.deepStrictEqual(encrypt(data), encrypt(data))
  })

  it('round-trips prepareSecurePacket/processSecurePacket with the expected wire layout', function () {
    const packetData = { name: 'discovery_request', params: { sender_id: 1n, reserved: Buffer.alloc(8) } }
    const serializer = {
      createPacketBuffer: () => Buffer.from('fake-packet-bytes')
    }
    const packed = prepareSecurePacket(serializer, packetData)

    // Wire layout: 32-byte HMAC-SHA256 checksum || PKCS7-padded ECB ciphertext (no IV).
    const plaintextLength = 'fake-packet-bytes'.length
    const pkcs7PaddedLength = (Math.floor(plaintextLength / 16) + 1) * 16
    assert.strictEqual(packed.length, 32 + pkcs7PaddedLength)
    assert.deepStrictEqual(packed.subarray(0, 32), calculateChecksum(Buffer.from('fake-packet-bytes')))

    const deserializer = {
      parsePacketBuffer: (buf) => ({ data: { name: packetData.name, params: { ...packetData.params, decoded: buf.toString() } } })
    }
    const result = processSecurePacket(packed, deserializer)
    assert.strictEqual(result.name, 'discovery_request')
    assert.strictEqual(result.params.decoded, 'fake-packet-bytes')
  })
})
