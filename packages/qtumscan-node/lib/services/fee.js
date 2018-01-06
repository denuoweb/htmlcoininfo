const QtumscanRPC = require('qtumscan-rpc')
const BaseService = require('../service')

class FeeService extends BaseService {
  constructor(options) {
    super(options)
    this._config = options.rpc || {
      user: 'qtum',
      pass: 'qtumpassword',
      host: 'localhost',
      protocol: 'http',
      port: ['testnet', 'regtest'].includes(this.node.network) ? 13889 : 3889
    }
    this._client = new QtumscanRPC(this._config)
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
