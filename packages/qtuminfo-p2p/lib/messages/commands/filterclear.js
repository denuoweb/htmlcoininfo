const Message = require('../message')

class FilterclearMessage extends Message {
  constructor(arg, options) {
    super('filteraclear', options)
  }
}

module.exports = FilterclearMessage
