class Encoding {
  constructor(servicePrefix) {
    this.servicePrefix = servicePrefix
    this.blockPrefix = Buffer.from('00', 'hex')
    this.timestampPrefix = Buffer.from('01', 'hex')
  }

  encodeBlockTimestampKey(hash) {
    return Buffer.concat([this.servicePrefix, this.blockPrefix, Buffer.from(hash, 'hex')])
  }

  decodeBlockTimestampKey(buffer) {
    return buffer.slice(3).toString('hex')
  }

  encodeBlockTimestampValue(timestamp) {
    let timestampBuffer = Buffer.alloc(4)
    timestampBuffer.writeUInt32BE(timestamp)
    return timestampBuffer
  }

  decodeBlockTimestampValue(buffer) {
    return buffer.readUInt32BE()
  }

  encodeTimestampBlockKey(timestamp) {
    let timestampBuffer = Buffer.alloc(4)
    timestampBuffer.writeUInt32BE(timestamp)
    return Buffer.concat([this.servicePrefix, this.timestampPrefix, timestampBuffer])
  }

  decodeTimestampBlockKey(buffer) {
    return buffer.readUInt32BE(3)
  }

  encodeTimestampBlockValue(hash) {
    return Buffer.from(hash, 'hex')
  }

  decodeTimestampBlockValue(buffer) {
    return buffer.toString('hex')
  }
}

module.exports = Encoding
