'use strict'
// Builds the NetherNet SDP `a=identity` attribute the realm/server host requires to admit a client (missing it ->
// CONNECTERROR 37 ErrorCodeIdentityNotAllowed). Format per Mojang's NetherNet HTTP Signaling docs + df-mc/go-nethernet
// identity.go: base64(JSON { assertion: "<stringified {fingerprints, token}>", idp: { domain, protocol:'default' } }),
// where `fingerprints` is a DETACHED ES384 JWS over the canonical-JSON of the offer's DTLS fingerprints, signed with the
// private key whose public key is the multiplayer token's `cpk` claim.
const crypto = require('crypto')
const JWT = require('jsonwebtoken')

const b64url = (buf) => Buffer.from(buf).toString('base64url')

// Parse `a=fingerprint:<alg> <digest>` lines from an SDP into [{algorithm, digest}] (order preserved).
function extractFingerprints (sdp) {
  const out = []
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = line.match(/^a=fingerprint:(\S+)\s+(\S+)/)
    if (m) out.push({ algorithm: m[1], digest: m[2] })
  }
  return out
}

// Canonical JSON payload the JWS signs (byte-identical to go-nethernet's generateFingerprints: no spaces).
function fingerprintsPayload (fps) {
  return JSON.stringify({ fingerprint: fps })
}

// Detached compact ES384 JWS over `payload` (header..signature). Signature is raw r||s (ieee-p1363 == JOSE).
function detachedES384 (payloadBytes, privateKey) {
  const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey)
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp384r1') {
    throw new TypeError('Nethernet identity requires an EC P-384 private key')
  }
  const header = b64url(JSON.stringify({ alg: 'ES384' }))
  const signingInput = header + '.' + b64url(payloadBytes)
  const sig = crypto.sign('SHA384', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return header + '..' + b64url(sig)
}

// Build the `a=identity` attribute VALUE (base64) for an offer SDP.
// identity: { privateKey: KeyObject|pem, token: <multiplayer token JWT>, domain?: string }
function buildIdentityAttribute (sdp, identity) {
  const fps = extractFingerprints(sdp)
  if (!fps.length) throw new Error('nethernet identity: no a=fingerprint in offer SDP')
  const fingerprints = detachedES384(Buffer.from(fingerprintsPayload(fps)), identity.privateKey)
  const assertion = JSON.stringify({ fingerprints, token: identity.token })
  const identityData = { assertion, idp: { domain: identity.domain || '', protocol: 'default' } }
  return Buffer.from(JSON.stringify(identityData)).toString('base64')
}

// Insert (or replace) the session-level `a=identity:<value>` line into an offer SDP.
function attachIdentity (sdp, identity) {
  const value = buildIdentityAttribute(sdp, identity)
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(/\r?\n/).filter(l => !l.startsWith('a=identity:'))
  // Place it in the session section: right before the first media (m=) line.
  const mi = lines.findIndex(l => l.startsWith('m='))
  const idLine = 'a=identity:' + value
  if (mi === -1) lines.push(idLine)
  else lines.splice(mi, 0, idLine)
  return lines.join(eol)
}

// Verify possession of the operator key and bind it to WebRTC's DTLS fingerprints.
// Trust in that key (HTTPS or an application pin) is checked separately.
function verifyServerIdentity (sdp) {
  const lines = sdp.split(/\r?\n/)
  const identities = lines.filter(line => line.startsWith('a=identity:'))
  if (identities.length !== 1) throw new Error('Expected one Nethernet server identity assertion')
  const envelope = JSON.parse(Buffer.from(identities[0].slice('a=identity:'.length), 'base64').toString())
  if (envelope.idp?.protocol !== 'default') throw new Error('Unsupported Nethernet identity protocol')
  const assertion = JSON.parse(envelope.assertion)
  const claims = JWT.decode(assertion.token)
  const key = crypto.createPublicKey({ key: claims?.cpk, format: 'jwk' })
  JWT.verify(assertion.token, key)

  const fingerprints = extractFingerprints(sdp)
  if (!fingerprints.length) throw new Error('Missing Nethernet DTLS fingerprint')
  const parts = assertion.fingerprints.split('.')
  if (parts.length !== 3 || parts[1] !== '') throw new Error('Invalid detached fingerprint signature')
  parts[1] = Buffer.from(JSON.stringify({ fingerprint: fingerprints })).toString('base64url')
  JWT.verify(parts.join('.'), key)

  return {
    fingerprint: 'sha256:' + crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'),
    sdp: lines.filter(line => !line.startsWith('a=identity:')).join('\r\n')
  }
}

module.exports = { verifyServerIdentity, extractFingerprints, fingerprintsPayload, detachedES384, buildIdentityAttribute, attachIdentity }
