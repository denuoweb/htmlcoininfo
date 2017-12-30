const LRU = require('lru-cache')
const {Block} = require('qtumscan-lib')
const {ErrorResponse} = require('../components/utils')

const BLOCK_LIMIT = 200
const DEFAULT_BLOCKSUMMARY_CACHE_SIZE = 1000000
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
    blockSummaryCacheSize = DEFAULT_BLOCKSUMMARY_CACHE_SIZE,
    blockCacheSize = DEFAULT_BLOCK_CACHE_SIZE
  }) {
    this.node = node
    this.blockSummaryCache = LRU(blockSummaryCacheSize)
    this.blockCache = LRU(blockCacheSize)
    this.errorResponse = new ErrorResponse({log: this.node.log})
    this._block = this.node.services.get('block')
    this._header = this.node.services.get('header')
    this._timestamp = this.node.services.get('timestamp')
    this._transaction = this.node.services.get('transaction')
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

        let info = await this._header.getBlockHeader(hash)
        let blockResult = await this.transformBlock(block, info)
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
      let blockBuffer = await this.node.getRawBlock(blockHash)
      ctx.rawBlock = {rawBlock: blockBuffer.toString('hex')}
      await next()
    } catch (err) {
      if ([-5, -8].includes(err.code)) {
        ctx.throw(404)
      } else {
        this.errorResponse.handleErrors(ctx, err)
      }
    }
  }

  static normalizePrevHash(hash) {
    return hash !== '0'.repeat(64) ? hash : null
  }

  async transformBlock(block, info) {
    let blockObj = block.toObject()
    let {reward, minedBy, duration} = await this.getBlockReward(block)
    let blockBuffer = block.toBuffer()
    let blockHashBuffer = block.toHashBuffer()
    return {
      hash: block.hash,
      size: blockBuffer.length,
      weight: blockBuffer.length + blockHashBuffer.length * 3,
      height: info.height,
      version: blockObj.header.version,
      merkleRoot: blockObj.header.merkleRoot,
      tx: block.transactions.map(tx => tx.id),
      time: blockObj.header.time,
      nonce: blockObj.header.nonce,
      bits: blockObj.header.bits.toString(16),
      difficulty: block.header.getDifficulty(),
      chainWork: info.chainWork,
      confirmations: this._block.getTip().height - info.height + 1,
      previousBlockHash: info.prevHash,
      nextBlockHash: info.nextHash,
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

  async _getBlockSummary(hash) {
    let summaryCache = this.blockSummaryCache.get(hash)
    if (summaryCache) {
      return summaryCache
    }
    let blockBuffer = await this._block.getRawBlock(hash)
    if (!blockBuffer) {
      return
    }
    let block = Block.fromBuffer(blockBuffer, 'hex')
    let header = await this._header.getBlockHeader(hash)
    if (!header) {
      return
    }

    let {reward, minedBy, duration} = await this.getBlockReward(block)
    let summary = {
      height: header.height,
      size: block.toBuffer().length,
      hash,
      time: header.timestamp,
      txLength: block.transactions.length,
      reward,
      minedBy,
      duration
    }
    let confirmations = this._block.getTip().height - header.height + 1
    if (confirmations >= BLOCK_CACHE_CONFIRMATIONS) {
        this.blockSummaryCache.set(hash, summary)
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
      let hashes = await this._timestamp.getBlockHashesByTimestamp(lte, gte, limit + 1)
      let blocks = []
      for (let hash of hashes) {
        if (blocks.length >= limit) {
          break
        }
        blocks.push(await this._getBlockSummary(hash))
      }
      let more = hashes.length > blocks.length
      ctx.body = {
        blocks: blocks,
        length: hashes.length,
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
    let minedBy, duration
    let reward = 0
    if (block.header.isProofOfStake()) {
      let transaction = block.transactions[1]
      await this._transaction.setTxMetaInfo(transaction)
      for (let output of transaction.outputs) {
        reward += output.satoshis
      }
      for (let value of transaction.__inputValues) {
        reward -= value
      }
      minedBy = transaction.outputs[1].script.toAddress().toString()
    } else {
      let transaction = block.transactions[0]
      for (let output of transaction.outputs) {
        reward += output.satoshis
      }
      minedBy = transaction.outputs[0].script.toAddress().toString()
    }
    let prevHash = block.header.toObject().prevHash
    if (prevHash !== '0'.repeat(64)) {
      let prevBlockHeader = await this._header.getBlockHeader(prevHash)
      duration = block.header.timestamp - prevBlockHeader.timestamp
    }
    return {reward, minedBy, duration}
  }
}

exports = module.exports = BlocksController
Object.assign(exports, {
  DEFAULT_BLOCKSUMMARY_CACHE_SIZE,
  DEFAULT_BLOCK_CACHE_SIZE
})
