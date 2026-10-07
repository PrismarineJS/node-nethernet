const getRandomUint64 = () => {
  const high = Math.floor(Math.random() * 0xFFFFFFFF)
  const low = Math.floor(Math.random() * 0xFFFFFFFF)

  return (BigInt(high) << 32n) | BigInt(low)
}

const normalizeIceServers = (iceServers = []) => {
  return iceServers.map(iceServer => typeof iceServer === 'string' ? { urls: iceServer } : iceServer)
}

// Reject malformed entries before the native constructor allocates resources.
const validateIceServers = (iceServers) => {
  for (const server of iceServers) {
    if (!server || typeof server !== 'object') throw new TypeError('ICE servers must be objects')
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    if (!urls.length || urls.some(url => typeof url !== 'string' || !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))) {
      throw new TypeError('ICE servers require valid STUN or TURN URLs')
    }
    for (const key of ['username', 'credential']) {
      if (server[key] !== undefined && typeof server[key] !== 'string') throw new TypeError(`ICE ${key} must be a string`)
    }
    if (urls.some(url => /^turns?:/.test(url)) && (!server.username || !server.credential)) {
      throw new TypeError('TURN servers require username and credential')
    }
  }
  return iceServers
}

module.exports = { getRandomUint64, normalizeIceServers, validateIceServers }
