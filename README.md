# node-nethernet
[![NPM version](https://img.shields.io/npm/v/node-nethernet.svg?logo=npm)](http://npmjs.com/package/node-nethernet)
[![Build Status](https://img.shields.io/github/actions/workflow/status/PrismarineJS/node-nethernet/ci.yml.svg?label=CI&logo=github)](https://github.com/PrismarineJS/node-nethernet/actions?query=workflow%3A%22CI%22)
[![Try it on gitpod](https://img.shields.io/static/v1.svg?label=try&message=on%20gitpod&color=brightgreen&logo=gitpod)](https://gitpod.io/#https://github.com/PrismarineJS/node-nethernet)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/PrismarineJS)](https://github.com/sponsors/PrismarineJS)

[![Official Discord](https://img.shields.io/static/v1.svg?label=OFFICIAL&message=DISCORD&color=blue&logo=discord&style=for-the-badge)](https://discord.gg/GsEFRM8)


A Node.JS implementation of the NetherNet protocol.

## Install

```sh
npm install node-nethernet
```

## Example

```ts
const { Client, Server } = require('node-nethernet')

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
