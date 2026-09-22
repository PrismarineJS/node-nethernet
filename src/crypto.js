const crypto = require('node:crypto')

const appIdBuffer = Buffer.alloc(8)
appIdBuffer.writeBigUInt64LE(BigInt(0xdeadbeef))

const AES_KEY = crypto.createHash('sha256')
  .update(appIdBuffer)
  .digest()

function encrypt (data) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, iv)
  return Buffer.concat([iv, cipher.update(data), cipher.final()])
}

function decrypt (data) {
  const iv = data.subarray(0, 16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, iv)
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()])
}

function calculateChecksum (data) {
  const hmac = crypto.createHmac('sha256', AES_KEY)
  hmac.update(data)
  return hmac.digest()
}

module.exports = {
  encrypt,
  decrypt,
  calculateChecksum
}
