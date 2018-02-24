const qtuminfo = require('qtuminfo-lib')
const BaseService = require('../service')
const Transaction = require('../models/transaction')
const Utxo = require('../models/utxo')
const Contract = require('../models/contract')
const {getInputAddress} = require('../utils')
const {BN} = qtuminfo.crypto
const {sha256ripemd160} = qtuminfo.crypto.Hash
const {Base58Check, SegwitAddress} = qtuminfo.encoding
const {Address, Networks} = qtuminfo

const tokenAbi = new qtuminfo.contract.Contract(qtuminfo.contract.tokenABI)
const TOKEN_EVENTS = {
  Transfer: tokenAbi.eventSignature('Transfer').slice(2),
  Approval: tokenAbi.eventSignature('Approval').slice(2),
  Mint: tokenAbi.eventSignature('Mint').slice(2),
  Burn: tokenAbi.eventSignature('Burn').slice(2)
}
const TOKEN_EVENT_HASHES = Object.values(TOKEN_EVENTS)

class ContractService extends BaseService {
  constructor(options) {
    super(options)
    this._address = this.node.services.get('address')
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._network = this.node.network
    this._client = this._db.getRpcClient()
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
      ['getAllQRC20TokenBalances', this.getAllQRC20TokenBalances.bind(this), 1],
      ['searchQRC20Token', this.searchQRC20Token.bind(this), 1]
    ]
  }

  getContract(address) {
    return Contract.findOne({address})
  }

  async getContractHistory(address, {from = 0, to = 0xffffffff} = {}) {
    let [{count, list}] = await Transaction.aggregate([
      {
        $match: {
          $or: [
            {inputAddresses: address},
            {outputAddresses: address},
            {'receipts.contractAddress': address},
            {'receipts.logs.address': address}
          ]
        }
      },
      {
        $facet: {
          count: [{$group: {_id: null, count: {$sum: 1}}}],
          list: [
            {$sort: {'block.height': -1, index: -1}},
            {$project: {id: true}},
            {$skip: from},
            {$limit: to - from}
          ]
        }
      }
    ])
    return {
      totalCount: count[0].count,
      transactions: list.map(tx => tx.id)
    }
  }

  async getContractTransactionCount(address) {
    let result = await Transaction.aggregate([
      {
        $match: {
          $or: [
            {inputAddresses: address},
            {outputAddresses: address},
            {'receipts.contractAddress': address},
            {'receipts.logs.address': address}
          ]
        }
      },
      {$group: {_id: null, count: {$sum: 1}}}
    ])
    return result.length && result[0].count
  }

  async getContractSummary(address, options = {}) {
    let totalCount = await this.getContractTransactionCount(address)
    let balance = new BN(0)
    let totalReceived = new BN(0)
    let totalSent = new BN(0)
    let cursor = Utxo.find({address}, ['satoshis', 'input.transactionId']).cursor()
    let utxo
    while (utxo = await cursor.next()) {
      let value = new BN(utxo.satoshis)
      totalReceived.iadd(value)
      if (utxo.input.transactionId) {
        totalSent.iadd(value)
      } else {
        balance.iadd(value)
      }
    }
    return {
      address,
      totalCount,
      balance: balance.toString(),
      totalReceived: totalReceived.toString(),
      totalSent: totalSent.toString()
    }
  }

  async getTokenTransfers(transaction) {
    let list = []
    for (let receipt of transaction.receipts) {
      for (let {address, topics, data} of receipt.logs) {
        if (topics[0] !== TOKEN_EVENTS.Transfer) {
          continue
        }
        let token = await Contract.findOne({address, type: 'qrc20'})
        if (!token) {
          continue
        }
        token = {
          address,
          name: token.qrc20.name,
          symbol: token.qrc20.symbol,
          decimals: token.qrc20.decimals,
          totalSupply: token.qrc20.totalSupply,
          version: token.qrc20.version
        }
        list.push({
          token,
          from: topics[1] === '0'.repeat(64) ? null : await this._fromHexAddress(topics[1].slice(24)),
          to: topics[2] === '0'.repeat(64) ? null : await this._fromHexAddress(topics[2].slice(24)),
          amount: ContractService._uint256toBN(data).toString()
        })
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
    let hexAddress = /^[0-9a-f]{40}$/i.test(address) ? address : this._toHexAddress(address)
    let tokens = await Transaction.aggregate([
      {$project: {receipts: '$receipts'}},
      {
        $match: {
          'receipts.logs.topics.0': TOKEN_EVENTS.Transfer,
          'receipts.logs.topics': '0'.repeat(24) + hexAddress,
        }
      },
      {$unwind: '$receipts'},
      {$unwind: '$receipts.logs'},
      {
        $match: {
          'receipts.logs.topics.0': TOKEN_EVENTS.Transfer,
          'receipts.logs.topics': '0'.repeat(24) + hexAddress,
        }
      },
      {
        $group: {
          _id: null,
          contract: {$addToSet: '$receipts.logs.address'}
        }
      },
      {$unwind: '$contract'},
      {
        $lookup: {
          from: 'contracts',
          localField: 'contract',
          foreignField: 'address',
          as: 'contract'
        }
      },
      {$unwind: '$contract'},
      {$match: {'contract.type': 'qrc20'}},
      {$project: {address: '$contract.address', qrc20: '$contract.qrc20'}}
    ])
    let tokenCreated = await Contract.find({owner: address, type: 'qrc20'})
    let tokenSet = new Set(tokens.map(token => token.address))
    tokens.push(...tokenCreated.filter(token => !tokenSet.has(token.address)))
    let results = await this._batchCallMethods(tokens.map(token => ({
      address: token.address,
      abi: tokenAbi,
      method: 'balanceOf',
      args: [hexAddress]
    })))
    let list = []
    for (let i = 0; i < tokens.length; ++i) {
      let token = tokens[i]
      let {balance} = await results[i]
      if (!balance.isZero()) {
        list.push({
          address: token.address,
          name: token.qrc20.name,
          symbol: token.qrc20.symbol,
          decimals: token.qrc20.decimals,
          totalSupply: token.qrc20.totalSupply,
          version: token.qrc20.version,
          balance: balance.toString()
        })
      }
    }
    return list
  }

  async searchQRC20Token(name) {
    let tokens = await Contract.find(
      {$text: {$search: name}},
      {score: {$meta: 'textScore'}}
    ).sort({score: {$meta: 'textScore'}})
    if (tokens.length === 0) {
      return
    }
    let index = tokens.findIndex(token => token.score < tokens[0].score)
    if (index >= 0) {
      tokens = tokens.slice(0, index)
    }
    let bestToken = {token: null, transactions: 0}
    for (let token of tokens) {
      let count = await Transaction.count({
        $or: [
          {inputAddresses: token.address},
          {outputAddresses: token.address},
          {'receipts.contractAddress': token.address},
          {'receipts.logs.address': token.address}
        ]
      })
      if (count > bestToken.transactions) {
        bestToken = {token, transactions: count}
      }
    }
    return bestToken.token
  }

  async start() {
    this._tip = await this._db.getServiceTip(this.name)
    let blockTip = this._block.getTip()
    if (this._tip.height > blockTip.height) {
      this._tip = blockTip
      await this._db.updateServiceTip(this.name, this._tip)
    }
    for (let x of ['80', '81', '82', '83', '84']) {
      let dgpAddress = '0'.repeat(38) + x
      await Contract.findOneAndUpdate(
        {address: dgpAddress},
        {createHeight: 0, type: 'dgp'},
        {upsert: true}
      )
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
    this._tip.height = block.height
    this._tip.hash = block.hash
    await this._db.updateServiceTip(this.name, this._tip)
  }

  async onReorg(_, block) {
    await Contract.deleteMany({createHeight: block.height})
  }

  static _getContractAddress(tx, index) {
    let indexBuffer = Buffer.alloc(4)
    indexBuffer.writeUInt32LE(index)
    return sha256ripemd160(Buffer.concat([
      Buffer.from(tx.id, 'hex').reverse(),
      indexBuffer
    ])).toString('hex')
  }

  async _createContract(tx, block, address, owner) {
    if (await Contract.findOne({address})) {
      return
    }
    let contract = new Contract({address, owner, createTransactionId: tx.id, createHeight: block.height})
    try {
      let [{totalSupply}, {balance}] = await Promise.all(await this._batchCallMethods([
        {address, abi: tokenAbi, method: 'totalSupply'},
        {address, abi: tokenAbi, method: 'balanceOf', args: ['0'.repeat(40)]}
      ]))
      contract.qrc20.totalSupply = totalSupply.toString()
      contract.type = 'qrc20'
      let [nameResult, symbolResult, decimalsResult, versionResult] = await this._batchCallMethods([
        {address, abi: tokenAbi, method: 'name'},
        {address, abi: tokenAbi, method: 'symbol'},
        {address, abi: tokenAbi, method: 'decimals'},
        {address, abi: tokenAbi, method: 'version'}
      ])
      try {
        contract.qrc20.name = (await nameResult).name
      } catch (err) {}
      try {
        contract.qrc20.symbol = (await symbolResult).symbol
      } catch (err) {}
      try {
        contract.qrc20.decimals = (await decimalsResult).decimals
      } catch (err) {}
      try {
        contract.qrc20.version = (await versionResult).version
      } catch (err) {}
    } catch (err) {}
    await contract.save()
  }

  async _callMethod(address, abi, method, ...args) {
    let {executionResult} = await this._client.callContract(
      address,
      abi.encodeMethod(method, ...args.map(arg => '0x' + arg)).slice(2)
    )
    if (executionResult.excepted === 'None') {
      return abi.decodeMethod(method, '0x' + executionResult.output)
    } else {
      throw executionResult.excepted
    }
  }

  async _batchCallMethods(callList) {
    let results = await this._client.batch(() => {
      for (let {address, abi, method, args = []} of callList) {
        this._client.callContract(
          address,
          abi.encodeMethod(method, ...args.map(arg => '0x' + arg)).slice(2)
        )
      }
    })
    return results.map(async (result, index) => {
      let {abi, method} = callList[index]
      let {executionResult} = await result
      if (executionResult.excepted === 'None') {
        return abi.decodeMethod(method, '0x' + executionResult.output)
      } else {
        throw executionResult.excepted
      }
    })
  }

  static _uint256toBN(data) {
    return new BN(data.replace(/^0+/, '') || '0', 16)
  }

  async _fromHexAddress(data) {
    if (await Contract.findOne({address: data})) {
      return data
    }
    let segwitAddress = new Address(Buffer.from(data, 'hex'), this._network, Address.PayToWitnessKeyHash)
    if (await Utxo.findOne({address: segwitAddress})) {
      return segwitAddress.toString()
    } else {
      return new Address(Buffer.from(data, 'hex'), this._network).toString()
    }
  }

  _toHexAddress(address) {
    let network = Networks.get(this._network)
    if (address.length === 34) {
      let hexAddress = Base58Check.decode(address)
      if (hexAddress[0] === network.pubkeyhash) {
        return hexAddress.slice(1).toString('hex')
      }
    } else if (address.length === 42) {
      let result = SegwitAddress.decode(network.witness_v0_keyhash, address)
      if (result) {
        return Buffer.from(result.program).toString('hex')
      }
    }
  }

  async _processReceipts(block) {
    let receiptIndices = []
    for (let i = 0; i < block.transactions.length; ++i) {
      let tx = block.transactions[i]
      for (let output of tx.outputs) {
        if (output.script.isContractCreate() || output.script.isContractCall()) {
          receiptIndices.push(i)
          break
        }
      }
    }
    if (receiptIndices.length === 0) {
      return
    }
    let blockReceipts = await Promise.all(await this._client.batch(() => {
      for (let index of receiptIndices) {
        this._client.getTransactionReceipt(block.transactions[index].id)
      }
    }))
    let totalSupplyChanges = new Set()
    for (let index = 0; index < receiptIndices.length; ++index) {
      let tx = block.transactions[receiptIndices[index]]
      await Transaction.findOneAndUpdate(
        {id: tx.id},
        {
          receipts: blockReceipts[index].map(receipt => ({
            gasUsed: receipt.gasUsed,
            contractAddress: receipt.contractAddress,
            excepted: receipt.excepted,
            logs: receipt.log
          }))
        }
      )
      for (let {transactionHash, gasUsed, contractAddress, log} of blockReceipts[index]) {
        for (let {address, topics, data} of log) {
          if (address !== contractAddress) {
            let transaction = block.transactions.find(tx => tx.id === transactionHash)
            if (!await Contract.findOne({address})) {
              await this._createContract(transaction, block, address, contractAddress)
            }
          }
          if ([TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn].includes(topics[0])) {
            totalSupplyChanges.add(address)
          }
        }
      }
    }
    for (let address of totalSupplyChanges) {
      let contract = await Contract.findOne({address, type: 'qrc20'})
      if (!contract) {
        continue
      }
      let {totalSupply} = await this._callMethod(address, tokenAbi, 'totalSupply')
      contract.qrc20.totalSupply = totalSupply.toString()
      await contract.save()
    }
  }

  async qrc20TokenSnapshot(address, height) {
    let token = await Contract.findOne({address, type: 'qrc20'})
    if (!token) {
      return
    }
    if (height == null) {
      height = this._block.getTip().height
    }
    if (height < token.createHeight) {
      return []
    }
    let [{addressResults, previousTransfers}] = await Transaction.aggregate([
      {$match: {'receipts.logs.address': address}},
      {$project: {_id: false, height: '$block.height', receipts: '$receipts'}},
      {$unwind: '$receipts'},
      {$unwind: '$receipts.logs'},
      {
        $project: {
          height: '$height',
          address: '$receipts.logs.address',
          topics: '$receipts.logs.topics',
          data: '$receipts.logs.data'
        }
      },
      {$match: {address, 'topics.0': TOKEN_EVENTS.Transfer}},
      {
        $facet: {
          addressResults: [
            {$project: {address: {$slice: ['$topics', 1, 2]}}},
            {$unwind: '$address'},
            {$project: {address: {$substr: ['$address', 24, 40]}}},
            {$group: {_id: null, addresses: {$addToSet: '$address'}}}
          ],
          previousTransfers: [
            {$match: {height: {$gt: height}}},
            {$project: {topics: '$topics', data: '$data'}}
          ]
        }
      }
    ])
    let addresses = addressResults.length ? addressResults[0].addresses : []
    let balances = await Promise.all(await this._batchCallMethods(addresses.map(item => ({
      address, abi: tokenAbi, method: 'balanceOf', args: [item]
    }))))
    let mapping = new Map()
    for (let i = 0; i < addresses.length; ++i) {
      mapping.set(addresses[i], balances[i].balance)
    }
    for (let {topics, data} of previousTransfers) {
      let from = topics[1].slice(24)
      let to = topics[2].slice(24)
      let amount = ContractService._uint256toBN(data)
      if (mapping.has(from)) {
        mapping.get(from).iadd(amount)
      }
      if (mapping.has(to)) {
        mapping.get(to).isub(amount)
      }
    }
    let results = []
    for (let [address, balance] of mapping) {
      if (!balance.isZero()) {
        results.push({address: await this._fromHexAddress(address), balance})
      }
    }
    results.sort((x, y) => y.balance.cmp(x.balance))
    for (let result of results) {
      result.balance = result.balance.toString()
    }
    return results
  }
}

module.exports = ContractService
