const Block = require('qtuminfo-node/lib/models/block')
const {ErrorResponse} = require('../components/utils')

class StatsController {
  constructor(node) {
    this.node = node
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._network = this.node.network
    if (this.node.network === 'livenet') {
      this._network = 'mainnet'
    } else if (this.node.network === 'regtest') {
      this._network = 'testnet'
    }
  }

  async dailyTransactions(ctx) {
    try {
      let list = await Block.aggregate([
        {
          $group: {
            _id: {
              $floor: {$divide: ['$timestamp', 86400]}
            },
            count: {$sum: {$size: '$transactions'}}
          }
        },
        {$project: {_id: false, timestamp: '$_id', count: '$count'}},
        {$sort: {timestamp: 1}}
      ])
      let result = []
      for (let {timestamp, count} of list) {
        let time = new Date(timestamp * 86400 * 1000)
        let year = time.getUTCFullYear()
        let month = time.getUTCMonth() + 1
        let date = time.getUTCDate()
        if (month < 10) {
          month = '0' + month
        }
        if (date < 10) {
          date = '0' + date
        }
        result.push({date: `${year}-${month}-${date}`, time, transactions: count})
      }
      ctx.body = result
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }
}

module.exports = StatsController
