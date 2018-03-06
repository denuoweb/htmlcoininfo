const mongoose = require('mongoose')
const {Schema} = mongoose

const addressSchema = new Schema({
  type: {type: String, index: true},
  hex: {type: String, index: true}
}, {_id: false})

module.exports = addressSchema
