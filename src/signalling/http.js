const { once } = require('node:events')
const { attachIdentity, verifyServerIdentity } = require('./sdpIdentity')

function signallingUrl (origin) {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('HTTP signalling URL must be an HTTP(S) origin')
  }
  return url
}

async function pingHttp (origin, { timeout = 1000, signal } = {}) {
  const deadline = AbortSignal.timeout(timeout)
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const response = await fetch(new URL('/v1/join', signallingUrl(origin)), { signal, redirect: 'error' })
  if (!response.ok) throw new Error(`Nethernet HTTP discovery returned ${response.status}`)
  const raw = await response.text()
  // A successful response can omit metadata (for example with BDS LAN visibility off).
  return { ...(raw ? JSON.parse(raw) : {}), raw }
}

async function exchangeOffer (client, signal) {
  const rtc = client.rtcConnection
  signal.throwIfAborted()
  while (rtc.iceGatheringState !== 'complete') await once(rtc, 'icegatheringstatechange', { signal })
  if (!client.identity) throw new Error('Nethernet HTTP offer requires a player identity')
  // Sign the complete local description after ICE gathering, with no trickle candidates.
  const body = attachIdentity(rtc.localDescription.sdp, client.identity)
  const { url, serverKey, onServerKey } = client.http
  const response = await fetch(new URL(`/v1/join/${client.networkId}`, url), {
    method: 'POST', headers: { 'content-type': 'application/sdp' }, body, signal, redirect: 'error'
  })
  if (!response.ok) throw new Error(`Nethernet HTTP signalling returned ${response.status}`)
  const answer = await response.text()
  if (!answer.startsWith('v=')) throw new Error(`Nethernet HTTP rejected the offer: ${answer}`)
  const verified = verifyServerIdentity(answer)
  let trusted = serverKey ? serverKey === verified.fingerprint : url.protocol === 'https:'
  if (!trusted && !serverKey && onServerKey) trusted = await onServerKey(verified.fingerprint, url.origin) === true
  if (!trusted) throw new Error(`Untrusted Nethernet server key ${verified.fingerprint}; configure serverKey after verifying it`)
  signal.throwIfAborted()
  return verified.sdp
}

module.exports = { pingHttp, signallingUrl, exchangeOffer }
