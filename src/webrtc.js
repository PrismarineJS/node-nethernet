function getWebRTC (backend = 'werift') {
  if (!['werift', 'wrtc', 'auto'].includes(backend)) {
    throw new Error(`Unknown WebRTC backend: ${backend}`)
  }
  if (backend !== 'werift') {
    try {
      return require('@roamhq/wrtc')
    } catch (cause) {
      if (backend === 'wrtc') {
        throw new Error('The wrtc backend requires a working @roamhq/wrtc installation. Install it separately or use webrtcBackend: "werift".', { cause })
      }
    }
  }
  return require('./backends/werift')
}

module.exports = { getWebRTC }
