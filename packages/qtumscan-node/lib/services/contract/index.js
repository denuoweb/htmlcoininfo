const LRU = require('lru-cache')
const BN = require('bn.js')
const qtumscan = require('qtumscan-lib')
const QtumscanRPC = require('qtumscan-rpc')
const BaseService = require('../../service')
const Encoding = require('./encoding')
const {getAddress} = require('../../utils')
const BufferUtil = qtumscan.util.buffer
const {sha256ripemd160} = qtumscan.crypto.Hash
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
      port: 3889
    }
    this._client = new QtumscanRPC(this._config)
    this._contractCache = new LRU(1000)
    this._tokenCache = new LRU(1000)
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
      ['getTokenTransfers', this.getTokenTransfers.bind(this), 1]
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
      let token
      let list = []
      let start = this._encoding.encodeTokenTransferKey(txid, 0)
      let end = Buffer.concat([start.slice(0, -4), Buffer.alloc(4, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(token && {token, list}))
      utxoStream.on('error', reject)
      utxoStream.on('data', async data => {
        let {index} = this._encoding.decodeTokenTransferKey(data.key)
        let {address, from, to, amount} = this._encoding.decodeTokenTransferValue(data.value)
        if (from === '0'.repeat(34)) {
          from = null
        }
        if (!token) {
          token = await this.getToken(address)
          if (token) {
            token = Object.assign({address}, token)
          } else {
            resolve()
          }
        }
        list.push({from, to, amount})
      })
    })
  }

  async start() {
    this._prefix = await this._db.getPrefix(this.name)
    this._encoding = new Encoding(this._prefix)
  }

  async onBlock(block) {
    let operations = []
    let tokenAddresses = new Set()
    let utxoMap = new Map()
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        let output = tx.outputs[i]
        if (output.script.isContractCreate()) {
          operations.push(...(await this._processContractCreate(tx, i, block)))
        } else if (output.script.isContractCall()) {
          let address = tx.outputs[i].script.chunks[4].buf.toString('hex')
          if (await this.getToken(address)) {
            tokenAddresses.add(address)
          }
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
    if (tokenAddresses.size) {
      operations.push(...(await this._processTokenTransfers(block, [...tokenAddresses])))
    }
    return operations
  }

  async onReorg(_, block) {
    let operations = []
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        let output = tx.outputs[i]
        if (output.script.isContractCreate()) {
          operations.push(...(await this._removeContract(tx, i)))
        } else if (output.script.isContractCall()) {
          let address = output.script.chunks[4].buf.toString('hex')
          operations.push(
            {
              type: 'del',
              key: this._encoding.encodeContractTransactionKey(address, block.height, tx.id)
            },
            ...(await this._removeTokenTransfers(tx, block))
          )
          if (output.satoshis) {
            operations.push({
              type: 'del',
              key: this._encoding.encodeContractUtxoKey(address, tx.id, index)
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

  async _processContractCreate(tx, index, block) {
    if (tx.outputs[index].script.getData().length < 80) {
      return []
    }
    let address = ContractService._getContractAddress(tx, index)
    try {
      await this._client.callContract(address, '00')
    } catch (err) {
      return []
    }
    let owner = await getAddress(tx.inputs[0], this._transaction, this._network)
    this._contractCache.set(address, {txid: tx.id, owner})
    let operations = [
      {
        type: 'put',
        key: this._encoding.encodeContractKey(address),
        value: this._encoding.encodeContractValue(tx.id, owner)
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

  _removeContract(tx, index) {
    let address = ContractService._getContractAddress(tx, index)
    return [
      {type: 'del', key: this._encoding.encodeContractKey(address)},
      {type: 'del', key: this._encoding.encodeContractTransactionKey(address, block.height, tx.id)},
      {type: 'del', key: this._encoding.encodeTokenKey(address)}
    ]
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
      contract.encodeMethod(method).slice(2)
    )
    if (executionResult.excepted === 'None') {
      return contract.decodeMethod(method, '0x' + executionResult.output)
    } else {
      throw executionResult.excepted
    }
  }

  uint256toBN(data) {
    return new BN(data.slice(data.length - 64).replace(/^0+/, '') || '0', 16)
  }

  async _processTokenTransfers(block, tokens) {
    if (!block.height) {
      return []
    }
    let operations = []
    let list = await this._client.searchLogs(
      block.height, block.height,
      JSON.stringify({
        addresses: tokens,
        topics: [TOKEN_EVENTS.Transfer, TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn]
      })
    )
    for (let {transactionHash, contractAddress, log} of list) {
      let index = 0
      for (let {topics, data} of log) {
        if (topics[0] === TOKEN_EVENTS.Transfer) {
          let from = new Address(Buffer.from(topics[1].slice(24), 'hex'), this._network).toString()
          let to = new Address(Buffer.from(topics[2].slice(24), 'hex'), this._network).toString()
          let amount = new BN(this.uint256toBN(data), 16)
          operations.push({
            type: 'put',
            key: this._encoding.encodeTokenTransferKey(transactionHash, index++),
            value: this._encoding.encodeTokenTransferValue(contractAddress, from, to, amount)
          })
        } else if (topics[0] === TOKEN_EVENTS.Mint) {
          let token = await this.getToken(contractAddress)
          if (!token) {
            continue
          }
          let to = new Address(Buffer.from(topics[1].slice(24), 'hex'), this._network).toString()
          let amount = new BN(this.uint256toBN(data), 16)
          let {totalSupply} = await this._callMethod(contractAddress, tokenAbi, 'totalSupply')
          token.totalSupply = totalSupply
          operations.push(
            {
              type: 'put',
              key: this._encoding.encodeTokenKey(contractAddress),
              value: this._encoding.encodeTokenValue(
                token.name, token.symbol, token.decimals, token.totalSupply
              )
            },
            {
              type: 'put',
              key: this._encoding.encodeTokenTransferKey(transactionHash, index++),
              value: this._encoding.encodeTokenTransferValue(
                contractAddress, '0'.repeat(34), to, amount
              )
            }
          )
        } else if (topics[0] === TOKEN_EVENTS.Burn) {
          let token = await this.getToken(contractAddress)
          if (!token) {
            continue
          }
          let burner = new Address(Buffer.from(topics[1].slice(24), 'hex'), this._network).toString()
          let amount = new BN(this.uint256toBN(data), 16)
          let {totalSupply} = await this._callMethod(contractAddress, tokenAbi, 'totalSupply')
          token.totalSupply = totalSupply
          operations.push(
            {
              type: 'put',
              key: this._encoding.encodeTokenKey(contractAddress),
              value: this._encoding.encodeTokenValue(
                token.name, token.symbol, token.decimals, token.totalSupply
              )
            },
            {
              type: 'put',
              key: this._encoding.encodeTokenTransferKey(transactionHash, index++),
              value: this._encoding.encodeTokenTransferValue(
                contractAddress, burner, '0'.repeat(34), amount
              )
            }
          )
        }
      }
    }
    return operations
  }

  _removeTokenTransfers(tx, block) {
    return new Promise((resolve, reject) => {
      let results = []
      let start = this._encoding.encodeTokenTransferKey(tx.id, 0)
      let end = Buffer.concat([start.slice(0, -4), Buffer.alloc(4, 0xff)])
      let utxoStream = this._db.createReadStream({gte: start, lt: end})
      utxoStream.on('end', () => resolve(results))
      utxoStream.on('error', reject)
      utxoStream.on('data', data => {
        let {index} = this._encoding.decodeTokenTransferKey(data.key)
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
