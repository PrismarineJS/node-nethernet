import { generateKeyPairSync } from 'node:crypto'
import { pingHttp, Client, Connection, ErrorCode, IceServer, Server, SignalStructure, SignalType } from 'nethernet'

const iceServer: IceServer = {
  urls: ['stun:stun.example.com:3478'],
  username: 'user',
  credential: 'password'
}

const server = new Server({
  webrtcBackend: 'werift',
  networkId: 1n,
  iceServers: [iceServer, 'stun:stun.example.com:3478'],
  acceptTimeoutMs: 5_000
})

const client = new Client(server.networkId, undefined, {
  identity: { privateKey: generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey, token: 'multiplayer-token' },
  webrtcBackend: 'auto',
  networkId: 2n,
  connectionId: 3n,
  credentials: [iceServer, 'stun:stun.example.com:3478'],
  responseTimeoutMs: 15_000,
  inactivityTimeoutMs: 5_000
})

client.on('connected', (connection: Connection) => connection.close('done'))
client.on('error', (error: Error) => error.message)
client.signalHandler = (signal: SignalStructure) => signal.toString()

const connectResult: void = client.connect()
const signal = new SignalStructure(SignalType.ConnectError, client.connectionId, String(ErrorCode.CandidateAdd), server.networkId)

client.handleSignal(signal)
void server.handleCandidate(signal, response => response.toString())
if (client.rtcConnection) {
  const state: RTCPeerConnectionState = client.rtcConnection.connectionState
  void state
  void client.rtcConnection.getStats()
}
client.on('connected', connection => {
  if (connection.reliable) {
    const buffered: number = connection.reliable.bufferedAmount
    connection.reliable.send(Buffer.from('test'))
    void buffered
  }
})
void connectResult

client.identity = { privateKey: 'PEM key', token: 'refreshed-token', domain: '' }

new Server({ host: '127.0.0.1' })

new Server({ webrtcBackend: 'wrtc' })
// @ts-expect-error Unknown backend
new Client(1n, undefined, { webrtcBackend: 'unknown' })

const httpClient = new Client(0n, undefined, {
  http: { url: 'https://server.example.com', onServerKey: async (key, origin) => key.startsWith('sha256:') && origin === 'https://server.example.com' },
  responseTimeoutMs: 5000
})
void httpClient
void pingHttp('http://localhost:19132').then(ad => {
  const protocol: number | undefined = ad.protocol
  return protocol
})
