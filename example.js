const { Client, Server } = require('nethernet')

const server = new Server()
// Client sends request to broadcast address and server responds with a message
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
