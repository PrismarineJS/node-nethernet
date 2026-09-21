# node-nethernet
[![NPM version](https://img.shields.io/npm/v/nethernet.svg?logo=npm)](https://npmjs.com/package/nethernet)
[![Build Status](https://img.shields.io/github/actions/workflow/status/PrismarineJS/node-nethernet/ci.yml.svg?label=CI&logo=github)](https://github.com/PrismarineJS/node-nethernet/actions?query=workflow%3A%22CI%22)
[![Try it on gitpod](https://img.shields.io/static/v1.svg?label=try&message=on%20gitpod&color=brightgreen&logo=gitpod)](https://gitpod.io/#https://github.com/PrismarineJS/node-nethernet)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/PrismarineJS)](https://github.com/sponsors/PrismarineJS)

[![Official Discord](https://img.shields.io/static/v1.svg?label=OFFICIAL&message=DISCORD&color=blue&logo=discord&style=for-the-badge)](https://discord.gg/GsEFRM8)


A Node.JS implementation of the NetherNet protocol.

## Install

```sh
npm install nethernet
```

## Example

```ts
const { Client, Server } = require('nethernet')

const server = new Server()
// Client sends request to the broadcast address and server responds with a message
server.setAdvertisement(Buffer.from([0]))
const client = new Client(server.networkId)

client.on('encapsulated', (buffer) => {
  console.assert(buffer.toString() === '\xA0 Hello world')
})

server.on('openConnection', (client) => {
  client.send(Buffer.from('\xA0 Hello world'))
})

server.listen()

client.connect()

```

## Connection options and lifecycle

`new Client(serverNetworkId, broadcastAddress?, options?)` starts UDP discovery.
The default broadcast address is `255.255.255.255`; use `127.0.0.1` for local tests.
Call `connect()` to initiate a connection and listen for `connected`, `disconnect`,
and `error`. `connect()` returns immediately; it is not a promise for connection readiness.

Client options:

- `identity`: optional `{ privateKey, token, domain? }` used to sign the SDP offer.
  `privateKey` must be an EC P-384 private KeyObject, PEM string, or PEM Buffer,
  matching the multiplayer token’s `cpk` public-key claim. `domain` defaults to an empty string.
  The caller obtains the token; this library does not authenticate the account.
  You can assign `client.identity` after authentication, before calling `connect()`.
  Signing failures abort negotiation and report an error; they do not send an unsigned offer.
- `networkId`, `connectionId`: optional bigint IDs. A retry uses a fresh connection ID.
- `iceServers` (or `credentials`, which takes precedence): string STUN/TURN URLs or
  objects such as `{ urls: 'turn:relay.example.com:3478', username: 'user', credential: 'secret' }`.
- `responseTimeoutMs`: defaults to 15000; bounds discovery and then waiting for an answer.
- `inactivityTimeoutMs`: defaults to 5000; bounds connection establishment after the answer,
  not application inactivity once connected.

`new Server(options?)` accepts `networkId`, the same ICE options, and
`acceptTimeoutMs` (default 5000) for waiting for connection establishment after an answer.
A timeout value of zero or less disables that timeout.

Negotiation failures produce a `disconnect` reason of `connecterror:<ErrorCode>`.
Local offer/configuration errors also reach an attached `error` listener; without
one they are logged via `DEBUG=nethernet`. Register listeners before calling `connect()`.
After failure or remote disconnect, call `connect()` again to retry. Repeated calls
while connecting or connected are ignored. Call `close()` when finished to release
discovery sockets, timers, and peer resources, including after a failed attempt.
`close()` is idempotent and works before `connect()`/`listen()`. Explicitly closed
clients and servers cannot be reused; create a new instance.

## External signalling

Assign `client.signalHandler` before `connect()` to send signals through your own
transport instead of UDP discovery. Feed incoming signals to `client.handleSignal()`.
`SignalStructure.networkId` identifies the destination on outgoing signals; set it
to the sender's network ID when delivering an incoming signal. Preserve `connectionId`.

On a server, route `ConnectRequest` to `server.handleOffer(signal, respond)` and
`CandidateAdd` to `server.handleCandidate(signal, respond)`. Route `ConnectError` to
`server.connections.get(signal.connectionId)?.close('connecterror:' + signal.data)`.
The `respond` callback must deliver responses to the client through your transport.
Await these asynchronous handlers and handle transport errors. Deliver the SDP
offer/answer before their ICE candidates; arbitrary signalling reordering is not
currently supported. A server used only for external signalling need not call `listen()`.

## WebRTC API and validation

Peer connections and data channels use `@roamhq/wrtc` and expose the standard
WebRTC API (for example `connectionState`, `getStats()`, and `bufferedAmount`).
Type declarations use TypeScript's DOM interfaces; backend-specific extensions are
not declared. The former `node-datachannel` methods are no longer supported.

`npm test` runs lint, strict TypeScript checks, and runtime tests without forcing
process exit. Tests cover local transport, signalling errors, cancellation, and
resource cleanup. Live Minecraft/Realms and authenticated TURN interoperability
still require testing against a real environment before release.
