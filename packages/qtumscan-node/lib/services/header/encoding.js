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
    var heightBuffer = Buffer.alloc(4)
    heightBuffer.writeUInt32BE(height)
    return Buffer.concat([this._servicePrefix, this._heightPrefix, heightBuffer])
  }

  encodeHeaderValue(header) {
    let hashBuffer = Buffer.from(header.hash, 'hex')
    let versionBuffer = Buffer.alloc(4)
    versionBuffer.writeInt32BE(header.version)
    let prevHash = Buffer.from(header.prevHash, 'hex')
    let merkleRoot = Buffer.from(header.merkleRoot, 'hex')
    let tsBuffer = Buffer.alloc(4)
    tsBuffer.writeUInt32BE(header.timestamp || header.time)
    let bitsBuffer = Buffer.alloc(4)
    bitsBuffer.writeUInt32BE(header.bits)
    let nonceBuffer = Buffer.alloc(4)
    nonceBuffer.writeUInt32BE(header.nonce)
    let heightBuffer = Buffer.alloc(4)
    heightBuffer.writeUInt32BE(header.height)
    let chainworkBuffer = Buffer.from(header.chainwork, 'hex')
    let nextHash = Buffer.from(header.nextHash || '0'.repeat(64), 'hex')
    return Buffer.concat([
      hashBuffer,
      versionBuffer,
      prevHash,
      merkleRoot,
      tsBuffer,
      bitsBuffer,
      nonceBuffer,
      heightBuffer,
      chainworkBuffer,
      nextHash
    ])
  }

  decodeHeaderValue(buffer) {
    let hash = buffer.slice(0, 32).toString('hex')
    let version = buffer.readInt32BE(32)
    let prevHash = buffer.slice(36, 68).toString('hex')
    let merkleRoot = buffer.slice(68, 100).toString('hex')
    let timestamp = buffer.readUInt32BE(100)
    let bits = buffer.readUInt32BE(104)
    let nonce = buffer.readUInt32BE(108)
    let height = buffer.readUInt32BE(112)
    let chainwork = buffer.slice(116, 116 + 32).toString('hex')
    let nextHash = buffer.slice(116 + 32).toString('hex')
    return {
      hash,
      version,
      prevHash,
      merkleRoot,
      timestamp,
      bits,
      nonce,
      height,
      chainwork,
      nextHash
    }
  }
}

module.exports = Encoding
