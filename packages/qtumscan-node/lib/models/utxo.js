const mongoose = require('mongoose')
const qtumscan = require('qtumscan-lib')
const {Schema} = mongoose

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
  createHeight: {type: Number, index: true},
  useHeight: {type: Number, index: true}
})

utxoSchema.methods.toRawScript = script => new qtumscan.Script({
  chunks: script.map(chunk => ({
    buf: chunk.buffer && Buffer.from(chunk.buffer, 'hex'),
    opcodenum: chunk.opcode
  }))
})

module.exports = mongoose.model('Utxo', utxoSchema)
