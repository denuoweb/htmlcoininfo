const mongoose = require('mongoose')
const {Schema} = mongoose

const snapshotSchema = new Schema({
  contract: {type: String, index: true, default: '0'.repeat(40)},
  address: {type: String, index: true},
  balance: String,
  index: {type: Number, index: true}
})

module.exports = mongoose.model('Snapshot', snapshotSchema)
