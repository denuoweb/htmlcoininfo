const BN = require('bn.js')
const qtuminfo = require('qtuminfo-lib')
const BaseService = require('../service')
const Transaction = require('../models/transaction')
const Utxo = require('../models/utxo')
const {toRawScript} = require('../utils')
const {Base58Check} = qtuminfo.encoding
const {Contract, tokenABI} = qtuminfo.contract
const Address = qtuminfo.Address

const tokenAbi = new Contract(tokenABI)
const TOKEN_EVENTS = {
  Transfer: tokenAbi.eventSignature('Transfer').slice(2),
  Approval: tokenAbi.eventSignature('Approval').slice(2),
  Mint: tokenAbi.eventSignature('Mint').slice(2),
  Burn: tokenAbi.eventSignature('Burn').slice(2),
  TokenPurchase: tokenAbi.eventSignature('TokenPurchase').slice(2)
}

class AddressService extends BaseService {
  constructor(options) {
    super(options)
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._transaction = this.node.services.get('transaction')
    this._network = this.node.network
    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
  }

  static get dependencies() {
    return ['block', 'db', 'transaction']
  }

  async getAddressHistory(addresses, {from = 0, to = 0xffffffff} = {}) {
    if (typeof addresses === 'string') {
      addresses = [addresses]
    }
    let list = await this._getAddressTxidHistory(addresses)
    return {
      totalCount: list.length,
      transactions: list.slice(from, to)
    }
  }

  async getAddressSummary(address, options = {}) {
    let {totalCount, transactions} = options.noTxList ? {} : await this.getAddressHistory(address, options)
    let utxos = await this.getAddressUnspentOutputs(address, {listUsed: true})
    let balance = new BN(0)
    let totalReceived = new BN(0)
    let totalSent = new BN(0)
    let unconfirmedBalance = new BN(0)
    let stakingBalance = new BN(0)
    for (let utxo of utxos) {
      let value = new BN(utxo.satoshis)
      totalReceived.iadd(value)
      if (utxo.outputTxId) {
        totalSent.iadd(value)
      } else {
        balance.iadd(value)
        if (utxo.confirmations === 0) {
          unconfirmedBalance.iadd(value)
        }
      }
      if (utxo.staking) {
        stakingBalance.iadd(value)
      }
    }
    return {
      address,
      totalCount,
      transactions,
      balance: balance.toString(),
      totalReceived: totalReceived.toString(),
      totalSent: totalSent.toString(),
      unconfirmedBalance: unconfirmedBalance.toString(),
      stakingBalance: stakingBalance.toString()
    }
  }

  async getAddressUnspentOutputs(address, {listUsed = false} = {}) {
    let utxoList = await Utxo.aggregate([
      {$match: {address, ...(listUsed ? {} : {'input.height': null})}},
      {
        $lookup: {
          from: 'transactions',
          localField: 'output.transactionId',
          foreignField: 'id',
          as: 'transaction'
        }
      },
      {
        $project: {
          satoshis: '$satoshis',
          outputTxId: '$output.transactionId',
          outputIndex: '$output.index',
          outputScript: '$output.script',
          inputTxId: '$input.transactionId',
          inputScript: '$input.script',
          height: '$output.height',
          index: '$transaction.0.index',
          isStake: '$transaction.0.isStake'
        }
      },
      {$sort: {height: 1, index: 1, outputIndex: 1}}
    ]).allowDiskUse(true)
    let results = []
    for (let utxo of utxoList) {
      let confirmations = Math.max(this._block.getTip().height - utxo.height + 1, 0)
      results.push({
        txid: utxo.outputTxId,
        vout: utxo.outputIndex,
        satoshis: utxo.satoshis,
        height: utxo.height,
        outputTxId: utxo.inputTxId === '0'.repeat(64) ? null : utxo.inputTxId,
        scriptPubKey: toRawScript(utxo.outputScript).toBuffer().toString('hex'),
        scriptSig: toRawScript(utxo.inputScript).toBuffer().toString('hex'),
        confirmations,
        staking: utxo.isStake && confirmations < 500
      })
    }
    return results
  }

  get APIMethods() {
    return [
      ['getAddressHistory', this.getAddressHistory.bind(this), 2],
      ['getAddressSummary', this.getAddressSummary.bind(this), 1],
      ['getAddressUnspentOutputs', this.getAddressUnspentOutputs.bind(this), 1],
      ['snapshot', this.snapshot.bind(this), 2]
    ]
  }

  async _getAddressTxidHistory(addresses) {
    let hexAddresses = addresses.map(
      address => '0'.repeat(24) + Base58Check.decode(address).slice(1).toString('hex')
    )
    let list = await Transaction.aggregate([
      {
        $match: {
          $or: [
            {addresses: {$in: addresses}},
            {
              'receipts.logs.topics.0': {
                $in: [TOKEN_EVENTS.Transfer, TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn]
              },
              'receipts.logs.topics': {$in: hexAddresses},
            }
          ]
        }
      },
      {$sort: {'block.height': -1, index: -1}},
      {$project: {id: true}}
    ])
    return list.map(tx => tx.id)
  }

  snapshot(height, minBalance = 0) {
    if (!height) {
      height = this._block.getTip().height + 1
    }
    return Utxo.aggregate([
      {
        $match: {
          satoshis: {$ne: 0},
          address: {$ne: null},
          'output.height': {$lte: height},
          $or: [
            {'input.height': null},
            {'input.height': {$gt: height}}
          ]
        }
      },
      {
        $group: {
          _id: '$address',
          balance: {$sum: '$satoshis'}
        }
      },
      {$match: {balance: {$gte: minBalance}}},
      {$sort: {balance: -1}},
      {$project: {_id: false, address: '$_id', balance: '$balance'}}
    ])
  }
}

module.exports = AddressService
