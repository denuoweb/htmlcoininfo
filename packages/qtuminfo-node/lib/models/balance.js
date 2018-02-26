const mongoose = require('mongoose')
const {Schema} = mongoose

const balanceSchema = new Schema({
  contract: {type: String, index: true},
  address: {type: String, index: true},
  balance: String
})

module.exports = mongoose.model('Balance', balanceSchema)
