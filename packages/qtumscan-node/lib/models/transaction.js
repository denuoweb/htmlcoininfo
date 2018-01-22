const mongoose = require('mongoose')
const {Schema} = mongoose

const transactionSchema = new Schema({
  id: {type: String, index: true, unique: true},
  hash: {type: String, index: true, unique: true},
  version: Number,
  dummy: Number,
  flags: Number,
  inputs: [Schema.Types.ObjectId],
  outputs: [Schema.Types.ObjectId],
  witnessStack: [[String]],
  nLockTime: Number,
  block: {
    hash: {type: String, default: '0'.repeat(64)},
    height: {type: Number, default: 0xffffffff}
  },
  index: Number,
  isStake: {type: Boolean, default: false},
  receipts: [{
    gasUsed: Number,
    contractAddress: {type: String, index: true},
    logs: [{
      address: {type: String, index: true},
      topics: [{type: String, index: true}],
      data: String
    }]
  }]
})

transactionSchema.methods.isCoinbase = async function() {
  if (this.inputs.length === 1) {
    let Utxo = this.model('Utxo')
    let utxo = await Utxo.findById(this.inputs[0])
    return utxo.output.transactionId === '0'.repeat(64) && utxo.output.index === 0xffffffff
  } else {
    return false
  }
}

module.exports = mongoose.model('Transaction', transactionSchema)
