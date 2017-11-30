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
    writer.writeHexString(header.hash)
    writer.writeInt32BE(header.version)
    writer.writeHexString(header.prevHash)
    writer.writeHexString(header.merkleRoot)
    writer.writeUInt32BE(header.timestamp || header.time)
    writer.writeUInt32BE(header.bits)
    writer.writeUInt32BE(header.nonce)
    writer.writeHexString(header.hashStateRoot)
    writer.writeHexString(header.hashUTXORoot)
    writer.writeHexString(header.prevOutStakeHash)
    writer.writeUInt32BE(header.prevOutStakeN)
    writer.writeVarintNum(header.vchBlockSig.length >>> 1)
    writer.writeHexString(header.vchBlockSig)
    writer.writeUInt32BE(header.height)
    writer.writeHexString(header.chainwork)
    writer.writeHexString(header.nextHash || '0'.repeat(64))
    return writer.toBuffer()
  }

  decodeHeaderValue(buffer) {
    let reader = new BufferReader(buffer)
    let hash = reader.readHexString(32)
    let version = reader.readInt32BE()
    let prevHash = reader.readHexString(32)
    let merkleRoot = reader.readHexString(32)
    let timestamp = reader.readUInt32BE()
    let bits = reader.readUInt32BE()
    let nonce = reader.readUInt32BE()
    let hashStateRoot = reader.readHexString(32)
    let hashUTXORoot = reader.readHexString(32)
    let prevOutStakeHash = reader.readHexString(32)
    let prevOutStakeN = reader.readUInt32BE()
    let num = reader.readVarintNum()
    let vchBlockSig = reader.readHexString(num)
    let height = reader.readUInt32BE()
    let chainwork = reader.readHexString(32)
    let nextHash = reader.readHexString(32)
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
