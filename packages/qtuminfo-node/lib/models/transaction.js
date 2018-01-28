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
  witnessStack: [[Buffer]],
  nLockTime: Number,
  block: {
    hash: {type: String, default: '0'.repeat(64)},
    height: {type: Number, default: 0xffffffff, index: true}
  },
  index: Number,
  addresses: [{type: String, index: true}],
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

module.exports = mongoose.model('Transaction', transactionSchema)
