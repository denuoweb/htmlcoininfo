const BN = require('bn.js')
const qtumscan = require('qtumscan-lib')
const BaseService = require('../service')
const Transaction = require('../models/transaction')
const Utxo = require('../models/utxo')
const {Base58Check} = qtumscan.encoding
const {Contract, tokenABI} = qtumscan.contract
const Address = qtumscan.Address

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
    let txidMap = new Map()
    for (let utxo of utxos) {
      let value = new BN(utxo.satoshis)
      let inputItem
      if (txidMap.has(utxo.txid)) {
        inputItem = txidMap.get(utxo.txid)
        inputItem.received += utxo.satoshis
      } else {
        inputItem = {received: utxo.satoshis, sent: 0}
        txidMap.set(utxo.txid, inputItem)
      }
      if (utxo.outputTxId) {
        let outputItem
        if (txidMap.has(utxo.outputTxId)) {
          outputItem = txidMap.get(utxo.outputTxId)
          outputItem.sent += utxo.satoshis
        } else {
          outputItem = {received: 0, sent: utxo.satoshis}
          txidMap.set(utxo.outputTxId, outputItem)
        }
      } else {
        balance.iadd(value)
        if (utxo.confirmations === 0) {
          unconfirmedBalance.iadd(new BN(value))
        }
      }
      if (utxo.staking) {
        stakingBalance.iadd(new BN(value))
      }
    }
    for (let {received, sent} of txidMap.values()) {
      if (received > sent) {
        totalReceived.iadd(new BN(received - sent))
      } else {
        totalSent.iadd(new BN(sent - received))
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
    let utxoList = await Utxo.aggregate(
      {$match: {address, ...(listUsed ? {} : {useHeight: null})}},
      {
        $project: {
          satoshis: '$satoshis',
          output: {
            transactionId: '$output.transactionId',
            index: '$output.index'
          },
          input: {transactionId: '$input.transactionId'},
          createHeight: '$createHeight'
        }
      },
      {$sort: {createHeight: -1}},
      {
        $lookup: {
          from: 'Transaction',
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
          inputTxId: '$input.transactionId',
          height: '$createHeight',
          isStake: '$transaction.isStake'
        }
      }
    )
    let results = []
    for (let utxo of utxoList) {
      let confirmations = Math.max(this._block.getTip().height - utxo.height + 1, 0)
      results.push({
        txid: utxo.outputTxId,
        vout: utxo.outputIndex,
        satoshis: utxo.satoshis,
        height: utxo.height,
        outputTxId: utxo.inputTxId === '0'.repeat(64) ? null : utxo.inputTxId,
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
    let utxoList = await Utxo.find(
      {address: {$in: addresses}},
      ['output.transactionId', 'input.transactionId', 'createHeight', 'useHeight']
    )
    let contractList = await Transaction.find(
      {
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
      },
      ['id', 'block.height']
    )
    let results = new Set()
    for (let utxo of utxoList) {
      results.add(utxo.output.transactionId + ' ' + utxo.createHeight)
      if (utxo.useHeight != null) {
        results.add(utxo.input.transactionId + ' ' + utxo.useHeight)
      }
    }
    for (let tx of contractList) {
      results.add(tx.id + ' ' + tx.block.height)
    }
    return [...results].map(s => {
      let [txid, height] = s.split(' ')
      height = Number.parseInt(height)
      return {txid, height}
    }).sort((x, y) => y.height - x.height).map(tx => tx.txid)
  }

  snapshot(height, minBalance = 0) {
    if (!height) {
      height = this._block.getTip().height + 1
    }
    return Utxo.aggregate(
      {
        $match: {
          satoshis: {$ne: 0},
          address: {$ne: null},
          createHeight: {$lte: height},
          $or: [
            {useHeight: null},
            {useHeight: {$gt: height}}
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
    )
  }
}

module.exports = AddressService
