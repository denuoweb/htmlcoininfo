const qtuminfo = require('qtuminfo-lib')
const BaseService = require('../service')
const Transaction = require('../models/transaction')
const TransactionOutput = require('../models/transaction-output')
const Contract = require('../models/contract')
const Balance = require('../models/balance')
const {BN} = qtuminfo.crypto

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
    this._network = this.node.network
    this._client = this.node.getRpcClient()
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
    return {
      getContract: this.getContract.bind(this),
      getContractHistory: this.getContractHistory.bind(this),
      getContractSummary: this.getContractSummary.bind(this),
      getTokenTransfers: this.getTokenTransfers.bind(this),
      listContracts: this.listContracts.bind(this),
      listQRC20Tokens: this.listQRC20Tokens.bind(this),
      getAllQRC20TokenBalances: this.getAllQRC20TokenBalances.bind(this),
      searchQRC20Token: this.searchQRC20Token.bind(this)
    }
  }

  getContract(address) {
    return Contract.findOne({address})
  }

  async getContractHistory(address, {from = 0, to = 0xffffffff} = {}) {
    let [{count, list}] = await Transaction.aggregate([
      {
        $match: {
          $or: [
            {inputAddresses: {type: 'contract', hex: address}},
            {outputAddresses: {type: 'contract', hex: address}},
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
            {inputAddresses: {type: 'contract', hex: address}},
            {outputAddresses: {type: 'contract', hex: address}},
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
    let cursor = TransactionOutput.find(
      {address: {type: 'contract', hex: address}},
      ['satoshis', 'input']
    ).cursor()
    let txo
    while (txo = await cursor.next()) {
      let value = new BN(txo.satoshis)
      totalReceived.iadd(value)
      if (txo.input) {
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
          amount: new BN(data, 16).toString()
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

  async getAllQRC20TokenBalances(addresses) {
    if (!Array.isArray(addresses)) {
      addresses = [addresses]
    }
    let list = await Balance.aggregate([
      {
        $match: {
          address: {$in: addresses},
          balance: {$ne: '0'.repeat(64)}
        }
      },
      {
        $group: {
          _id: '$contract',
          balances: {$push: '$balance'}
        }
      },
      {
        $lookup: {
          from: 'contracts',
          localField: '_id',
          foreignField: 'address',
          as: 'contract'
        }
      },
      {$match: {'contract.type': 'qrc20'}},
      {$unwind: '$contract'},
      {$unwind: '$contract.qrc20'},
      {$project: {_id: false, contract: '$contract', balances: '$balances'}}
    ])
    return list.map(({contract, balances}) => {
      let sum = new BN()
      for (let balance of balances) {
        sum.iadd(new BN(balance, 16))
      }
      return {
        address: contract.address,
        name: contract.qrc20.name,
        symbol: contract.qrc20.symbol,
        decimals: contract.qrc20.decimals,
        totalSupply: contract.qrc20.totalSupply,
        version: contract.qrc20.version,
        balance: sum.toString()
      }
    })
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
          {inputAddresses: {type: 'contract', hex: token.address}},
          {outputAddresses: {type: 'contract', hex: token.address}},
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
    this._tip = await this.node.getServiceTip(this.name)
    let blockTip = this.node.getBlockTip()
    if (this._tip.height > blockTip.height) {
      this._tip = blockTip
      await this.node.updateServiceTip(this.name, this._tip)
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
          let address = TransactionOutput.getAddress(tx, i).hex
          try {
            await this._client.callContract(address, '00')
          } catch (err) {
            continue
          }
          let owner = (await TransactionOutput.findOne({
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
    await this.node.updateServiceTip(this.name, this._tip)
  }

  async onReorg(_, block) {
    await Contract.deleteMany({createHeight: block.height})
    let balanceChanges = new Set()
    let transfers = await Transaction.aggregate([
      {$match: {'block.height': block.height, 'receipts.logs.topics.0': TOKEN_EVENTS.Transfer}},
      {$project: {_id: false, receipts: '$receipts'}},
      {$unwind: '$receipts'},
      {$unwind: '$receipts.logs'},
      {
        $project: {
          address: '$receipts.logs.address',
          topics: '$receipts.logs.topics'
        }
      },
      {$match: {'topics.0': TOKEN_EVENTS.Transfer}}
    ])
    for (let {address, topics} of transfers) {
      balanceChanges.add(address + ' ' + topics[1].slice(24))
      balanceChanges.add(address + ' ' + topics[2].slice(24))
    }
    await this._updateBalances(balanceChanges)
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

  async _fromHexAddress(data) {
    if (await Contract.findOne({address: data})) {
      return {type: 'contract', hex: data}
    } else {
      return {type: 'pubkeyhash', hex: data}
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
    let balanceChanges = new Set()
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
              await this._createContract(transaction, block, address, {type: 'contract', hex: contractAddress})
            }
          }
          if (topics[0] === TOKEN_EVENTS.Transfer) {
            balanceChanges.add(address + ' ' + topics[1].slice(24))
            balanceChanges.add(address + ' ' + topics[2].slice(24))
          } else if ([TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn].includes(topics[0])) {
            totalSupplyChanges.add(address)
          }
        }
      }
    }
    await this._updateBalances(balanceChanges)
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

  async _updateBalances(balanceChanges) {
    for (let item of balanceChanges) {
      let [contract, address] = item.split(' ')
      try {
        let {balance} = await this._callMethod(contract, tokenAbi, 'balanceOf', address)
        await Balance.update(
          {contract, address},
          {balance: balance.toString(16).padStart(64, '0')},
          {upsert: true}
        )
      } catch (err) {}
    }
  }

  async qrc20TokenSnapshot(address, height) {
    let token = await Contract.findOne({address, type: 'qrc20'})
    if (!token) {
      return
    }
    if (height == null) {
      height = this.node.getBlockTip().height
    }
    if (height < token.createHeight) {
      return []
    }
    let addressResults = await Balance.find({contract: address})
    let previousTransfers = await Transaction.aggregate([
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
      {$match: {height: {$gt: height}, address, 'topics.0': TOKEN_EVENTS.Transfer}},
      {$project: {topics: '$topics', data: '$data'}}
    ])
    let mapping = new Map()
    for (let {address, balance} of addressResults) {
      mapping.set(address, new BN(balance))
    }
    for (let {topics, data} of previousTransfers) {
      let from = topics[1].slice(24)
      let to = topics[2].slice(24)
      let amount = new BN(data, 16)
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
        results.push({address, balance})
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
