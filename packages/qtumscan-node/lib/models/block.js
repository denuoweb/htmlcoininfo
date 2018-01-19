const mongoose = require('mongoose')
const qtumscan = require('qtumscan-lib')
const {Schema} = mongoose

const blockSchema = new Schema({
  hash: {type: String, index: true, unique: true},
  height: {type: Number, index: true, unique: true},
  version: Number,
  prevHash: {type: String, default: '0'.repeat(64)},
  merkleRoot: String,
  timestamp: {type: Number, index: true},
  bits: Number,
  nonce: Number,
  hashStateRoot: String,
  hashUTXORoot: String,
  prevOutStakeHash: {type: String, default: '0'.repeat(64)},
  prevOutStakeN: Number,
  vchBlockSig: String,
  chainwork: String,
  transactions: [String]
})

blockSchema.methods.toRawBlock = async function() {
  let Transaction = this.model('Transaction')
  let transactions = await Promise.all(this.transactions.map(async id => {
    let transaction = await Transaction.findOne({id})
    return transaction.toRawTransaction()
  }))
  return new qtumscan.Block({
    header: {
      hash: this.hash,
      version: this.version,
      prevHash: this.prevHash,
      merkleRoot: this.merkleRoot,
      timestamp: this.timestamp,
      bits: this.bits,
      nonce: this.nonce,
      hashStateRoot: this.hashStateRoot,
      hashUTXORoot: this.hashUTXORoot,
      prevOutStakeHash: this.prevOutStakeHash,
      prevOutStakeN: this.prevOutStakeN,
      vchBlockSig: this.vchBlockSig
    },
    transactions
  })
}

module.exports = mongoose.model('Block', blockSchema)
