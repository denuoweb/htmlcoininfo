const mongoose = require('mongoose')
const {Schema} = mongoose

const contractSchema = new Schema({
  address: {type: String, index: true, unique: true},
  owner: {type: String, index: true},
  createTransactionId: String,
  createHeight: {type: Number, index: true},
  type: {type: String, index: true},
  qrc20: {
    name: {type: String, text: true},
    symbol: {type: String, text: true},
    decimals: Number,
    totalSupply: String
  }
})

module.exports = mongoose.model('Contract', contractSchema)
