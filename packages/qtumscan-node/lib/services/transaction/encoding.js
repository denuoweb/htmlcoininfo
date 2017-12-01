const qtumscan = require('qtumscan-lib')
const Transaction = qtumscan.Transaction
const {BufferReader, BufferWriter} = qtumscan.encoding

class Encoding {
  constructor(servicePrefix) {
    this.servicePrefix = servicePrefix
    this.txIndex = Buffer.from('00', 'hex')
    this.spentIndex = Buffer.from('01', 'hex')
    this.doubleSpentIndex = Buffer.from('02', 'hex')
  }

  encodeTransactionKey(txid) {
    return Buffer.concat([this.servicePrefix, this.txIndex, Buffer.from(txid, 'hex')])
  }

  decodeTransactionKey(buffer) {
    return buffer.slice(3).toString('hex')
  }

  encodeTransactionValue(transaction) {
    let writer = new BufferWriter()
    writer.writeUInt32BE(transaction.__height)
    writer.writeHexString(transaction.__blockhash)
    writer.writeUInt32BE(transaction.__timestamp)
    let inputValues = transaction.__inputValues
    writer.writeUInt16BE(inputValues.length)
    for (let item of inputValues) {
      writer.writeDoubleBE(item)
    }
    writer.write(transaction.toBuffer())
    return writer.toBuffer()
  }

  decodeTransactionValue(buffer) {
    let reader = new BufferReader(buffer)
    let height = reader.readUInt32BE()
    let blockhash = reader.readHexString(32)
    let timestamp = reader.readUInt32BE()
    let inputValuesLength = reader.readUInt16BE()
    let inputValues = []
    for (let i = 0; i < inputValuesLength; ++i) {
      inputValues.push(reader.readDoubleBE())
    }
    let transaction = new Transaction(reader.readAll())
    transaction.__height = height
    transaction.__blockhash = blockhash
    transaction.__timestamp = timestamp
    transaction.__inputValues = inputValues
    return transaction
  }

  encodeSpentKey(txid, outputIndex) {
    let outputIndexBuffer = Buffer.alloc(4)
    outputIndexBuffer.writeUInt32BE(outputIndex)
    return Buffer.concat([
      this.servicePrefix, this.spentIndex,
      Buffer.from(txid, 'hex'), outputIndexBuffer
    ])
  }

  decodeSpentKey(buffer) {
    let txid = buffer.slice(3, 35).toString('hex')
    let outputIndex = buffer.readUInt32BE(35)
    return {txid, outputIndex}
  }

  encodeSpentValue(txid, inputIndex, blockHeight, blockHash) {
    let writer = new BufferWriter()
    writer.writeHexString(txid)
    writer.writeUInt32BE(inputIndex)
    writer.writeUInt32BE(blockHeight)
    writer.writeHexString(blockHash)
    return writer.toBuffer()
  }

  decodeSpentValue(buffer) {
    let reader = new BufferReader(buffer)
    let txid = reader.readHexString(32)
    let inputIndex = reader.readUInt32BE()
    let blockHeight = reader.readUInt32BE()
    let blockHash = reader.readHexString(32)
    return {txid, inputIndex, blockHeight, blockHash}
  }

  encodeDoubleSpentKey(txid, outputIndex) {
    let outputIndexBuffer = Buffer.alloc(4)
    outputIndexBuffer.writeUInt32BE(outputIndex)
    return Buffer.concat([
      this.servicePrefix, this.doubleSpentIndex,
      Buffer.from(txid, 'hex'), outputIndexBuffer
    ])
  }

  decodeDoubleSpentKey(buffer) {
    return this.decodeSpentKey(buffer)
  }

  encodeDoubleSpentValue(txid, inputIndex, blockHeight, blockHash) {
    return this.encodeSpentValue(txid, inputIndex, blockHeight, blockHash)
  }

  decodeDoubleSpentValue(buffer) {
    return this.decodeSpentValue(buffer)
  }
}

module.exports = Encoding
