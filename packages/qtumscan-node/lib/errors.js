const createError = require('errno').create
const QtumscanNodeError = createError('QtumscanNodeError')
const RPCError = createError('RPCError', QtumscanNodeError)

exports.Error = QtumscanNodeError
exports.RPCError = RPCError
