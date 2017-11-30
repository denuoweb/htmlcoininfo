const {Block} = require('qtumscan-lib')

class Encoding {
  constructor(servicePrefix) {
    this._servicePrefix = servicePrefix
  }

  encodeBlockKey(hash) {
    return Buffer.concat([this._servicePrefix, Buffer.from(hash, 'hex')])
  }

  decodeBlockKey(buffer) {
    return buffer.slice(2).toString('hex')
  }

  encodeBlockValue(block) {
    return block.toBuffer()
  }

  decodeBlockValue(buffer) {
    return Block.fromBuffer(buffer)
  }
}

module.exports = Encoding
