const LRU = require('lru-cache')
const BN = require('bn.js')
const qtumscan = require('qtumscan-lib')
const QtumscanRPC = require('qtumscan-rpc')
const BaseService = require('../../service')
const Encoding = require('./encoding')
const {getInputAddress} = require('../../utils')
const BufferUtil = qtumscan.util.buffer
const {sha256ripemd160} = qtumscan.crypto.Hash
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
const TOKEN_EVENT_HASHES = Object.values(TOKEN_EVENTS)

class ContractService extends BaseService {
  constructor(options) {
    super(options)
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._transaction = this.node.services.get('transaction')
    this._network = this.node.network
    this._config = options.rpc || {
      user: 'qtum',
      pass: 'qtumpassword',
      host: 'localhost',
      protocol: 'http',
      port: ['testnet', 'regtest'].includes(this._network) ? 13889 : 3889
    }
    this._client = new QtumscanRPC(this._config)
    this._contractCache = new LRU(1000)
    this._tokenCache = new LRU(1000)
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
    return [
      ['getContract', this.getContract.bind(this), 1],
      ['getContractHistory', this.getContractHistory, 2],
      ['getContractSummary', this.getContractSummary, 2],
      ['getContractUnspentOutputs', this.getContractUnspentOutputs, 2],
      ['getToken', this.getToken.bind(this), 1],
      ['getTokenTransfers', this.getTokenTransfers.bind(this), 1],
      ['listContracts', this.listContracts.bind(this), 0],
      ['listTokens', this.listTokens.bind(this), 0],
      ['getAllTokenBalances', this.getAllTokenBalances.bind(this), 1]
    ]
  }

  async getContract(address) {
    let cacheContract = this._contractCache.get(address)
    if (cacheContract) {
      return cacheContract
    }
    let contractBuffer = await this._db.get(this._encoding.encodeContractKey(address))
    if (contractBuffer) {
      let contract = this._encoding.decodeContractValue(contractBuffer)
      this._contractCache.set(address, contract)
      return contract
    }
  }

  async getContractHistory(address, {from = 0, to = 0xffffffff} = {}) {
    let list = await this._getContractTxidHistory(address)
    list.sort((a, b) => b.height - a.height)
    return {
      totalCount: list.length,
      transactions: list.slice(from, to).map(tx => tx.txid)
    }
  }

  async getContractSummary(address, options = {}) {
    let {totalCount, transactions} = options.noTxList ? {} : await this.getContractHistory(address, options)
    options.listUsed = true
    let utxos = await this.getContractUnspentOutputs(address, options)
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

  async getContractUnspentOutputs(address, {listUsed = false} = {}) {
    let results = []

    await new Promise((resolve, reject) => {
      let start = this._encoding.encodeContractUtxoKey(address)
      let end = Buffer.concat([start.slice(0, -36), Buffer.alloc(36, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', resolve)
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        let key = this._encoding.decodeContractUtxoKey(data.key)
        let value = this._encoding.decodeContractUtxoValue(data.value)
        let confirmations = this._block.getTip().height - value.height + 1
        results.push({
          address,
          txid: key.txid,
          vout: key.outputIndex,
          timestamp: value.timestamp,
          height: value.height,
          satoshis: value.satoshis,
          confirmations
        })
      })
    })

    if (listUsed) {
      await new Promise((resolve, reject) => {
        let start = this._encoding.encodeContractUsedUtxoKey(address)
        let end = Buffer.concat([start.slice(0, -36), Buffer.alloc(36, 0xff)])
        let utxoStream = this._db.createReadStream({gte: start, lt: end})
        utxoStream.on('end', resolve)
        utxoStream.on('error', reject)
        utxoStream.on('data', data => {
          let key = this._encoding.decodeContractUsedUtxoKey(data.key)
          let value = this._encoding.decodeContractUsedUtxoValue(data.value)
          results.push({
            address,
            txid: key.txid,
            vout: key.outputIndex,
            timestamp: value.timestamp,
            outputTxid: value.outputTxid,
            height: value.height,
            satoshis: value.satoshis,
            confirmations: this._block.getTip().height - value.height + 1,
          })
        })
      })
    }

    return results.sort((x, y) => x.confirmations - y.confirmations)
  }

  async getToken(address) {
    let cacheToken = this._tokenCache.get(address)
    if (cacheToken) {
      return cacheToken
    }
    let tokenBuffer = await this._db.get(this._encoding.encodeTokenKey(address))
    if (tokenBuffer) {
      let token = this._encoding.decodeTokenValue(tokenBuffer)
      this._tokenCache.set(address, token)
      return token
    }
  }

  getTokenTransfers(txid) {
    return new Promise((resolve, reject) => {
      let list = []
      let start = this._encoding.encodeEventLogKey(txid, 0)
      let end = Buffer.concat([start.slice(0, -4), Buffer.alloc(4, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(list))
      utxoStream.on('error', reject)
      utxoStream.on('data', async bufferData => {
        let {address, topics, data} = this._encoding.decodeEventLogValue(bufferData.value)
        let token = await this.getToken(address)
        if (!token) {
          return
        }
        token = Object.assign({address}, token)
        if (topics[0] === TOKEN_EVENTS.Transfer) {
          let from = new Address(Buffer.from(topics[1].slice(24), 'hex'), this._network).toString()
          let to = new Address(Buffer.from(topics[2].slice(24), 'hex'), this._network).toString()
          let amount = ContractService._uint256toBN(data)
          list.push({token, from, to, amount})
        } else if (topics[0] === TOKEN_EVENTS.Mint) {
          let to = new Address(Buffer.from(topics[1].slice(24), 'hex'), this._network).toString()
          let amount = ContractService._uint256toBN(data.slice(64))
          list.push({token, from: null, to, amount})
        } else if (topics[0] === TOKEN_EVENTS.Burn) {
          let from = new Address(Buffer.from(topics[1].slice(24), 'hex'), this._network).toString()
          let amount = ContractService._uint256toBN(data.slice(64))
          list.push({token, from, to: null, amount})
        }
      })
    })
  }

  listContracts() {
    return new Promise((resolve, reject) => {
      let list = []
      let start = this._encoding.encodeContractKey('0'.repeat(40))
      let end = Buffer.concat([start.slice(0, -20), Buffer.alloc(20, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(list))
      utxoStream.on('error', reject)
      utxoStream.on('data', async data => {
        let {address} = this._encoding.decodeContractKey(data.key)
        let {height, txid, owner} = this._encoding.decodeContractValue(data.value)
        list.push({address, height, txid, owner})
      })
    })
  }

  listTokens() {
    return new Promise((resolve, reject) => {
      let list = []
      let start = this._encoding.encodeTokenKey('0'.repeat(40))
      let end = Buffer.concat([start.slice(0, -20), Buffer.alloc(20, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(list))
      utxoStream.on('error', reject)
      utxoStream.on('data', async data => {
        let {address} = this._encoding.decodeTokenKey(data.key)
        let {name, symbol, decimals, totalSupply} = this._encoding.decodeTokenValue(data.value)
        list.push({address, name, symbol, decimals, totalSupply})
      })
    })
  }

  async getAllTokenBalances(address) {
    let hexAddress = Base58Check.decode(address).slice(1).toString('hex')
    let tokens = await this.listTokens()
    let list = []
    for (let token of tokens) {
      try {
        let {balance} = await this._callMethod(token.address, tokenAbi, 'balanceOf', '0x' + hexAddress)
        if (!balance.isZero()) {
          list.push(Object.assign(token, {balance}))
        }
      } catch (err) {}
    }
    return list
  }

  async start() {
    this._prefix = await this._db.getPrefix(this.name)
    this._encoding = new Encoding(this._prefix)
  }

  async onBlock(block) {
    let operations = []
    let contractAddresses = new Set()
    let utxoMap = new Map()
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        let output = tx.outputs[i]
        if (output.script.isContractCreate()) {
          let address = ContractService._getContractAddress(tx, i)
          try {
            await this._client.callContract(address, '00')
            operations.push(...(await this._createContract(tx, block, address)))
            contractAddresses.add(address)
          } catch (err) {}
        } else if (output.script.isContractCall()) {
          let address = tx.outputs[i].script.chunks[4].buf.toString('hex')
          contractAddresses.add(address)
          operations.push({
            type: 'put',
            key: this._encoding.encodeContractTransactionKey(address, block.height, tx.id)
          })
          if (output.satoshis) {
            operations.push(...this._processOutput(tx, i, block, address, utxoMap))
          }
        }
      }
      for (let i = 0; i < tx.inputs.length; ++i) {
        if (tx.inputs[i].script.isContractSpend()) {
          operations.push(...(await this._processInput(tx, i, block, utxoMap)))
        }
      }
    }
    if (contractAddresses.size) {
      operations.push(...(await this._processReceipts(block, [...contractAddresses])))
    }
    return operations
  }

  async onReorg(_, block) {
    let operations = []
    let contracts = (await this.listContracts()).filter(contract => contract.height === block.height)
    for (let {address, height, txid} of contracts) {
      if (height === block.height) {
        operations.push(
          {type: 'del', key: this._encoding.encodeContractKey(address)},
          {type: 'del', key: this._encoding.encodeContractTransactionKey(address, height, txid)},
          {type: 'del', key: this._encoding.encodeTokenKey(address)}
        )
      }
    }
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        let output = tx.outputs[i]
        if (output.script.isContractCall()) {
          let address = output.script.chunks[4].buf.toString('hex')
          operations.push(
            {
              type: 'del',
              key: this._encoding.encodeContractTransactionKey(address, block.height, tx.id)
            },
            ...(await this._removeReceipts(tx))
          )
          if (output.satoshis) {
            operations.push({
              type: 'del',
              key: this._encoding.encodeContractUtxoKey(address, tx.id, i)
            })
          }
        }
      }
      for (let i = 0; i < tx.inputs.length; ++i) {
        if (tx.inputs[i].script.isContractSpend()) {
          operations.push(...(await this._removeInput(tx, i, block)))
        }
      }
    }
    return operations
  }

  static _getContractAddress(tx, index) {
    let indexBuffer = Buffer.alloc(4)
    indexBuffer.writeUInt32LE(index)
    return sha256ripemd160(Buffer.concat([
      BufferUtil.reverse(Buffer.from(tx.hash, 'hex')),
      indexBuffer
    ])).toString('hex')
  }

  async _createContract(tx, block, address) {
    if (await this.getContract(address)) {
      return []
    }
    let owner = await getInputAddress(tx.inputs[0], this._transaction, this._network)
    this._contractCache.set(address, {txid: tx.id, owner})
    let operations = [
      {
        type: 'put',
        key: this._encoding.encodeContractKey(address),
        value: this._encoding.encodeContractValue(block.height, tx.id, owner)
      },
      {
        type: 'put',
        key: this._encoding.encodeContractTransactionKey(address, block.height, tx.id)
      }
    ]
    try {
      let [{name}, {symbol}, {decimals}, {totalSupply}] = await Promise.all(
        ['name', 'symbol', 'decimals', 'totalSupply'].map(
          method => this._callMethod(address, tokenAbi, method)
        )
      )
      decimals = decimals.toNumber()
      this._tokenCache.set(address, {name, symbol, decimals, totalSupply})
      operations.push({
        type: 'put',
        key: this._encoding.encodeTokenKey(address),
        value: this._encoding.encodeTokenValue(name, symbol, decimals, totalSupply)
      })
    } catch (err) {}
    return operations
  }

  _processOutput(tx, index, block, address, utxoMap) {
    let output = tx.outputs[index]
    utxoMap.set(tx.id + ' ' + index, {
      address,
      height: block.height,
      satoshis: output.satoshis,
      timestamp: block.header.time
    })
    return [{
      type: 'put',
      key: this._encoding.encodeContractUtxoKey(address, tx.id, index),
      value: this._encoding.encodeContractUtxoValue(
        block.height, output.satoshis, block.header.time
      )
    }]
  }

  async _processInput(tx, index, block, utxoMap) {
    let input = tx.inputs[index]
    let key = input.prevTxId.toString('hex') + ' ' + input.outputIndex
    let utxoValue = utxoMap.get(key)
    if (utxoValue) {
      utxoMap.delete(key)
    } else {
      let transaction = await this._transaction.getTransaction(input.prevTxId.toString('hex'))
      let output = transaction.outputs[input.outputIndex]
      utxoValue = {
        address: output.script.chunks[4].buf.toString('hex'),
        height: transaction.height,
        satoshis: output.satoshis,
        timestamp: block.header.time
      }
    }
    return [
      {
        type: 'del',
        key: this._encoding.encodeContractUtxoKey(
          utxoValue.address, input.prevTxId, input.outputIndex
        )
      },
      {
        type: 'put',
        key: this._encoding.encodeContractUsedUtxoKey(
          utxoValue.address, input.prevTxId, input.outputIndex
        ),
        value: this._encoding.encodeContractUsedUtxoValue(
          utxoValue.height, utxoValue.satoshis, utxoValue.timestamp, tx.id, block.height
        )
      }
    ]
  }

  async _removeInput(tx, index, block) {
    let input = tx.inputs[index]
    let _tx = await this._transaction.getTransaction(input.prevTxId)
    let address = _tx.outputs[input.outputIndex].script.chunks[4].buf.toString('hex')
    return [
      {
        type: 'put',
        key: this._encoding.encodeContractUtxoKey(address, _tx.id, input.outputIndex),
        value: this._encoding.encodeContractUtxoValue(
          _tx.__height,
          _tx.outputs[input.outputIndex].satoshis,
          _tx.__timestamp
        )
      },
      {
        type: 'del',
        key: this._encoding.encodeContractUsedUtxoKey(address, _tx.id, input.outputIndex)
      }
    ]
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

  async _processReceipts(block, addresses) {
    if (!block.height) {
      return []
    }
    let operations = []
    let list = await this._client.searchLogs(block.height, block.height, JSON.stringify({addresses}))
    for (let {transactionHash, contractAddress, log} of list) {
      for (let i = 0; i < log.length; ++i) {
        let {address, topics, data} = log[i]
        operations.push({
          type: 'put',
          key: this._encoding.encodeEventLogKey(transactionHash, i),
          value: this._encoding.encodeEventLogValue(address, topics, data)
        })
        if (address !== contractAddress) {
          let transaction = block.transactions.find(tx => tx.hash === transactionHash)
          operations.push(...(await this._createContract(transaction, block, address)))
        }
        if ([TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn].includes(topics[0])) {
          let token = await this.getToken(address)
          if (!token) {
            continue
          }
          let {totalSupply} = await this._callMethod(address, tokenAbi, 'totalSupply')
          token.totalSupply = totalSupply
          operations.push({
            type: 'put',
            key: this._encoding.encodeTokenKey(contractAddress),
            value: this._encoding.encodeTokenValue(
              token.name, token.symbol, token.decimals, token.totalSupply
            )
          })
        }
      }
    }
    return operations
  }

  _removeReceipts(tx) {
    return new Promise((resolve, reject) => {
      let results = []
      let start = this._encoding.encodeEventLogKey(tx.id, 0)
      let end = Buffer.concat([start.slice(0, -4), Buffer.alloc(4, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(results))
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        results.push({type: 'del', key: data.key})
      })
    })
  }

  _getContractTxidHistory(address) {
    return new Promise((resolve, reject) => {
      let list = []
      let start = this._encoding.encodeContractTransactionKey(address)
      let end = Buffer.concat([start.slice(0, -36), Buffer.alloc(36, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(list))
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        let {height, txid} = this._encoding.decodeContractTransactionKey(data.key)
        list.push({height, txid})
      })
    })
  }
}

module.exports = ContractService
