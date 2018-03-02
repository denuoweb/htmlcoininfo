const qtuminfo = require('qtuminfo-lib')
const {ErrorResponse} = require('../components/utils')
const {Address, Networks} = qtuminfo
const {SegwitAddress} = qtuminfo.encoding

class MiscController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._address = this.node.services.get('address')
    this._header = this.node.services.get('header')
    this._block = this.node.services.get('block')
    this._contract = this.node.services.get('contract')
    this._transaction = this.node.services.get('transaction')
    this._network = this.node.network
    if (this.node.network === 'livenet') {
      this._network = 'mainnet'
    } else if (this.node.network === 'regtest') {
      this._network = 'testnet'
    }
  }

  async search(ctx) {
    ctx.body = null
  }
}

module.exports = MiscController
