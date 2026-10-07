const SignalType = {
  ConnectRequest: 'CONNECTREQUEST',
  ConnectResponse: 'CONNECTRESPONSE',
  CandidateAdd: 'CANDIDATEADD',
  ConnectError: 'CONNECTERROR'
}

const ErrorCode = {
  None: 0,
  DestinationNotLoggedIn: 1,
  NegotiationTimeout: 2,
  WrongTransportVersion: 3,
  FailedToCreatePeerConnection: 4,
  ICE: 5,
  ConnectRequest: 6,
  ConnectResponse: 7,
  CandidateAdd: 8,
  InactivityTimeout: 9,
  FailedToCreateOffer: 10,
  FailedToCreateAnswer: 11,
  FailedToSetLocalDescription: 12,
  FailedToSetRemoteDescription: 13,
  NegotiationTimeoutWaitingForResponse: 14,
  NegotiationTimeoutWaitingForAccept: 15,
  IncomingConnectionIgnored: 16,
  SignalingParsingFailure: 17,
  SignalingUnknownError: 18,
  SignalingUnicastMessageDeliveryFailed: 19,
  SignalingBroadcastDeliveryFailed: 20,
  SignalingMessageDeliveryFailed: 21,
  SignalingTurnAuthFailed: 22,
  SignalingFallbackToBestEffortDelivery: 23,
  NoSignalingChannel: 24,
  NotLoggedIn: 25,
  SignalingFailedToSend: 26
}

class SignalStructure {
  constructor (type, connectionId, data, networkId) {
    this.type = type
    this.connectionId = connectionId
    this.data = data
    this.networkId = networkId
  }

  toString () {
    return `${this.type} ${this.connectionId} ${this.data}`
  }

  static fromString (message) {
    const [type, connectionId, ...data] = message.split(' ')

    return new this(type, BigInt(connectionId), data.join(' '))
  }
}

module.exports = { ErrorCode, SignalStructure, SignalType }
