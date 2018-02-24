const qtuminfo = require('qtuminfo-lib')
const {ErrorResponse} = require('../components/utils')
const Address = qtuminfo.Address

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
      try {
        this.validateAddress(id)
      } catch (err) {
        return
      }
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
    } else if (id.length === 42) {
      if (SegwitAddress.decode(Networks.get(this._network).witness_v0_keyhash, id)) {
        ctx.body = {type: 'address'}
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
    } else if (id.length === 62) {
      if (SegwitAddress.decode(Networks.get(this._network).witness_v0_scripthash, id)) {
        ctx.body = {type: 'address'}
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
    let from = Number.parseInt(ctx.query.from) || 0
    let to = Number.parseInt(ctx.query.to) || from + 10
    ctx.body = await this._address.getRichList({from, to})
  }

  validateAddress(address) {
    try {
      new Address(address, this._network, 'scripthash')
    } catch (err) {
      new Address(address, this._network, 'pubkeyhash')
    }
  }
}

module.exports = MiscController
