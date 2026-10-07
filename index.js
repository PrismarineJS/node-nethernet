const { pingHttp } = require('./src/signalling/http')
const { Client } = require('./src/client')
const { Server } = require('./src/server')
const { ErrorCode, SignalStructure } = require('./src/signalling/messages')

const SignalType = {
  ConnectRequest: 'CONNECTREQUEST',
  ConnectResponse: 'CONNECTRESPONSE',
  CandidateAdd: 'CANDIDATEADD',
  ConnectError: 'CONNECTERROR'
}

module.exports = {
  Client,
  pingHttp,
  ErrorCode,
  Server,
  SignalType,
  SignalStructure
}
