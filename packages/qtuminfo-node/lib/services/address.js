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
      {$unwind: '$transaction'},
      {$sort: {'output.height': 1, 'transaction.index': 1, 'output.index': 1}},
      {
        $project: {
          satoshis: '$satoshis',
          outputTxId: '$output.transactionId',
          outputIndex: '$output.index',
          outputScript: '$output.script',
          inputTxId: '$input.transactionId',
          inputScript: '$input.script',
          height: '$output.height',
          index: '$transaction.index',
          isStake: '$transaction.isStake'
        }
      }
    ])
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
    let utxoList = await Utxo.aggregate([
      {$match: {address: {$in: addresses}}},
      {$project: {id: ['$output.transactionId', '$input.transactionId']}},
      {$unwind: '$id'},
      {$match: {id: {$ne: '0'.repeat(64)}}},
      {$group: {_id: '$id'}},
      {
        $lookup: {
          from: 'transactions',
          localField: '_id',
          foreignField: 'id',
          as: 'transaction'
        }
      },
      {$unwind: '$transaction'},
      {
        $project: {
          txid: '$_id',
          height: '$transaction.block.height',
          txIndex: '$transaction.index'
        }
      },
      {$sort: {height: -1, txIndex: -1}}
    ])
    let contractList = await Transaction.aggregate([
      {
        $match: {
          $or: [
            {
              'receipts.logs.topics.0': TOKEN_EVENTS.Transfer,
              $or: [
                {'receipts.logs.topics.1': {$in: hexAddresses}},
                {'receipts.logs.topics.2': {$in: hexAddresses}}
              ]
            },
            {
              'receipts.logs.topics.0': TOKEN_EVENTS.Mint,
              'receipts.logs.topics.1': {$in: hexAddresses}
            },
            {
              'receipts.logs.topics.0': TOKEN_EVENTS.Burn,
              'receipts.logs.topics.1': {$in: hexAddresses}
            }
          ]
        }
      },
      {
        $project: {
          txid: '$id',
          height: '$block.height',
          txIndex: '$index'
        }
      },
      {$sort: {height: -1, txIndex: -1}}
    ])
    let i = 0, j = 0
    let last = {height: 0xffffffff, txIndex: 0xffffffff}
    let results = []
    function compare(x, y) {
      if (x.height !== y.height) {
        return x.height - y.height
      } else {
        return x.txIndex - y.txIndex
      }
    }
    while (i < utxoList.length && j < contractList.length) {
      let item
      let comparison = compare(utxoList[i], contractList[j])
      if (comparison > 0) {
        item = utxoList[i++]
      } else if (comparison < 0) {
        item = contractList[j++]
      } else {
        item = utxoList[i++]
        ++j
      }
      if (compare(item, last) < 0) {
        last = item
        results.push(item.txid)
      }
    }
    while (i < utxoList.length) {
      if (compare(utxoList[i], last) < 0) {
        last = utxoList[i]
        results.push(utxoList[i].txid)
      }
      ++i
    }
    while (j < contractList.length) {
      if (compare(contractList[j], last) < 0) {
        last = contractList[j]
        results.push(contractList[j].txid)
      }
      ++j
    }
    return results
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
