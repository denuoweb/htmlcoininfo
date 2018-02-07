const {ErrorResponse} = require('../components/utils')

class AddressController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._address = this.node.services.get('address')
    this._block = this.node.services.get('block')
    this._contract = this.node.services.get('contract')
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
      ctx.address = ctx.params.address
      ctx.addresses = [ctx.address]
    } else {
      ctx.addresses = makeArray(ctx.params.addresses) || []
      if (ctx.addresses.length === 0) {
        this.errorResponse.handleErrors(ctx, {
          message: 'Must include address',
          code: 1
        })
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
}

module.exports = AddressController
