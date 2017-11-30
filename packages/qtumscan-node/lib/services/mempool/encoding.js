const {Transaction} = require('qtumscan-lib')

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
    return Transaction.fromBuffer(buffer)
  }

  encodeMempoolAddressKey(address, txid, index, input) {
    let addressSizeBuffer = Buffer.alloc(1)
    addressSizeBuffer.writeUInt8(address.length)

    let indexBuffer = Buffer.alloc(4)
    indexBuffer.writeUInt32BE(index || 0)

    let inputBuffer = Buffer.alloc(1)
    inputBuffer.writeUInt8(input || 0)

    return Buffer.concat([
      this.servicePrefix,
      this.addressPrefix,
      addressSizeBuffer,
      Buffer.from(address),
      indexBuffer,
      inputBuffer
    ])
  }

  decodeMempoolAddressKey(buffer) {
    let addressSize = buffer.readUInt8(3)
    let address = buffer.slice(4, address + 4).toString()
    let txid = buffer.slice(addressSize + 4, addressSize + 36).toString('hex')
    let index = buffer.readUInt32BE(addressSize + 36)
    let input = buffer.readUInt8(addressSize + 40)

    return {address, txid, index, input}
  }
}

module.exports = Encoding
