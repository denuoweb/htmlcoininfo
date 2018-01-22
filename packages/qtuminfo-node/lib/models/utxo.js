const mongoose = require('mongoose')
const qtuminfo = require('qtuminfo-lib')
const utils = require('../utils')
const {Schema} = mongoose
const {sha256ripemd160} = qtuminfo.crypto.Hash

const utxoSchema = new Schema({
  satoshis: {type: Number, default: 0},
  output: {
    transactionId: {type: String, default: '0'.repeat(64), index: true},
    index: {type: Number, default: 0xffffffff, index: true},
    script: [{opcode: Number, buffer: String}]
  },
  input: {
    transactionId: {type: String, default: '0'.repeat(64), index: true},
    index: {type: Number, index: true},
    script: [{opcode: Number, buffer: String}],
    sequence: Number
  },
  address: {type: String, index: true},
  createHeight: {type: Number, default: 0xffffffff, index: true},
  useHeight: {type: Number, index: true}
})

exports = module.exports = mongoose.model('Utxo', utxoSchema)

exports.transformScript = function(script) {
  return script.chunks.map(chunk => ({
    opcode: chunk.opcodenum,
    buffer: chunk.buf && chunk.buf.toString('hex')
  }))
}

exports.getAddress = function(tx, index) {
  let script = tx.outputs[index].script
  if (script.isContractCreate()) {
    let indexBuffer = Buffer.alloc(4)
    indexBuffer.writeUInt32LE(index)
    return sha256ripemd160(
      Buffer.concat([Buffer.from(utils.revHex(tx.hash), 'hex'), indexBuffer])
    ).toString('hex')
  } else if (script.isContractCall()) {
    return script.chunks[4].buf.toString('hex')
  } else {
    let address = script.toAddress()
    return address && address.toString()
  }
}
