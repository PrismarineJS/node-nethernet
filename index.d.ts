import EventEmitter from 'node:events'
import { RemoteInfo, Socket } from 'node:dgram'
import { RTCPeerConnection, RTCDataChannel, RTCIceServer } from 'werift'

declare module 'node-nethernet' {

  interface ResponsePacket {
    binary: number[]
    buffer: Buffer
    writeIndex: number
    readIndex: number
    id: number
    packetLength: number
    senderId: bigint
    data: Buffer
  }

  export declare class Connection {
    nethernet: Client | Server;
    address: bigint;
    rtcConnection: RTCPeerConnection;
    reliable: RTCDataChannel | null;
    unreliable: RTCDataChannel | null;
    promisedSegments: number;
    buf: Buffer;
    sendQueue: Buffer[];

    constructor(nethernet: Client | Server, address: bigint, rtcConnection: RTCPeerConnection);
    setChannels(reliable: RTCDataChannel | null, unreliable: RTCDataChannel | null): void;
    handleMessage(data: Buffer | string): void;
    send(data: Buffer | string): number;
    sendNow(data: Buffer): number;
    flushQueue(): void;
    close(): void;
  }

  interface ServerOptions {
    networkId?: bigint;
  }

  declare interface ServerEvents {
    openConnection: (connection: Connection) => void;
    closeConnection: (connectionId: bigint, reason: string) => void;
    close: (reason?: string) => void;
  }

  export class Server extends EventEmitter {
    options: ServerOptions;
    networkId: bigint;
    connections: Map<string, Connection>;
    advertisement?: Buffer;
    socket: Socket;

    constructor(options?: ServerOptions);
    handleCandidate(signal: SignalStructure): Promise<void>;
    handleOffer(signal: SignalStructure, respond: (signal: SignalStructure) => void, credentials?: RTCIceServer[]): Promise<void>;
    processPacket(buffer: Buffer, rinfo: RemoteInfo): void;
    setAdvertisement(buffer: Buffer): void;
    handleRequest(rinfo: RemoteInfo): void;
    handleMessage(packet: any, rinfo: RemoteInfo): void;
    listen(): Promise<void>;
    send(buffer: Buffer): void;
    close(reason?: string): void;

    on<K extends keyof ServerEvents>(event: K, listener: ServerEvents[K]): this;
  }

  declare interface ClientEvents {
    connected: (connection: Connection) => void;
    disconnect: (connectionId: bigint, reason: string) => void;
    pong: (packet: ResponsePacket) => void;
  }  

  export declare class Client extends EventEmitter {
    serverNetworkId: bigint;
    networkId: bigint;
    connectionId: bigint;
    socket: Socket;
    responses: Map<bigint, Buffer>;
    addresses: Map<bigint, RemoteInfo>;
    credentials: RTCIceServer[];
    signalHandler: (signal: SignalStructure) => void;
    connection?: Connection;
    rtcConnection?: RTCPeerConnection;
    pingInterval?: NodeJS.Timeout;
    running: boolean;
  
    constructor(networkId: bigint);
    handleCandidate(signal: SignalStructure): Promise<void>;
    handleAnswer(signal: SignalStructure): Promise<void>;
    createOffer(): Promise<void>;
    processPacket(buffer: Buffer, rinfo: RemoteInfo): void;
    handleResponse(packet: any, rinfo: RemoteInfo): void;
    handleMessage(packet: any): void;
    handleSignal(signal: SignalStructure): void;
    sendDiscoveryRequest(): void;
    sendDiscoveryMessage(signal: SignalStructure): void;
    connect(): Promise<void>;
    send(buffer: Buffer): void;
    ping(): void;
    close(reason?: string): void;

    on<K extends keyof ClientEvents>(event: K, listener: ClientEvents[K]): this;
  }

  export declare enum SignalType {
    ConnectRequest = 'CONNECTREQUEST',
    ConnectResponse = 'CONNECTRESPONSE',
    CandidateAdd = 'CANDIDATEADD',
    ConnectError = 'CONNECTERROR'
  }

  export declare class SignalStructure {
    type: SignalType;
    connectionId: bigint;
    data: string;
    networkId?: bigint;

    constructor(type: SignalType, connectionId: bigint, data: string, networkId?: bigint);
    toString(): string;
    static fromString(message: string): SignalStructure;
  }

}
