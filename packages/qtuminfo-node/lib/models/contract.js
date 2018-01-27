const mongoose = require('mongoose')
const {Schema} = mongoose

const contractSchema = new Schema({
  address: {type: String, index: true, unique: true},
  owner: {type: String, index: true},
  createTransactionId: String,
  createHeight: {type: Number, index: true},
  type: {type: String, index: true},
  qrc20: {
    name: String,
    symbol: String,
    decimals: Number,
    totalSupply: String,
    version: String
  }
})

contractSchema.index({'qrc20.name': 'text', 'qrc20.symbol': 'text'})
module.exports = mongoose.model('Contract', contractSchema)
