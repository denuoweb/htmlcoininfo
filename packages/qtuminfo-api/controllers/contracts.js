const {Block} = require('qtuminfo-lib')
const {ErrorResponse} = require('../components/utils')

class ContractsController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._block = this.node.services.get('block')
    this._contract = this.node.services.get('contract')
    this._transaction = this.node.services.get('transaction')
  }

  async contract(ctx, next) {
    let address = ctx.params.contract
    try {
      let contract = await this._contract.getContract(address)
      if (!contract) {
        ctx.throw(404)
      }
      ctx.contract = contract
      await next()
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async show(ctx) {
    try {
      let summary = await this._contract.getContractSummary(ctx.contract.address)
      let tokenBalances = await this._contract.getAllQRC20TokenBalances(ctx.contract.address)
      summary.owner = ctx.contract.owner
      summary.txid = ctx.contract.createTransactionId
      summary.type = ctx.contract.type
      if (ctx.contract.type === 'qrc20') {
        summary.qrc20 = ctx.contract.qrc20
      }
      summary.tokenBalances = tokenBalances.map(token => ({
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        totalSupply: token.totalSupply,
        balance: token.balance
      }))
      ctx.body = summary
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async txs(ctx) {
    let from = Number.parseInt(ctx.query.from) || 0
    let to = Number.parseInt(ctx.query.to) || from + 10
    try {
      let result = await this._contract.getContractHistory(ctx.contract.address, {from, to})
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

module.exports = ContractsController
