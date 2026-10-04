'use strict'
// Builds the NetherNet SDP `a=identity` attribute the realm/server host requires to admit a client (missing it ->
// CONNECTERROR 37 ErrorCodeIdentityNotAllowed). Format per Mojang's NetherNet HTTP Signaling docs + df-mc/go-nethernet
// identity.go: base64(JSON { assertion: "<stringified {fingerprints, token}>", idp: { domain, protocol:'default' } }),
// where `fingerprints` is a DETACHED ES384 JWS over the canonical-JSON of the offer's DTLS fingerprints, signed with the
// private key whose public key is the multiplayer token's `cpk` claim.
const crypto = require('crypto')

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

module.exports = { extractFingerprints, fingerprintsPayload, detachedES384, buildIdentityAttribute, attachIdentity }
