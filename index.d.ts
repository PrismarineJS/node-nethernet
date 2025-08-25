import EventEmitter from 'node:events'
import { RemoteInfo, Socket } from 'node:dgram'
import { PeerConnection, DataChannel, IceServer } from 'node-datachannel'

declare module 'node-nethernet' {

  export interface ResponsePacket {
    binary: number[]
    buffer: Buffer
    writeIndex: number
    readIndex: number
    id: number
    packetLength: number
    senderId: bigint
    data: Buffer
  }

  export class Connection {
    nethernet: Client | Server;
    address: bigint;
    rtcConnection: PeerConnection;
    reliable: DataChannel | null;
    unreliable: DataChannel | null;
    promisedSegments: number;
    buf: Buffer | null;
    sendQueue: Buffer[];      

    constructor(nethernet: Client | Server, address: bigint, rtcConnection: PeerConnection);
    setChannels(reliable?: DataChannel | null, unreliable?: DataChannel | null): void;
    handleMessage(data: Buffer | string | ArrayBuffer): void;
    send(data: Buffer | string): number;
    sendNow(data: Buffer): number;
    flushQueue(): void;
    close(): void;
  }

  export interface ServerOptions {
    networkId?: bigint;
  }

  export interface ServerEvents {
    openConnection: (connection: Connection) => void;
    closeConnection: (connectionId: bigint, reason: string) => void;
    encapsulated: (data: Buffer, connectionId: bigint) => void;
    close: (reason?: string) => void;
  }

  export class Server extends EventEmitter {
    options: ServerOptions;
    networkId: bigint;
    connections: Map<bigint, Connection>;
    advertisement?: Buffer;
    socket: Socket;
    serializer: any;
    deserializer: any;

    constructor(options?: ServerOptions);
    handleCandidate(signal: SignalStructure): Promise<void>;
    handleOffer(signal: SignalStructure, respond: (signal: SignalStructure) => void, credentials?: (string | IceServer)[]): Promise<void>;
    processPacket(buffer: Buffer, rinfo: RemoteInfo): void;
    setAdvertisement(buffer: Buffer): void;
    handleRequest(rinfo: RemoteInfo): void;
    handleMessage(packet: any, rinfo: RemoteInfo): void;
    listen(): Promise<void>;
    close(reason?: string): void;

    on<K extends keyof ServerEvents>(event: K, listener: ServerEvents[K]): this;
    emit<K extends keyof ServerEvents>(event: K, ...args: Parameters<ServerEvents[K]>): boolean;
  }

  export interface ClientEvents {
    connected: (connection: Connection) => void;
    disconnect: (connectionId: bigint, reason: string) => void;
    encapsulated: (data: Buffer, connectionId: bigint) => void;
    pong: (packet: any) => void;
  }  

  export class Client extends EventEmitter {
    serverNetworkId: bigint;
    broadcastAddress: string;
    networkId: bigint;
    connectionId: bigint;
    socket: Socket;
    serializer: any;
    deserializer: any;
    responses: Map<bigint, any>;
    addresses: Map<bigint, RemoteInfo>;
    credentials: (string | IceServer)[];
    signalHandler: (signal: SignalStructure) => void;
    connection?: Connection;
    rtcConnection?: PeerConnection;
    pingInterval?: NodeJS.Timeout;
    running: boolean;
  
    constructor(networkId: bigint, broadcastAddress?: string);
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
    emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): boolean;
  }

  export enum SignalType {
    ConnectRequest = 'CONNECTREQUEST',
    ConnectResponse = 'CONNECTRESPONSE',
    CandidateAdd = 'CANDIDATEADD',
    ConnectError = 'CONNECTERROR'
  }

  export class SignalStructure {
    type: SignalType;
    connectionId: bigint;
    data: string;
    networkId?: bigint;

    constructor(type: SignalType, connectionId: bigint, data: string, networkId?: bigint);
    toString(): string;
    static fromString(message: string): SignalStructure;
  }

}
