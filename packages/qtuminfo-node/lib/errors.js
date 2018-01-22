const createError = require('errno').create
const QtuminfoNodeError = createError('QtuminfoNodeError')
const RPCError = createError('RPCError', QtuminfoNodeError)

exports.Error = QtuminfoNodeError
exports.RPCError = RPCError
