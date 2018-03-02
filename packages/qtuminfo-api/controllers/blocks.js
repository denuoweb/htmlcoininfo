const LRU = require('lru-cache')
const {BN} = require('qtuminfo-lib').crypto
const Block = require('qtuminfo-node/lib/models/block')
const {toRawBlock} = require('qtuminfo-node/lib/utils')
const {ErrorResponse} = require('../components/utils')

const BLOCK_LIMIT = 200
const DEFAULT_BLOCK_CACHE_SIZE = 1000
const BLOCK_CACHE_CONFIRMATIONS = 6

function formatTimestamp(date) {
  let yyyy = date.getUTCFullYear().toString()
  let mm = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  let dd = date.getUTCDate().toString().padStart(2, '0')
  return yyyy + '-' + mm + '-' + dd
}

class BlocksController {
  constructor({
    node,
    blockCacheSize = DEFAULT_BLOCK_CACHE_SIZE
  }) {
    this.node = node
    this.blockCache = new LRU(blockCacheSize)
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._block = this.node.services.get('block')
    this._header = this.node.services.get('header')
    this._transaction = this.node.services.get('transaction')
    this._network = this.node.network
    if (this.node.network === 'livenet') {
      this._network = 'mainnet'
    } else if (this.node.network === 'regtest') {
      this._network = 'testnet'
    }
  }

  async checkBlockHash(ctx, next) {
    let hash = ctx.params.blockHash
    if (!/^[0-9A-Fa-f]{64}$/.test(hash)) {
      ctx.throw(404)
    }
    await next()
  }

  async block(ctx, next) {
    let hash = ctx.params.blockHash
    let blockCached = this.blockCache.get(hash)

    if (blockCached) {
      let height = this._block.getTip().height
      blockCached.confirmations = height - blockCached.height + 1
      ctx.block = blockCached
    } else {
      try {
        let block = await this._block.getBlock(hash)
        if (!block) {
          ctx.throw(404)
        }

        let blockResult = await this.transformBlock(block)
        if (blockResult.confirmations >= BLOCK_CACHE_CONFIRMATIONS) {
          this.blockCache.set(hash, blockResult)
        }
        ctx.block = blockResult
      } catch (err) {
        this.errorResponse.handleErrors(ctx, err)
      }
    }

    await next()
  }

  async rawBlock(ctx, next) {
    let blockHash = ctx.params.blockHash

    try {
      let block = await this._block.getBlock(blockHash)
      if (!block) {
        ctx.throw(404)
      }
      let blockBuffer = (await toRawBlock(block)).toBuffer()
      ctx.rawBlock = {rawBlock: blockBuffer.toString('hex')}
      await next()
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async transformBlock(block) {
    let {reward, duration} = await this.getBlockReward(block)
    return {
      hash: block.hash,
      height: block.height,
      version: block.version,
      size: block.size,
      weight: block.weight,
      merkleRoot: block.merkleRoot,
      tx: block.transactions,
      timestamp: block.timestamp,
      nonce: block.nonce,
      bits: block.bits.toString(16),
      difficulty: this._getDifficulty(block.bits),
      chainWork: block.chainwork,
      confirmations: this._block.getTip().height - block.height + 1,
      previousBlockHash: block.prevHash,
      nextBlockHash: block.nextHash,
      reward,
      minedBy: block.minedBy,
      duration,
      isMainChain: true
    }
  }

  async show(ctx) {
    if (ctx.block) {
      ctx.body = ctx.block
    }
  }

  async showRaw(ctx) {
    if (ctx.rawBlock) {
      ctx.body = ctx.rawBlock
    }
  }

  async blockIndex(ctx) {
    let height = Number.parseInt(ctx.params.height)
    try {
      let info = await this._header.getBlockHeader(height)
      if (!info) {
        ctx.throw(404)
      }
      ctx.body = {blockHash: info.hash}
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async _getBlockSummary(block) {
    let {reward, minedBy, duration} = await this.getBlockReward(block)
    let summary = {
      hash: block.hash,
      height: block.height,
      size: block.size,
      timestamp: block.timestamp,
      txLength: block.transactions.length,
      reward,
      minedBy: block.minedBy,
      duration
    }
    return summary
  }

  async list(ctx) {
    let todayStr = formatTimestamp(new Date())
    let dateStr = ctx.query.blockDate || todayStr
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      this.errorResponse.handleErrors(ctx, new Error('Please use yyyy-mm-dd format'))
    }
    let isToday = dateStr === todayStr
    let gte = Math.floor((new Date(dateStr)).getTime() / 1000)
    let lte = gte + 24 * 60 * 60 - 1
    let limit = Number.parseInt(ctx.query.limit) || BLOCK_LIMIT

    try {
      let blocks = await Block.find({timestamp: {$lte: lte, $gte: gte}}).sort({height: -1}).limit(limit)
      blocks = await Promise.all(blocks.map(block => this._getBlockSummary(block)))
      let count = await Block.find({timestamp: {$lte: lte, $gte: gte}}).count()
      let more = count > blocks.length
      ctx.body = {
        blocks,
        length: count,
        pagination: {
          currentTs: Math.floor(Date.now() / 1000),
          current: dateStr,
          isToday,
          more,
          moreTs: more ? blocks[blocks.length - 1].time - 1 : undefined
        }
      }
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async getBlockReward(block) {
    let duration
    let reward = 0
    if (block.prevOutStakeHash !== '0'.repeat(64) && block.prevOutStakeN !== 0xffffffff) {
      let transaction = await this._transaction.getTransaction(block.transactions[1])
      reward = -transaction.feeSatoshis
    } else {
      let transaction = await this._transaction.getTransaction(block.transactions[0])
      reward = transaction.outputSatoshis
    }
    let prevHash = block.prevHash
    if (prevHash !== '0'.repeat(64)) {
      let prevBlockHeader = await this._header.getBlockHeader(prevHash)
      duration = block.timestamp - prevBlockHeader.timestamp
    }
    return {reward, duration}
  }

  _getTargetDifficulty(bits) {
    let target = new BN(bits & 0xffffff)
    let mov = ((bits >>> 24) - 3) << 3
    while (mov--) {
      target = target.mul(new BN(2))
    }
    return target
  }

  _getDifficulty(bits) {
    let difficultyTargetBN = this._getTargetDifficulty(0x1d00ffff).mul(new BN(100000000))
    let currentTargetBN = this._getTargetDifficulty(bits)
    let difficultyString = difficultyTargetBN.div(currentTargetBN).toString(10)
    let decimalPos = difficultyString.length - 8
    difficultyString = difficultyString.slice(0, decimalPos) + '.' + difficultyString.slice(decimalPos)
    return Number.parseFloat(difficultyString)
  }
}

exports = module.exports = BlocksController
exports.DEFAULT_BLOCK_CACHE_SIZE = DEFAULT_BLOCK_CACHE_SIZE
