const BaseService = require('../service')

class FeeService extends BaseService {
  constructor(options) {
    super(options)
    this._db = this.node.services.get('db')
    this._client = this._db.getRpcClient()
  }

  static get dependencies() {
    return ['db']
  }

  get APIMethods() {
    return [
      ['estimateFee', this, this.estimateFee, 1]
    ]
  }

  estimateFee(blocks) {
    return this._client.estimateFee(blocks || 4)
  }
}

module.exports = FeeService
