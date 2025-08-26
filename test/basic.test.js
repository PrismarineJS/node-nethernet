/* eslint-env mocha */
process.env.DEBUG = '*'
const { Server, Client } = require('nethernet')

async function pingTest () {
  return new Promise((resolve, reject) => {
    const message = 'FMCPE;JSRakNet - JS powered RakNet;408;1.16.20;0;5;0;JSRakNet;Creative;'
    const server = new Server()
    server.setAdvertisement(Buffer.from(message))
    const client = new Client(server.networkId, '127.0.0.1')
    client.once('pong', (packet) => {
      console.log('PONG data', packet)
      const msg = Buffer.from(packet.data, 'hex').toString()
      if (!msg || msg !== message) throw Error(`PONG mismatch ${msg} != ${message}`)
      console.log('OK')
      client.close()
      server.close()
      setTimeout(() => {
        resolve() // allow for server + client to close
      }, 500)
    })

    server.listen()
    client.ping()
  })
}

async function connectTest () {
  return new Promise((resolve, reject) => {
    const message = 'FMCPE;JSRakNet - JS powered RakNet;408;1.16.20;0;5;0;JSRakNet;Creative;'
    const server = new Server()
    server.setAdvertisement(Buffer.from(message))
    const client = new Client(server.networkId, '127.0.0.1')

    server.listen()
    let lastC = 0
    client.on('connected', () => {
      console.log('connected!')
      client.on('encapsulated', (encap) => {
        console.assert(encap[0] === 0xf0)
        const ix = encap[1]
        if (lastC++ !== ix) {
          throw Error(`Packet mismatch: ${lastC - 1} != ${ix}`)
        }
        client.send(encap)
      })
    })
    let lastS = 0
    server.on('encapsulated', (encap) => {
      console.assert(encap[0] === 0xf0)
      const ix = encap[1]
      if (lastS++ !== ix) {
        throw Error(`Packet mismatch: ${lastS - 1} != ${ix}`)
      }
      if (lastS === 50) {
        client.close()
        server.close()
        resolve(true)
      }
    })
    server.on('openConnection', (client) => {
      console.debug('Client opened connection')
      for (let i = 0; i < 50; i++) {
        const buf = Buffer.alloc(1000)
        for (let j = 0; j < 64; j += 4) buf[j] = j + i
        buf[0] = 0xf0
        buf[1] = i
        client.send(buf)
      }
    })
    client.connect()
  })
}

async function kickTest () {
  return new Promise((resolve, reject) => {
    const server = new Server()
    server.setAdvertisement(Buffer.from([0]))
    const client = new Client(server.networkId, '127.0.0.1')
    server.on('openConnection', (con) => {
      console.log('new connection')
      con.close()
    })
    server.listen()
    client.on('disconnect', packet => {
      console.log('Client got disconnect', packet)
      try {
        client.send(Buffer.from('\xf0 yello'))
      } catch (e) {
        console.log('** Expected error 😀 **', e)
        server.close()
        client.close()
        resolve()
      }
    })

    client.connect()
  })
}

describe('server tests', function () {
  this.timeout(30000)
  it('ping test', pingTest)
  it('connection test', connectTest)
  it('kick test', kickTest)
})
