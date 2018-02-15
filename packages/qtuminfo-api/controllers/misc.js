const {ErrorResponse} = require('../components/utils')

class MiscController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._address = this.node.services.get('address')
    this._header = this.node.services.get('header')
    this._block = this.node.services.get('block')
    this._contract = this.node.services.get('contract')
    this._transaction = this.node.services.get('transaction')
  }

  async info(ctx) {
    ctx.body = {
      height: this._block.getTip().height
    }
  }

  async classify(ctx) {
    let id = ctx.params.id
    if (/^(0|[1-9]\d{0,9})$/.test(id)) {
      id = Number.parseInt(id)
      if (id <= this._header.getBestHeight()) {
        ctx.body = {type: 'block-height'}
        return
      }
    } else if (id.length === 34) {
      let {totalCount} = await this._address.getAddressHistory(id)
      if (totalCount > 0) {
        ctx.body = {type: 'address'}
        return
      }
    } else if (id.length === 40) {
      if (await this._contract.getContract(id)) {
        ctx.body = {type: 'contract'}
        return
      }
    } else if (id.length === 64) {
      if (await this._header.getBlockHeader(id)) {
        ctx.body = {type: 'block-hash'}
        return
      } else if (await this._transaction.getTransaction(id)) {
        ctx.body = {type: 'transaction'}
        return
      }
    }
    let token = await this._contract.searchQRC20Token(id)
    if (token) {
      ctx.body = {type: 'contract', id: token.address}
      return
    }
    ctx.throw(404)
  }

  async richList(ctx) {
    ctx.body = await this._address.getRichList()
  }
}

module.exports = MiscController
