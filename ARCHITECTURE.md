# Architecture

NetherNet transports application packets over WebRTC data channels. Minecraft
Bedrock uses it, but this library does not interpret Minecraft game packets or
log players into Microsoft accounts. Its public API deals with peers, signalling,
connections, and byte buffers.

## Connection flow

```text
Discovery             Signalling                WebRTC                  Application
Find a peer      →    Exchange SDP offers,  →    ICE selects a route; →   Send/receive
and its metadata      answers and candidates    establish DTLS/SCTP      NetherNet packets
```

Discovery answers “which server can I contact?” Signalling exchanges the information
needed to establish a connection. WebRTC does not prescribe how applications deliver
those signalling messages; NetherNet supports several ways to do so.

An SDP offer/answer describes connection settings, ICE candidates (possible network
addresses), and DTLS certificate fingerprints. ICE tests candidate routes, potentially
using STUN or TURN when configured. DTLS secures the connection; SCTP carries WebRTC
data channels. WebRTC remains in the data path after signalling completes—it is not
just a handshake followed by plain application UDP.

NetherNet uses client/server roles: the client initiates an offer and the server
answers. A **network ID** is a 64-bit NetherNet peer identifier, not a Minecraft player
ID or an IP address. A **connection ID** identifies a negotiation/connection attempt.
An HTTP client can use `0n` as its remote network ID because the URL identifies the
server instead of LAN discovery.

## Source map

| File or directory | Responsibility |
| --- | --- |
| `src/client.js` | Client state, LAN socket/discovery lifecycle, outgoing WebRTC negotiations, and signalling dispatch. |
| `src/server.js` | Listening LAN socket, advertisements, incoming negotiations, and accepted connections. |
| `src/connection.js` | Data-channel handling, NetherNet packet fragmentation/reassembly, send queues, and connection teardown. The client/server creates the WebRTC peer connection and passes it here. |
| `src/signalling/messages.js` | Shared signalling message types, error codes, and text encoding. |
| `src/signalling/lan.js` | LAN discovery/signalling packet construction, encryption/checksums, and decoding. Socket ownership and peer lookup remain in the client/server. |
| `src/signalling/http.js` | HTTP metadata discovery and complete offer/answer exchange, including server trust policy. |
| `src/signalling/sdpIdentity.js` | Construct and verify NetherNet SDP identity assertions and their signed DTLS fingerprints. This is not account authentication. |
| `src/webrtc.js` | Select the WebRTC implementation: Werift or the optional native implementation. |
| `src/werift/` | Adapt Werift to the WebRTC interfaces the library uses, including TURN redirect handling. |
| `src/datatypes/`, `src/transforms/` | Binary discovery packet schema, ProtoDef types, and serializers. |
| `src/crypto.js` | LAN discovery packet encryption/checksum primitives, distinct from WebRTC's DTLS encryption. |
| `src/util.js` | Network ID generation and ICE server configuration helpers. |

The signalling modules are grouped by responsibility, not subclasses of a common
transport framework. The two built-in modes have different exchange patterns.

## Signalling modes

**LAN:** UDP discovery on port 7551 finds peers and their advertisements. Address
lookup then allows signalling messages to reach the selected network ID. Offers,
answers, and additional ICE candidates travel in discovery-message packets. Candidate
messages can arrive incrementally (“trickle ICE”). Advertisement bytes are opaque to
this library; a consumer such as bedrock-protocol interprets their Minecraft fields.

**HTTP:** `pingHttp()` retrieves `/v1/join` metadata, which may be absent even for a
successful response. A client configured with `http` gathers all ICE candidates,
signs the complete offer, and POSTs it to `/v1/join/{clientNetworkId}`. The response
contains the answer. This path does not send LAN discovery or trickle messages.
HTTP hosting is not implemented by `Server`.

**External services:** An application can supply `client.signalHandler` for outgoing
messages and deliver incoming messages through `client.handleSignal()`. Xbox/Minecraft
services can carry those messages, but their authentication, sessions, and service
clients belong to the application/services layer, not this package.

## Identity and trust

An application's authentication layer supplies the player's token and private key.
The library attaches an `a=identity` assertion binding that identity to the offer's
DTLS fingerprints. It does not obtain tokens or decide which Minecraft accounts may
join a world.

On the HTTP client path, the server answer's self-signed operator token and fingerprint
signature are verified before applying the SDP. These signatures establish possession
of a key; they do not independently establish that it is the intended server. HTTPS
provides endpoint trust through normal TLS certificate validation. Plain HTTP requires
a pinned operator key or explicit application approval. A configured pin is enforced
on HTTPS too. The application owns approval prompts and persistence.

This describes HTTP server-answer verification, not a general authentication guarantee
for every signalling mode. The LAN/server paths do not gain HTTP's trust policy merely
because they share message definitions.

## Lifecycle and boundaries

`Client` and `Server` own sockets, negotiation timers, and connections. HTTP signalling
uses the client's existing offer cancellation signal and response deadline; it does
not introduce a second lifecycle manager. Closing a client cancels pending work, and
an approval that resolves after cancellation cannot apply an answer. An application
approval callback itself must manage any UI/resources it creates.

Keep SDP, ICE, and signalling transport details here. Keep Minecraft version selection,
game packet serialization, account authentication, Xbox sessions, and persistent trust
stores in consumers. The README documents the public API; this file explains ownership
so changes can go in the appropriate module without adding unnecessary abstractions.
