const mongoose = require('mongoose')
const qtuminfo = require('qtuminfo-lib')
const addressSchema = require('./address')
const {Schema} = mongoose
const {sha256ripemd160} = qtuminfo.crypto.Hash

const scriptSchema = new Schema({opcode: Number, buffer: Buffer}, {_id: false})

const outputSchema = new Schema({
  height: {type: Number, default: 0xffffffff, index: true},
  transactionId: {type: String, default: '0'.repeat(64), index: true},
  index: {type: Number, default: 0xffffffff, index: true},
  script: [scriptSchema]
}, {_id: false})

const inputSchema = new Schema({
  height: {type: Number, index: true},
  transactionId: {type: String, index: true},
  index: {type: Number, index: true},
  script: [scriptSchema],
  sequence: Number
}, {_id: false})

const transactionOutputSchema = new Schema({
  satoshis: {type: Number, default: 0},
  output: outputSchema,
  input: inputSchema,
  address: addressSchema,
  isStake: Boolean
})

exports = module.exports = mongoose.model('TransactionOutput', transactionOutputSchema)

exports.transformScript = function(script) {
  return script.chunks.map(chunk => ({
    opcode: chunk.opcodenum,
    buffer: chunk.buf
  }))
}

exports.getAddress = function(tx, index) {
  let script = tx.outputs[index].script
  if (script.isContractCreate()) {
    let indexBuffer = Buffer.alloc(4)
    indexBuffer.writeUInt32LE(index)
    return {
      type: 'contract',
      hex: sha256ripemd160(
        Buffer.concat([Buffer.from(tx.id, 'hex').reverse(), indexBuffer])
      ).toString('hex')
    }
  } else if (script.isContractCall()) {
    return {
      type: 'contract',
      hex: script.chunks[4].buf.toString('hex')
    }
  } else {
    let info = script.getAddressInfo()
    if (info) {
      return {type: info.type, hex: info.hashBuffer.toString('hex')}
    }
  }
}
