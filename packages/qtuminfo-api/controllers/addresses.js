const qtuminfo = require('qtuminfo-lib')
const {ErrorResponse} = require('../components/utils')
const {Address, Networks} = qtuminfo
const {SegwitAddress} = qtuminfo.encoding

class AddressController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._address = this.node.services.get('address')
    this._block = this.node.services.get('block')
    this._contract = this.node.services.get('contract')
    this._network = this.node.network
    if (this.node.network === 'livenet') {
      this._network = 'mainnet'
    } else if (this.node.network === 'regtest') {
      this._network = 'testnet'
    }
  }

  async show(ctx) {
    let options = {noTxList: Number.parseInt(ctx.query.noTxList)}
    if (ctx.query.from && ctx.query.to) {
      options.from = Number.parseInt(ctx.query.from)
      options.to = Number.parseInt(ctx.query.to)
    }
    try {
      ctx.body = await this.getAddressSummary(ctx.address, options)
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async balance(ctx) {
    await addressSummarySubQuery(ctx, 'balance')
  }

  async totalReceived(ctx) {
    await addressSummarySubQuery(ctx, 'totalReceived')
  }

  async totalSent(ctx) {
    await addressSummarySubQuery(ctx, 'totalSent')
  }

  async unconfirmedBalance(ctx) {
    await addressSummarySubQuery(ctx, 'unconfirmedBalance')
  }

  async addressSummarySubQuery(ctx, param) {
    try {
      let data = await this.getAddressSummary(ctx.address)
      ctx.body = data[param]
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async getAddressSummary(address, options) {
    let summary = await this._address.getAddressSummary(address, options)
    let tokenBalances = await this._contract.getAllQRC20TokenBalances(address)
    return {
      address,
      balance: summary.balance,
      totalReceived: summary.totalReceived,
      totalSent: summary.totalSent,
      unconfirmedBalance: summary.unconfirmedBalance,
      stakingBalance: summary.stakingBalance,
      tokenBalances: tokenBalances.map(token => ({
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        totalSupply: token.totalSupply,
        balance: token.balance
      })),
      totalCount: summary.totalCount,
      transactions: summary.transactions
    }
  }

  async checkAddresses(ctx, next) {
    const makeArray = addrs => typeof addrs === 'string' ? addrs.split(',') : addrs
    if (ctx.params.address) {
      this.validateAddress(ctx.params.address)
      ctx.address = ctx.params.address
      ctx.addresses = [ctx.address]
    } else {
      ctx.addresses = makeArray(ctx.params.addresses) || []
      if (ctx.addresses.length === 0) {
        this.errorResponse.handleErrors(ctx, {
          message: 'Must include address',
          code: 1
        })
      } else {
        for (let address of ctx.addresses) {
          this.validateAddress(address)
        }
      }
      ctx.address = ctx.addresses[0]
    }
    await next()
  }

  async utxo(ctx) {
    try {
      ctx.body = await this._address.getAddressUnspentOutputs(ctx.address)
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async multiutxo(ctx) {
    let addresses = [...new Set(ctx.addresses)]
    try {
      ctx.body = await this._address.getAddressUnspentOutputs(addresses)
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async multitxs(ctx) {
    let from = Number.parseInt(ctx.query.from) || 0
    let to = Number.parseInt(ctx.query.to) || from + 10
    try {
      let result = await this._address.getAddressHistory(ctx.addresses, {from, to})
      ctx.body = {
        totalCount: result.totalCount,
        from,
        to: Math.min(to, result.totalCount),
        transactions: result.transactions
      }
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  validateAddress(address) {
    if (address.length === 34) {
      try {
        new Address(address, this._network, 'scripthash')
      } catch (err) {
        new Address(address, this._network, 'pubkeyhash')
      }
    } else if (address.length === 42) {
      if (!SegwitAddress.decode(Networks.get(this._network).witness_v0_keyhash, address)) {
        throw new Error()
      }
    } else if (address.length === 62) {
      if (!SegwitAddress.decode(Networks.get(this._network).witness_v0_scripthash, address)) {
        throw new Error()
      }
    } else {
      throw new Error()
    }
  }
}

module.exports = AddressController
