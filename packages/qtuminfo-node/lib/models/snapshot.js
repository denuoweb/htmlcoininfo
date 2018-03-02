const mongoose = require('mongoose')
const {Schema} = mongoose

const snapshotSchema = new Schema({
  address: {type: String, index: true, unique: true},
  balance: Number
})

module.exports = mongoose.model('Snapshot', snapshotSchema)
