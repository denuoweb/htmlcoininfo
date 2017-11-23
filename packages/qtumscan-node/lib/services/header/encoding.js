const {BufferReader, BufferWriter} = require('qtumscan-lib').encoding

class Encoding {
  constructor(servicePrefix) {
    this._servicePrefix = servicePrefix
    this._hashPrefix = Buffer.from('00', 'hex')
    this._heightPrefix = Buffer.from('01', 'hex')
  }

  encodeHeaderHashKey(hash) {
    let hashBuffer = Buffer.from(hash, 'hex')
    return Buffer.concat([this._servicePrefix, this._hashPrefix, hashBuffer])
  }

  decodeHeaderHashKey(buffer) {
    return buffer.slice(3).toString('hex')
  }

  encodeHeaderHeightKey(height) {
    let heightBuffer = Buffer.alloc(4)
    heightBuffer.writeUInt32BE(height)
    return Buffer.concat([this._servicePrefix, this._heightPrefix, heightBuffer])
  }

  encodeHeaderValue(header) {
    let writer = new BufferWriter()
    writer.write(Buffer.from(header.hash, 'hex'))
    writer.writeInt32BE(header.version)
    writer.write(Buffer.from(header.prevHash, 'hex'))
    writer.write(Buffer.from(header.merkleRoot, 'hex'))
    writer.writeUInt32BE(header.timestamp || header.time)
    writer.writeUInt32BE(header.bits)
    writer.writeUInt32BE(header.nonce)
    writer.write(Buffer.from(header.hashStateRoot, 'hex'))
    writer.write(Buffer.from(header.hashUTXORoot, 'hex'))
    writer.write(Buffer.from(header.prevOutStakeHash, 'hex'))
    writer.writeUInt32BE(header.prevOutStakeN)
    writer.writeVarintNum(header.vchBlockSig.length)
    writer.write(Buffer.from(header.vchBlockSig, 'hex'))
    writer.write(Buffer.from(header.chainwork, 'hex'))
    writer.write(Buffer.from(header.nextHash || '0'.repeat(64), 'hex'))
    return writer.toBuffer()
  }

  decodeHeaderValue(buffer) {
    let reader = new BufferReader(buffer)
    let hash = reader.read(32).toString('hex')
    let version = reader.readInt32BE()
    let prevHash = reader.read(32).toString('hex')
    let merkleRoot = reader.read(32).toString('hex')
    let timestamp = reader.readUInt32BE()
    let bits = reader.readUInt32BE()
    let nonce = reader.readUInt32BE()
    let hashStateRoot = reader.read(32).toString('hex')
    let hashUTXORoot = reader.read(32).toString('hex')
    let prevOutStakeHash = reader.read(32).toString('hex')
    let prevOutStakeN = reader.readUInt32BE()
    let num = reader.readVarintNum()
    let vchBlockSig = reader.read(num).toString('hex')
    let height = reader.readUInt32BE()
    let chainwork = reader.read(32).toString('hex')
    let nextHash = reader.read(32).toString('hex')
    return {
      hash,
      version,
      prevHash,
      merkleRoot,
      timestamp,
      bits,
      nonce,
      hashStateRoot,
      hashUTXORoot,
      prevOutStakeHash,
      prevOutStakeN,
      vchBlockSig,
      height,
      chainwork,
      nextHash
    }
  }
}

module.exports = Encoding
