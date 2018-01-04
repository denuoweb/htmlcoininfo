const LRU = require('lru-cache')
const BN = require('bn.js')
const qtumscan = require('qtumscan-lib')
const QtumscanRPC = require('qtumscan-rpc')
const BaseService = require('../../service')
const Encoding = require('./encoding')
const BufferUtil = qtumscan.util.buffer
const {sha256ripemd160, sha256sha256} = qtumscan.crypto.Hash
const {Contract, tokenABI} = qtumscan.contract
const Address = qtumscan.Address

const TOKEN_EVENTS = {
  Transfer: 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  Approval: '8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  Mint: '4e3883c75cc9c752bb1db2e406a822e4a75067ae77ad9a0a4d179f2709b9e1f6',
  TokenPurchase: '623b3804fa71d67900d064613da8f94b9617215ee90799290593e1745087ad18'
}
const TOKEN_EVENT_HASHES = Object.values(TOKEN_EVENTS)

class ContractService extends BaseService {
  constructor(options) {
    super(options)
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._network = this.node.network
    this._config = options.rpc || {
      user: 'qtum',
      pass: 'qtumpassword',
      host: 'localhost',
      protocol: 'http',
      port: 3889
    }
    this._client = new QtumscanRPC(this._config)
    this._tokenCache = new LRU(1000)
  }

  static get dependencies() {
    return ['block', 'db']
  }

  get APIMethods() {
    return [
      ['getToken', this.getToken.bind(this), 1],
      ['getTokenTransfers', this.getTokenTransfers.bind(this), 1]
    ]
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
        let {contract, from, to, amount} = this._encoding.decodeTokenTransferValue(data.value)
        if (from === '0'.repeat(34)) {
          from = null
        }
        if (!token) {
          token = await this.getToken(contract)
          if (token) {
            token = Object.assign({address: contract}, token)
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
    let contractAddresses = new Set()
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        let script = tx.outputs[i].script
        if (script.isContractCreate()) {
          operations.push(...(await this._processContract(tx, i, block)))
          break
        } else if (script.isContractCall()) {
          let address = script.chunks[4].buf.toString('hex')
          if (await this.getToken(address)) {
            operations.push({
              type: 'put',
              key: this._encoding.encodeTokenTransactionKey(address, block.height, tx.id)
            })
            contractAddresses.add(address)
          }
          break
        }
      }
    }
    if (contractAddresses.size) {
      operations.push(...(await this._processTokenTransfers(block, [...contractAddresses])))
    }
    return operations
  }

  async onReorg(_, block) {
    let operations = []
    for (let tx of block.transactions) {
      for (let i = 0; i < tx.outputs.length; ++i) {
        let script = tx.outputs[i].script
        if (script.isContractCreate()) {
          operations.push(...(await this._removeContract(tx, i)))
          break
        } else if (script.isContractCall()) {
          let address = script.chunks[4].buf.toString('hex')
          operations.push(
            {
              type: 'del',
              key: this._encoding.encodeTokenTransactionKey(address, block.height, tx.id)
            },
            ...(await this._removeTokenTransfers(tx, block))
          )
        }
      }
    }
    return operations
  }

  _getContractAddress(tx, index) {
    let indexBuffer = Buffer.alloc(4)
    indexBuffer.writeUInt32LE(index)
    return sha256ripemd160(Buffer.concat([
      BufferUtil.reverse(Buffer.from(tx.hash, 'hex')),
      indexBuffer
    ])).toString('hex')
  }

  async _processContract(tx, index, block) {
    if (tx.outputs[index].script.getData().length < 80) {
      return []
    }
    let address = this._getContractAddress(tx, index)
    let contract = new Contract(tokenABI)
    try {
      let [{name}, {symbol}, {decimals}, {totalSupply}] = await Promise.all(
        ['name', 'symbol', 'decimals', 'totalSupply'].map(
          method => this._callMethod(address, contract, method)
        )
      )
      return [
        {
          type: 'put',
          key: this._encoding.encodeTokenKey(Buffer.from(address, 'hex')),
          value: this._encoding.encodeTokenValue(name, symbol, decimals.toNumber(), totalSupply)
        },
        {type: 'put', key: this._encoding.encodeTokenTransactionKey(address, block.height, tx.id)}
      ]
    } catch (err) {
      return []
    }
  }

  _removeContract(tx, index) {
    let address = this._getContractAddress(tx, index)
    return [
      {type: 'del', key: this._encoding.encodeTokenKey(Buffer.from(address, 'hex'))},
      {type: 'del', key: this._encoding.encodeTokenTransactionKey(address, block.height, tx.id)}
    ]
  }

  async _callMethod(address, contract, method, ...args) {
    let {executionResult} = await this._client.callContract(address, contract.encodeMethod(method).slice(2))
    if (executionResult.excepted === 'None') {
      return contract.decodeMethod(method, '0x' + executionResult.output)
    } else {
      throw executionResult.excepted
    }
  }

  uint256toBN(data) {
    return new BN(data.slice(data.length - 64).replace(/^0+/, '') || '0', 16)
  }

  async _processTokenTransfers(block, contracts) {
    if (!block.height) {
      return []
    }
    let operations = []
    let list = await this._client.searchLogs(
      block.height, block.height,
      JSON.stringify({
        addresses: contracts,
        topics: [TOKEN_EVENTS.Transfer, TOKEN_EVENTS.Mint]
      })
    )
    for (let {transactionHash, contractAddress, log: logs} of list) {
      let index = 0
      for (let {topics, data} of logs) {
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
          let to = new Address(Buffer.from(topics[1].slice(24), 'hex'), this._network).toString()
          let amount = new BN(this.uint256toBN(data), 16)
          let {totalSupply} = await this._callMethod(contractAddress, new Contract(tokenABI), 'totalSupply')
          token.totalSupply = totalSupply
          operations.push(
            {
              type: 'put',
              key: this._encoding.encodeTokenKey(contractAddress),
              value: this._encoding.encodeTokenValue(token.name, token.symbol, token.decimals, token.totalSupply)
            },
            {
              type: 'put',
              key: this._encoding.encodeTokenTransferKey(transactionHash, index++),
              value: this._encoding.encodeTokenTransferValue(
                contractAddress, '0'.repeat(34), to, amount
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
      utxoStream.on('data', async data => {
        let {index} = this._encoding.decodeTokenTransferKey(data.key)
        results.push({type: 'del', key: data.key})
      })
    })
  }
}

module.exports = ContractService
