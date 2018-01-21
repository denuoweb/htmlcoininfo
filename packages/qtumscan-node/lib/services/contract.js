const BN = require('bn.js')
const qtumscan = require('qtumscan-lib')
const QtumscanRPC = require('qtumscan-rpc')
const BaseService = require('../service')
const Transaction = require('../models/transaction')
const Utxo = require('../models/utxo')
const Contract = require('../models/contract')
const {getInputAddress} = require('../utils')
const BufferUtil = qtumscan.util.buffer
const {sha256ripemd160} = qtumscan.crypto.Hash
const {Base58Check} = qtumscan.encoding
const Address = qtumscan.Address

const tokenAbi = new qtumscan.contract.Contract(qtumscan.contract.tokenABI)
const TOKEN_EVENTS = {
  Transfer: tokenAbi.eventSignature('Transfer').slice(2),
  Approval: tokenAbi.eventSignature('Approval').slice(2),
  Mint: tokenAbi.eventSignature('Mint').slice(2),
  Burn: tokenAbi.eventSignature('Burn').slice(2),
  TokenPurchase: tokenAbi.eventSignature('TokenPurchase').slice(2)
}
const TOKEN_EVENT_HASHES = Object.values(TOKEN_EVENTS)

class ContractService extends BaseService {
  constructor(options) {
    super(options)
    this._address = this.node.services.get('address')
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._network = this.node.network
    this._config = options.rpc || {
      user: 'qtum',
      pass: 'qtumpassword',
      host: 'localhost',
      protocol: 'http',
      port: ['testnet', 'regtest'].includes(this._network) ? 13889 : 3889
    }
    this._client = new QtumscanRPC(this._config)
    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
  }

  static get dependencies() {
    return ['address', 'block', 'db']
  }

  get APIMethods() {
    return [
      ['getContract', this.getContract.bind(this), 1],
      ['getContractHistory', this.getContractHistory, 2],
      ['getContractSummary', this.getContractSummary, 2],
      ['getTokenTransfers', this.getTokenTransfers, 2],
      ['listContracts', this.listContracts.bind(this), 0],
      ['listQRC20Tokens', this.listQRC20Tokens.bind(this), 0],
      ['getAllQRC20TokenBalances', this.getAllQRC20TokenBalances.bind(this), 1]
    ]
  }

  getContract(address) {
    return Contract.findOne({address})
  }

  async getContractHistory(address, {from = 0, to = 0xffffffff} = {}) {
    let list = await this._getContractTxidHistory(address)
    return {
      totalCount: list.length,
      transactions: list.slice(from, to)
    }
  }

  async getContractSummary(address, options = {}) {
    let {totalCount, transactions} = options.noTxList ? {} : await this.getContractHistory(address, options)
    let utxos = await this._address.getAddressUnspentOutputs(address, {listUsed: true})
    let balance = new BN(0)
    let totalReceived = new BN(0)
    let totalSent = new BN(0)
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
      if (utxo.outputTxid) {
        let outputItem
        if (txidMap.has(utxo.outputTxid)) {
          outputItem = txidMap.get(utxo.outputTxid)
          outputItem.sent += utxo.satoshis
        } else {
          outputItem = {received: 0, sent: utxo.satoshis}
          txidMap.set(utxo.outputTxid, outputItem)
        }
      } else {
        balance.iadd(value)
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
      totalSent: totalSent.toString()
    }
  }

  async getTokenTransfers(transaction) {
    let list = []
    for (let receipt of transaction.receipts) {
      for (let {address, topics, data} of receipt.logs) {
        let token = await Contract.findOne({address, type: 'qrc20'})
        if (!token) {
          continue
        }
        token = {
          address,
          name: token.qrc20.name,
          symbol: token.qrc20.symbol,
          decimals: token.qrc20.decimals,
          totalSupply: token.qrc20.totalSupply
        }
        if (topics[0] === TOKEN_EVENTS.Transfer) {
          list.push({
            token,
            from: topics[1] === '0'.repeat(64) ? null : this._fromHexAddress(topics[1].slice(24)),
            to: this._fromHexAddress(topics[2].slice(24)),
            amount: ContractService._uint256toBN(data).toString()
          })
        } else if (topics[0] === TOKEN_EVENTS.Mint) {
          list.push({
            token,
            from: null,
            to: this._fromHexAddress(topics[1].slice(24)),
            amount: ContractService._uint256toBN(data.slice(64)).toString()
          })
        } else if (topics[0] === TOKEN_EVENTS.Burn) {
          list.push({
            token,
            from: this._fromHexAddress(topics[1].slice(24)),
            to: null,
            amount: ContractService._uint256toBN(data.slice(64)).toString()
          })
        }
      }
    }
    return list
  }

  listContracts() {
    return Contract.find()
  }

  listQRC20Tokens() {
    return Contract.find({type: 'qrc20'})
  }

  async getAllQRC20TokenBalances(address) {
    let hexAddress = Base58Check.decode(address).slice(1).toString('hex')
    let tokens = await this.listQRC20Tokens()
    let list = []
    for (let token of tokens) {
      try {
        let {balance} = await this._callMethod(token.address, tokenAbi, 'balanceOf', '0x' + hexAddress)
        if (!balance.isZero()) {
          list.push({
            address: token.address,
            name: token.qrc20.name,
            symbol: token.qrc20.symbol,
            decimals: token.qrc20.decimals,
            totalSupply: token.qrc20.totalSupply,
            balance: balance.toString()
          })
        }
      } catch (err) {}
    }
    return list
  }

  async start() {
    this._tip = await this._db.getServiceTip(this.name)
    let blockTip = this._block.getTip()
    if (this._tip.height > blockTip.height) {
      this._tip = blockTip
      await this._db.updateServiceTip(this._tip)
    }
    for (let x of ['80', '81', '82', '83', '84']) {
      let dgpAddress = '0'.repeat(38) + x
      await Contract.findOneAndUpdate({address: dgpAddress}, {$set: {type: 'dgp'}}, {upsert: true})
    }
    await Contract.deleteMany({createHeight: {$gt: blockTip.height}})
  }

  async onBlock(block) {
    if (block.height === 0) {
      return
    }
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        let output = tx.outputs[i]
        if (output.script.isContractCreate()) {
          let address = ContractService._getContractAddress(tx, i)
          try {
            await this._client.callContract(address, '00')
          } catch (err) {
            continue
          }
          let owner = (await Utxo.findOne({
            'input.transactionId': tx.id,
            'input.index': 0
          })).address
          await this._createContract(tx, block, address, owner)
        }
      }
    }
    await this._processReceipts(block)
  }

  async onReorg(_, block) {
    await Contract.deleteMany({createHeight: block.height})
  }

  static _getContractAddress(tx, index) {
    let indexBuffer = Buffer.alloc(4)
    indexBuffer.writeUInt32LE(index)
    return sha256ripemd160(Buffer.concat([
      BufferUtil.reverse(Buffer.from(tx.hash, 'hex')),
      indexBuffer
    ])).toString('hex')
  }

  async _createContract(tx, block, address, owner) {
    if (await Contract.findOne({address})) {
      return
    }
    let contract = new Contract({address, owner, createTransactionId: tx.id, createHeight: block.height})
    try {
      let {totalSupply} = await this._callMethod(address, tokenAbi, 'totalSupply')
      contract.qrc20.totalSupply = totalSupply.toString()
      contract.type = 'qrc20'
      await Promise.all([
        this._callMethod(address, tokenAbi, 'name').then(
          ({name}) => contract.qrc20.name = name,
          () => {}
        ),
        this._callMethod(address, tokenAbi, 'symbol').then(
          ({symbol}) => contract.qrc20.symbol = symbol,
          () => {}
        ),
        this._callMethod(address, tokenAbi, 'decimals').then(
          ({decimals}) => contract.qrc20.decimals = decimals.toNumber(),
          () => {}
        )
      ])
    } catch (err) {}
    await contract.save()
  }

  async _callMethod(address, contract, method, ...args) {
    let {executionResult} = await this._client.callContract(
      address,
      contract.encodeMethod(method, ...args).slice(2)
    )
    if (executionResult.excepted === 'None') {
      return contract.decodeMethod(method, '0x' + executionResult.output)
    } else {
      throw executionResult.excepted
    }
  }

  static _uint256toBN(data) {
    return new BN(data.replace(/^0+/, '') || '0', 16)
  }

  _fromHexAddress(data) {
    return new Address(Buffer.from(data, 'hex'), this._network).toString()
  }

  async _processReceipts(block) {
    let list = await this._client.searchLogs(block.height, block.height)
    for (let {transactionHash, gasUsed, contractAddress, log} of list) {
      await Transaction.findOneAndUpdate(
        {$or: [{id: transactionHash}, {hash: transactionHash}]},
        {$push: {receipts: {gasUsed, contractAddress, logs: log}}}
      )
      for (let {address, topics, data} of log) {
        if (address !== contractAddress) {
          let transaction = block.transactions.find(
            tx => tx.id === transactionHash || tx.hash === transactionHash
          )
          if (!(await Contract.findOne({address}))) {
            await this._createContract(transaction, block, address, contractAddress)
          }
        }
        if ([TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn].includes(topics[0])) {
          let contract = await Contract.findOne({address, type: 'qrc20'})
          if (!contract) {
            continue
          }
          let {totalSupply} = await this._callMethod(address, tokenAbi, 'totalSupply')
          contract.totalSupply = totalSupply.toString()
          await contract.save()
        }
      }
    }
  }

  async _getContractTxidHistory(address) {
    let contract = await Contract.findOne({address}, ['createTransactionId', 'createHeight'])
    let utxoList = await Utxo.find(
      {address},
      ['output.transactionId', 'input.transactionId', 'createHeight', 'useHeight']
    )
    let contractList = await Transaction.find(
      {
        $or: [
          {'receipts.contractAddress': address},
          {'receipts.logs.address': address}
        ]
      },
      ['id', 'block.height']
    )
    let results = new Set()
    results.add(contract.createTransactionId + ' ' + (contract.createHeight || 0))
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
}

module.exports = ContractService
