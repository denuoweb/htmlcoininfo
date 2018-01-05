const {ErrorResponse} = require('../components/utils')

class AddressController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._address = this.node.services.get('address')
    this._block = this.node.services.get('block')
  }

  async show(ctx) {
    let options = {noTxList: Number.parseInt(ctx.query.noTxList)}
    if (ctx.query.from && ctx.query.to) {
      options.from = Number.parseInt(ctx.query.from)
      options.to = Number.parseInt(ctx.query.to)
    }
    try {
      ctx.body = await this._address.getAddressSummary(ctx.address, options)
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
    return {
      address,
      balance: summary.balance,
      totalReceived: summary.totalReceived,
      totalSent: summary.totalSent,
      unconfirmedBalance: summary.unconfirmedBalance,
      stakingBalance: summary.stakingBalance,
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
      let utxos = await this._address.getAddressUnspentOutputs(ctx.address)
      ctx.body = utxos.map(this.transformUtxo.bind(this))
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  transformUtxo(utxoArg) {
    let utxo = {
      address: utxoArg.address,
      txid: utxoArg.txid,
      vout: utxoArg.vout,
      scriptPubKey: utxoArg.scriptPubKey,
      satoshis: utxoArg.satoshis
    }
    if (utxoArg.height) {
      utxo.height = utxoArg.height
      utxo.confirmations = this._block.getTip().height - utxoArg.height + 1
    } else {
      utxo.confirmations = 0
    }
    if (utxoArg.timestamp) {
      utxo.timestamp = utxoArg.timestamp
    }
    return utxo
  }

  async multiutxo(ctx) {
    let addresses = []
    for (let address of ctx.addresses) {
      if (!addresses.includes(address)) {
        addresses.push(address)
      }
    }
    try {
      let result = []
      await Promise.all(addresses.map(async address => {
        let utxos = await this._address.getAddressUnspentOutputs(address)
        result.push(...utxos.map(this.transformUtxo.bind(this)))
      }))
      ctx.body = result
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
