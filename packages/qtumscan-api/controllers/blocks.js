const LRU = require('lru-cache')
const Block = require('qtumscan-node/lib/models/block')
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
      let blockBuffer = (await this._block.toRawBlock(block)).toBuffer()
      ctx.rawBlock = {rawBlock: blockBuffer.toString('hex')}
      await next()
    } catch (err) {
      this.errorResponse.handleErrors(ctx, err)
    }
  }

  async transformBlock(block) {
    let rawBlock = await this._block.toRawBlock(block)
    let blockBuffer = rawBlock.toBuffer()
    let blockHashBuffer = rawBlock.toHashBuffer()
    let {reward, minedBy, duration} = await this.getBlockReward(block, rawBlock)
    return {
      hash: block.hash,
      size: blockBuffer.length,
      weight: blockBuffer.length + blockHashBuffer.length * 3,
      height: block.height,
      version: block.version,
      merkleRoot: block.merkleRoot,
      tx: block.transactions,
      timestamp: block.timestamp,
      nonce: block.nonce,
      bits: block.bits.toString(16),
      difficulty: rawBlock.header.getDifficulty(),
      chainWork: block.chainwork,
      confirmations: this._block.getTip().height - block.height + 1,
      previousBlockHash: block.prevHash,
      nextBlockHash: block.nextHash,
      reward,
      minedBy,
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
    let rawBlock = await this._block.toRawBlock(block)
    let {reward, minedBy, duration} = await this.getBlockReward(block, rawBlock)
    let summary = {
      hash: block.hash,
      height: block.height,
      size: rawBlock.toBuffer().length,
      timestamp: block.timestamp,
      txLength: block.transactions.length,
      reward,
      minedBy,
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
      let blocks = await Block.aggregate(
        {$match: {timestamp: {$lte: lte, $gte: gte}}},
        {$sort: {height: -1}},
        {$limit: limit},
      )
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

  async getBlockReward(block, rawBlock) {
    let minedBy, duration
    let reward = 0
    if (rawBlock.header.isProofOfStake()) {
      let transaction = await this._transaction.getTransaction(block.transactions[1])
      reward = -transaction.feeSatoshis
      minedBy = transaction.outputs[1].address
    } else {
      let transaction = await this._transaction.getTransaction(block.transactions[0])
      reward = transaction.outputSatoshis
      minedBy = transaction.outputs[0].address
    }
    let prevHash = block.prevHash
    if (prevHash !== '0'.repeat(64)) {
      let prevBlockHeader = await this._header.getBlockHeader(prevHash)
      duration = block.timestamp - prevBlockHeader.timestamp
    }
    return {reward, minedBy, duration}
  }
}

exports = module.exports = BlocksController
exports.DEFAULT_BLOCK_CACHE_SIZE = DEFAULT_BLOCK_CACHE_SIZE
