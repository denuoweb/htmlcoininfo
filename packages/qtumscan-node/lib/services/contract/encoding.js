const BN = require('bn.js')
const {BufferReader, BufferWriter} = require('qtumscan-lib').encoding

class Encoding {
  constructor(servicePrefix) {
    this._servicePrefix = servicePrefix
    this._tokenPrefix = Buffer.from('00', 'hex')
    this._tokenTransactionPrefix = Buffer.from('01', 'hex')
    this._tokenTransferPrefix = Buffer.from('02', 'hex')
  }

  encodeTokenKey(contract) {
    return Buffer.concat([this._servicePrefix, this._tokenPrefix, Buffer.from(contract, 'hex')])
  }

  decodeTokenKey(buffer) {
    return {contract: buffer.slice(3).toString('hex')}
  }

  encodeTokenValue(name, symbol, decimals, totalSupply) {
    let writer = new BufferWriter()
    writer.writeUInt8(name.length)
    writer.write(Buffer.from(name))
    writer.writeUInt8(symbol.length)
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

  encodeTokenTransactionKey(contract, height, txid) {
    let writer = new BufferWriter()
    writer.write(this._servicePrefix)
    writer.write(this._tokenTransactionPrefix)
    writer.writeHexString(contract)
    writer.writeUInt32BE(height)
    writer.writeHexString(txid)
    return writer.toBuffer()
  }

  decodeTokenTransactionKey(buffer) {
    let reader = new BufferReader(buffer)
    reader.set({pos: 3})
    let contract = reader.readHexString(20)
    let height = reader.readUInt32BE()
    let txid = reader.readHexString(32)
    return {contract, height, txid}
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

  encodeTokenTransferValue(contract, from, to, amount) {
    let writer = new BufferWriter()
    writer.writeHexString(contract)
    writer.write(Buffer.from(from))
    writer.write(Buffer.from(to))
    writer.write(amount.toBuffer('be', 32))
    return writer.toBuffer()
  }

  decodeTokenTransferValue(buffer) {
    let reader = new BufferReader(buffer)
    let contract = reader.readHexString(20)
    let from = reader.read(34).toString()
    let to = reader.read(34).toString()
    let amount = new BN(reader.read(32), 10, 'be')
    return {contract, from, to, amount}
  }
}

module.exports = Encoding
