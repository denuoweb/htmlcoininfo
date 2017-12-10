const qtumscan = require('qtumscan-lib')
const Transaction = qtumscan.Transaction
const {BufferReader, BufferWriter} = qtumscan.encoding

class Encoding {
  constructor(servicePrefix) {
    this.servicePrefix = servicePrefix
    this.txPrefix = Buffer.from('00', 'hex')
    this.addressPrefix = Buffer.from('01', 'hex')
  }

  encodeMempoolTransactionKey(txid) {
    return Buffer.concat([this.servicePrefix, this.txPrefix, Buffer.from(txid, 'hex')])
  }

  decodeMempoolTransactionKey(buffer) {
    return buffer.slice(3).toString('hex')
  }

  encodeMempoolTransactionValue(transaction) {
    return transaction.toBuffer()
  }

  decodeMempoolTransactionValue(buffer) {
    return new Transaction().fromBuffer(buffer)
  }

  encodeMempoolAddressKey(address, txid, index, input) {
    let writer = new BufferWriter()
    writer.write(this.servicePrefix)
    writer.write(this.addressPrefix)
    writer.writeUInt8(address.length)
    writer.write(Buffer.from(address))
    writer.writeHexString(txid || '0'.repeat(64))
    writer.writeUInt32BE(index || 0)
    writer.writeUInt8(input || 0)
    return writer.toBuffer()
  }

  decodeMempoolAddressKey(buffer) {
    let reader = new BufferReader(buffer)
    reader.set({pos: 3})
    let addressSize = reader.readUInt8()
    let address = reader.read(addressSize).toString()
    let txid = reader.readHexString(32)
    let index = reader.readUInt32BE()
    let input = buffer.readUInt8()
    return {address, txid, index, input}
  }
}

module.exports = Encoding
