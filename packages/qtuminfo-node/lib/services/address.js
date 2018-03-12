const {CronJob} = require('cron')
const qtuminfo = require('qtuminfo-lib')
const BaseService = require('../service')
const Block = require('../models/block')
const Transaction = require('../models/transaction')
const TransactionOutput = require('../models/transaction-output')
const Snapshot = require('../models/snapshot')
const {toRawScript} = require('../utils')
const {Address, Networks} = qtuminfo
const {Base58Check, SegwitAddress} = qtuminfo.encoding
const {BN} = qtuminfo.crypto
const {Contract, tokenABI} = qtuminfo.contract

const tokenAbi = new Contract(tokenABI)
const TOKEN_EVENTS = {
  Transfer: tokenAbi.eventSignature('Transfer').slice(2),
  Approval: tokenAbi.eventSignature('Approval').slice(2),
  Mint: tokenAbi.eventSignature('Mint').slice(2),
  Burn: tokenAbi.eventSignature('Burn').slice(2)
}

class AddressService extends BaseService {
  constructor(options) {
    super(options)
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

  get APIMethods() {
    return {
      getAddressHistory: this.getAddressHistory.bind(this),
      getAddressSummary: this.getAddressSummary.bind(this),
      getAddressUnspentOutputs: this.getAddressUnspentOutputs.bind(this),
      getAddressTransactionCount: this.getAddressTransactionCount.bind(this),
      getRichList: this.getRichList.bind(this),
      getMiners: this.getMiners.bind(this),
      snapshot: this.snapshot.bind(this)
    }
  }

  async getAddressHistory(addresses, {from = 0, to = 0xffffffff} = {}) {
    if (!Array.isArray(addresses)) {
      addresses = [addresses]
    }
    let [{count, list}] = await Transaction.aggregate([
      {
        $match: {
          $or: [
            {inputAddresses: {$elemMatch: AddressService._constructAddressElementQuery(addresses)}},
            {outputAddresses: {$elemMatch: AddressService._constructAddressElementQuery(addresses)}},
            {
              'receipts.logs': {
                $elemMatch: {
                  'topics.0': {$in: [TOKEN_EVENTS.Transfer, TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn]},
                  topics: {$in: AddressService._toHexAddresses(addresses)}
                }
              }
            }
          ]
        }
      },
      {
        $facet: {
          count: [{$group: {_id: null, count: {$sum: 1}}}],
          list: [
            {$sort: {'block.height': -1, index: -1}},
            {$skip: from},
            {$limit: to - from},
            {$project: {id: true}}
          ]
        }
      }
    ])
    return {
      totalCount: count.length && count[0].count,
      transactions: list.map(tx => tx.id)
    }
  }

  getAddressTransactionCount(addresses) {
    if (!Array.isArray(addresses)) {
      addresses = [addresses]
    }
    return Transaction.count({
      $or: [
        {inputAddresses: {$elemMatch: AddressService._constructAddressElementQuery(addresses)}},
        {outputAddresses: {$elemMatch: AddressService._constructAddressElementQuery(addresses)}},
        {
          'receipts.logs': {
            $elemMatch: {
              'topics.0': {$in: [TOKEN_EVENTS.Transfer, TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn]},
              topics: {$in: AddressService._toHexAddresses(addresses)}
            }
          }
        }
      ]
    })
  }

  async getAddressSummary(addresses, options = {}) {
    if (!Array.isArray(addresses)) {
      addresses = [addresses]
    }
    let totalCount = await this.getAddressTransactionCount(addresses)
    let balance = new BN(0)
    let totalReceived = new BN(0)
    let totalSent = new BN(0)
    let unconfirmedBalance = new BN(0)
    let stakingBalance = new BN(0)
    let cursor = TransactionOutput.find(
      {
        ...AddressService._constructAddressQuery(addresses),
        'output.height': {$gt: 0}
      },
      ['satoshis', 'output.height', 'input', 'isStake']
    ).cursor()
    let txo
    while (txo = await cursor.next()) {
      let value = new BN(txo.satoshis)
      let confirmations = Math.max(this.node.getBlockTip().height - txo.output.height + 1, 0)
      totalReceived.iadd(value)
      if (txo.input) {
        totalSent.iadd(value)
      } else {
        balance.iadd(value)
        if (confirmations === 0) {
          unconfirmedBalance.iadd(value)
        }
      }
      if (txo.isStake && confirmations <= 500) {
        stakingBalance.iadd(value)
      }
    }
    return {
      totalCount,
      balance: balance.toString(),
      totalReceived: totalReceived.toString(),
      totalSent: totalSent.toString(),
      unconfirmedBalance: unconfirmedBalance.toString(),
      stakingBalance: stakingBalance.toString()
    }
  }

  static _constructAddressElementQuery(addresses) {
    return {
      $or: addresses.map(address => {
        if (['pubkey', 'pubkeyhash', 'witness_v0_keyhash'].includes(address.type)) {
          return {type: {$ne: 'contract'}, hex: address.hex}
        } else {
          return address
        }
      })
    }
  }

  static _constructAddressQuery(addresses, key = 'address') {
    return {
      $or: addresses.map(address => {
        if (['pubkey', 'pubkeyhash', 'witness_v0_keyhash'].includes(address.type)) {
          return {[key + '.type']: {$ne: 'contract'}, [key + '.hex']: address.hex}
        } else {
          return {[key + '.type']: address.type, [key + '.hex']: address.hex}
        }
      })
    }
  }

  static _toHexAddresses(addresses) {
    return addresses
      .filter(address => ['pubkey', 'pubkeyhash', 'witness_v0_keyhash'].includes(address.type))
      .map(address => '0'.repeat(24) + address.hex)
  }

  async getAddressUnspentOutputs(addresses) {
    if (!Array.isArray(addresses)) {
      addresses = [addresses]
    }
    let utxoList = await TransactionOutput.find({
      ...AddressService._constructAddressQuery(addresses),
      'output.height': {$gt: 0},
      input: {$exists: false}
    })
    return utxoList.map(utxo => ({
      address: utxo.address,
      txid: utxo.output.transactionId,
      vout: utxo.output.index,
      scriptPubKey: utxo.output.script.toString('hex'),
      satoshis: utxo.satoshis,
      isStake: utxo.isStake,
      height: utxo.output.height,
      confirmations: Math.max(this.node.getBlockTip().height - utxo.output.height + 1, 0)
    }))
  }

  snapshot({height, minBalance = 1, sort = true, hexOnly, limit} = {}) {
    if (height == null) {
      height = this.node.getBlockTip().height + 1
    }
    return [
      {
        $match: {
          satoshis: {$ne: 0},
          address: {$exists: true},
          'address.type': {$ne: 'contract'},
          'output.height': {$gt: 0, $lte: height},
          $or: [
            {input: {$exists: false}},
            {'input.height': {$gt: height}}
          ]
        }
      },
      ...([hexOnly
        ? {$group: {_id: '$address.hex', balance: {$sum: '$satoshis'}}}
        : {
          $group: {
            _id: {
              type: {
                $cond: {
                  if: {$in: ['$address.type', ['pubkey', 'pubkeyhash']]},
                  then: 'pubkeyhash',
                  else: '$address.type'
                }
              },
              hex: '$address.hex'
            },
            balance: {$sum: '$satoshis'}
          }
        }
      ]),
      {$match: {balance: {$gte: minBalance}}},
      ...(sort ? [{$sort: {balance: -1}}] : []),
      ...(limit == null ? [] : [{$limit: limit}]),
      {$project: {_id: false, address: '$_id', balance: '$balance'}}
    ]
  }

  async cronSnapshot() {
    await TransactionOutput.aggregate(
      this.snapshot({sort: false}).concat({$out: 'snapshots'})
    ).option({allowDiskUse: true})
  }

  async getRichList({from = 0, to = 100} = {}) {
    let totalCount = await Snapshot.count({balance: {$ne: 0}})
    let list = await Snapshot.find({}, {_id: false}).sort({balance: -1}).skip(from).limit(to - from)
    return {totalCount, list}
  }

  async getMiners({from = 0, to = 100} = {}) {
    let [{count, list}] = await Block.aggregate([
      {$match: {height: {$gt: 5000}}},
      {$group: {_id: '$minedBy.hex', blocks: {$sum: 1}}},
      {$project: {_id: false, address: {type: 'pubkey', hex: '$_id'}, blocks: '$blocks'}},
      {
        $facet: {
          count: [{$group: {_id: null, count: {$sum: 1}}}],
          list: [
            {$sort: {blocks: -1}},
            {$skip: from},
            {$limit: to - from},
            {
              $lookup: {
                from: 'snapshots',
                localField: 'address.hex',
                foreignField: 'address.hex',
                as: 'balance'
              }
            },
            {
              $project: {
                address: '$address',
                blocks: '$blocks',
                balance: {
                  $cond: {
                    if: {$eq: ['$balance', []]},
                    then: 0,
                    else: {$arrayElemAt: ['$balance.balance', 0]}
                  }
                }
              }
            }
          ]
        }
      }
    ])
    return {totalCount: count[0].count, list}
  }

  start() {
    new CronJob({
      cronTime: '0 */10 * * * *',
      onTick: this.cronSnapshot.bind(this),
      start: true
    })
  }
}

module.exports = AddressService
