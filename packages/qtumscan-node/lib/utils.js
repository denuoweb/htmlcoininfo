const {DB_PREFIX} = require('./constants')

exports.parseParamsWithJSON = function(paramsArg) {
  return paramsArg.map(paramArg => {
    try {
      return JSON.parse(paramArg)
    } catch (err) {
      return paramArg
    }
  })
}

exports.encodeTip = function(tip, name) {
  let key = Buffer.concat([DB_PREFIX, Buffer.from('tip-' + name)])
  let heightBuffer = Buffer.alloc(4)
  heightBuffer.writeUInt32BE(tip.height)
  let value = Buffer.concat([heightBuffer, Buffer.from(tip.hash)])
  return {key, value}
}

class AsyncQueue {
  constructor(fn) {
    this._fn = fn
    this._waiting = []
    this._running = false
  }

  get length() {
    return this._waiting.length
  }

  get running() {
    return this._running
  }

  push(data, callback) {
    this._waiting.push({data, callback})
    if (!this._running) {
      this._process()
    }
  }

  _process() {
    this._running = true
    let {data, callback} = this._waiting.pop()
    this._fn(data).then(data => {
      callback(null, data)
      if (this._waiting.length) {
        this._process()
      } else {
        this._running = false
      }
    }, callback)
  }
}
exports.AsyncQueue = AsyncQueue
