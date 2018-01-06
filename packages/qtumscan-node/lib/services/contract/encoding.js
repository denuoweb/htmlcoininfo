const BN = require('bn.js')
const {BufferReader, BufferWriter} = require('qtumscan-lib').encoding

class Encoding {
  constructor(servicePrefix) {
    this._servicePrefix = servicePrefix
    this._contractPrefix = Buffer.from('00', 'hex')
    this._contractTransactionPrefix = Buffer.from('01', 'hex')
    this._utxoPrefix = Buffer.from('02', 'hex')
    this._usedUtxoPrefix = Buffer.from('03', 'hex')
    this._tokenPrefix = Buffer.from('04', 'hex')
    this._tokenTransferPrefix = Buffer.from('05', 'hex')
  }

  encodeContractKey(address) {
    return Buffer.concat([this._servicePrefix, this._contractPrefix, Buffer.from(address, 'hex')])
  }

  decodeContractKey(buffer) {
    return {address: buffer.slice(3).toString('hex')}
  }

  encodeContractValue(txid, owner) {
    return Buffer.concat([Buffer.from(txid, 'hex'), Buffer.from(owner)])
  }

  decodeContractValue(buffer) {
    return {
      txid: buffer.slice(0, 32).toString('hex'),
      owner: buffer.slice(32).toString()
    }
  }

  encodeContractTransactionKey(address, height = 0, txid = '0'.repeat(64)) {
    let writer = new BufferWriter()
    writer.write(this._servicePrefix)
    writer.write(this._contractTransactionPrefix)
    writer.writeHexString(address)
    writer.writeUInt32BE(height)
    writer.writeHexString(txid)
    return writer.toBuffer()
  }

  decodeContractTransactionKey(buffer) {
    let reader = new BufferReader(buffer)
    reader.set({pos: 3})
    let address = reader.readHexString(20)
    let height = reader.readUInt32BE()
    let txid = reader.readHexString(32)
    return {address, height, txid}
  }

  encodeContractUtxoKey(address, txid = '0'.repeat(64), outputIndex = 0) {
    let writer = new BufferWriter()
    writer.write(this._servicePrefix)
    writer.write(this._utxoPrefix)
    writer.write(Buffer.from(address, 'hex'))
    if (Buffer.isBuffer(txid)) {
      writer.write(txid)
    } else {
      writer.writeHexString(txid)
    }
    writer.writeUInt32BE(outputIndex)
    return writer.toBuffer()
  }

  decodeContractUtxoKey(buffer) {
    let reader = new BufferReader(buffer)
    reader.set({pos: 3})
    let address = reader.readHexString(20)
    let txid = reader.readHexString(32)
    let outputIndex = reader.readUInt32BE()
    return {address, txid, outputIndex}
  }

  encodeContractUtxoValue(height, satoshis, timestamp) {
    let writer = new BufferWriter()
    writer.writeUInt32BE(height)
    writer.writeDoubleBE(satoshis)
    writer.writeUInt32BE(timestamp)
    return writer.toBuffer()
  }

  decodeContractUtxoValue(buffer) {
    let reader = new BufferReader(buffer)
    let height = reader.readUInt32BE()
    let satoshis = reader.readDoubleBE()
    let timestamp = reader.readUInt32BE()
    return {height, satoshis, timestamp}
  }

  encodeContractUsedUtxoKey(address, txid = '0'.repeat(64), outputIndex = 0) {
    let writer = new BufferWriter()
    writer.write(this._servicePrefix)
    writer.write(this._usedUtxoPrefix)
    writer.write(Buffer.from(address, 'hex'))
    if (Buffer.isBuffer(txid)) {
      writer.write(txid)
    } else {
      writer.writeHexString(txid)
    }
    writer.writeUInt32BE(outputIndex)
    return writer.toBuffer()
  }

  decodeContractUsedUtxoKey(buffer) {
    let reader = new BufferReader(buffer)
    reader.set({pos: 3})
    let address = reader.readHexString(20)
    let txid = reader.readHexString(32)
    let outputIndex = reader.readUInt32BE()
    return {address, txid, outputIndex}
  }

  encodeContractUsedUtxoValue(height, satoshis, timestamp, outputTxid, spentHeight) {
    let writer = new BufferWriter()
    writer.writeUInt32BE(height)
    writer.writeDoubleBE(satoshis)
    writer.writeUInt32BE(timestamp)
    writer.writeHexString(outputTxid)
    writer.writeUInt32BE(spentHeight)
    return writer.toBuffer()
  }

  decodeContractUsedUtxoValue(buffer) {
    let reader = new BufferReader(buffer)
    let height = reader.readUInt32BE()
    let satoshis = reader.readDoubleBE()
    let timestamp = reader.readUInt32BE()
    let outputTxid = reader.readHexString(32)
    let spentHeight = reader.readUInt32BE()
    return {height, satoshis, timestamp, outputTxid, spentHeight}
  }

  encodeTokenKey(address) {
    return Buffer.concat([this._servicePrefix, this._tokenPrefix, Buffer.from(address, 'hex')])
  }

  decodeTokenKey(buffer) {
    return {address: buffer.slice(3).toString('hex')}
  }

  encodeTokenValue(name, symbol, decimals, totalSupply) {
    let writer = new BufferWriter()
    writer.writeUInt8(Buffer.from(name).length)
    writer.write(Buffer.from(name))
    writer.writeUInt8(Buffer.from(symbol).length)
    writer.write(Buffer.from(symbol))
    writer.writeUInt8(decimals)
    writer.write(totalSupply.toBuffer('be', 32))
    return writer.toBuffer()
  }

  decodeTokenValue(buffer) {
    let reader = new BufferReader(buffer)
    let nameLength = reader.readUInt8()
    let name = reader.read(nameLength).toString()
    let symbolLength = reader.readUInt8()
    let symbol = reader.read(symbolLength).toString()
    let decimals = reader.readUInt8()
    let totalSupply = new BN(reader.read(32), 10, 'be')
    return {name, symbol, decimals, totalSupply}
  }

  encodeTokenTransferKey(txid, index) {
    let writer = new BufferWriter()
    writer.write(this._servicePrefix)
    writer.write(this._tokenTransferPrefix)
    writer.writeHexString(txid)
    writer.writeUInt32BE(index)
    return writer.toBuffer()
  }

  decodeTokenTransferKey(buffer) {
    let reader = new BufferReader(buffer)
    reader.set({pos: 3})
    let txid = reader.readHexString(32)
    let index = reader.readUInt32BE()
    return {txid, index}
  }

  encodeTokenTransferValue(address, from, to, amount) {
    let writer = new BufferWriter()
    writer.writeHexString(address)
    writer.write(Buffer.from(from))
    writer.write(Buffer.from(to))
    writer.write(amount.toBuffer('be', 32))
    return writer.toBuffer()
  }

  decodeTokenTransferValue(buffer) {
    let reader = new BufferReader(buffer)
    let address = reader.readHexString(20)
    let from = reader.read(34).toString()
    let to = reader.read(34).toString()
    let amount = new BN(reader.read(32), 10, 'be')
    return {address, from, to, amount}
  }
}

module.exports = Encoding
