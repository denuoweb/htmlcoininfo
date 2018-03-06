const mongoose = require('mongoose')
const addressSchema = require('./address')
const {Schema} = mongoose

const snapshotSchema = new Schema({
  address: addressSchema,
  balance: {type: Number, index: true}
})

module.exports = mongoose.model('Snapshot', snapshotSchema)
