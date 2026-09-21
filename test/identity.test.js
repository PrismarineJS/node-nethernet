/* eslint-env mocha */
const assert = require('assert')
const crypto = require('crypto')
const { extractFingerprints, fingerprintsPayload, detachedES384, buildIdentityAttribute, attachIdentity } = require('../src/identity')

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=fingerprint:sha-256 AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D',
  'a=setup:actpass',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=mid:0'
].join('\r\n')

describe('identity (a=identity assertion)', () => {
  const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' })

  it('parses DTLS fingerprints from an SDP offer', () => {
    const fps = extractFingerprints(SDP)
    assert.strictEqual(fps.length, 1)
    assert.strictEqual(fps[0].algorithm, 'sha-256')
    assert.ok(fps[0].digest.startsWith('AB:CD:EF'))
  })

  it('builds the canonical fingerprint payload with no whitespace', () => {
    const payload = fingerprintsPayload(extractFingerprints(SDP))
    assert.strictEqual(payload, '{"fingerprint":[{"algorithm":"sha-256","digest":"AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D"}]}')
  })

  it('produces a detached ES384 JWS (header..signature) that verifies with the public key', () => {
    const payload = Buffer.from(fingerprintsPayload(extractFingerprints(SDP)))
    const jws = detachedES384(payload, keyPair.privateKey)
    const parts = jws.split('.')
    assert.strictEqual(parts.length, 3)
    assert.strictEqual(parts[1], '', 'payload must be detached (empty middle segment)')
    const b64url = (b) => Buffer.from(b).toString('base64url')
    const signingInput = parts[0] + '.' + b64url(payload)
    const sig = Buffer.from(parts[2], 'base64url')
    assert.strictEqual(sig.length, 96, 'ES384/P-384 signature is 96 bytes (r||s)')
    const ok = crypto.verify('SHA384', Buffer.from(signingInput), { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' }, sig)
    assert.strictEqual(ok, true)
  })

  it('builds a base64 a=identity value with the documented envelope', () => {
    const value = buildIdentityAttribute(SDP, { privateKey: keyPair.privateKey, token: 'aaa.bbb.ccc', domain: '' })
    const data = JSON.parse(Buffer.from(value, 'base64').toString())
    assert.strictEqual(typeof data.assertion, 'string', 'assertion is a JSON string (double-encoded)')
    assert.deepStrictEqual(data.idp, { domain: '', protocol: 'default' })
    const assertion = JSON.parse(data.assertion)
    assert.deepStrictEqual(Object.keys(assertion).sort(), ['fingerprints', 'token'])
    assert.strictEqual(assertion.token, 'aaa.bbb.ccc')
    assert.strictEqual(assertion.fingerprints.split('.').length, 3)
  })

  it('attaches a=identity to the offer SDP before the first m= line', () => {
    const munged = attachIdentity(SDP, { privateKey: keyPair.privateKey, token: 'a.b.c', domain: '' })
    assert.ok(munged.includes('a=identity:'))
    assert.ok(munged.indexOf('a=identity:') < munged.indexOf('m='))
    // idempotent: re-attaching replaces rather than duplicates
    const again = attachIdentity(munged, { privateKey: keyPair.privateKey, token: 'a.b.c', domain: '' })
    assert.strictEqual((again.match(/a=identity:/g) || []).length, 1)
  })

  it('rejects a P-256 key instead of mislabelling its signature ES384', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    assert.throws(() => buildIdentityAttribute(SDP, { privateKey, token: 'a.b.c' }), /P-384 private key/)
  })

  it('throws when the offer has no DTLS fingerprint', () => {
    assert.throws(() => buildIdentityAttribute('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel', { privateKey: keyPair.privateKey, token: 'a.b.c' }), /no a=fingerprint/)
  })
})
