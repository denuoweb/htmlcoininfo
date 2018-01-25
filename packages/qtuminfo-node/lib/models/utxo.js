const mongoose = require('mongoose')
const qtuminfo = require('qtuminfo-lib')
const {Schema} = mongoose
const {sha256ripemd160} = qtuminfo.crypto.Hash

const utxoSchema = new Schema({
  satoshis: {type: Number, default: 0},
  output: {
    height: {type: Number, default: 0xffffffff, index: true},
    transactionId: {type: String, default: '0'.repeat(64), index: true},
    index: {type: Number, default: 0xffffffff, index: true},
    script: [{opcode: Number, buffer: Buffer}]
  },
  input: {
    height: {type: Number, index: true},
    transactionId: {type: String, index: true},
    index: {type: Number, index: true},
    script: [{opcode: Number, buffer: Buffer}],
    sequence: Number
  },
  address: {type: String, index: true},
  isStake: Boolean
})

exports = module.exports = mongoose.model('Utxo', utxoSchema)

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
    return sha256ripemd160(
      Buffer.concat([Buffer.from(tx.id, 'hex').reverse(), indexBuffer])
    ).toString('hex')
  } else if (script.isContractCall()) {
    return script.chunks[4].buf.toString('hex')
  } else {
    let address = script.toAddress()
    return address && address.toString()
  }
}
