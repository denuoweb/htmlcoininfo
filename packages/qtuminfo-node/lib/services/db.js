const assert = require('assert')
const mongoose = require('mongoose')
const BaseService = require('../service')
const {QTUM_GENESIS_HASH} = require('../constants')
const Info = require('../models/info')

mongoose.Promise = Promise

class DB extends BaseService {
  constructor(options = {}) {
    super(options)
    this._network = this.node.network
    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
    this.GENESIS_HASH = QTUM_GENESIS_HASH[this._network]
    this.subscriptions = {}

    this.node.on(
      'stopping',
      () => this.node.log.warn(
        'Node is stopping, gently closing the database. Please wait, this could take a while'
      )
    )
  }

  get APIMethods() {
    return [
      ['getServiceTip', this.getServiceTip.bind(this), 1]
    ]
  }

  async getServiceTip(serviceName) {
    let tip = await Info.findOne({key: 'tip-' + serviceName}).exec()
    if (tip) {
      return tip.value
    } else {
      return {height: 0, hash: this.GENESIS_HASH}
    }
  }

  async updateServiceTip(serviceName, tip) {
    await Info.findOneAndUpdate({key: 'tip-' + serviceName}, {value: tip}, {upsert: true})
  }

  async start() {
    this._connection = await mongoose.connect(
      'mongodb://localhost/' + {mainnet: 'qtuminfo', testnet: 'qtuminfo-testnet'}[this._network]
    )
  }

  async stop() {
    if (this._stopping) {
      return
    }
    this._stopping = true
    await mongoose.disconnect()
  }
}

module.exports = DB
