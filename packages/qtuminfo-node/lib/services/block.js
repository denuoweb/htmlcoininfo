const assert = require('assert')
const LRU = require('lru-cache')
const qtuminfo = require('qtuminfo-lib')
const BaseService = require('../service')
const Block = require('../models/block')
const Header = require('../models/header')
const utils = require('../utils')
const {
  getTarget, getDifficulty, convertSecondsToHumanReadable,
  AsyncQueue, IndeterminateProgressBar,
  toRawBlock
} = utils
const {QTUM_GENESIS_HASH, QTUM_GENESIS_BLOCK_HEX} = require('../constants')

class BlockService extends BaseService {
  constructor(options) {
    super(options)
    this._subscriptions = {block: []}
    this._tip = null
    this._db = this.node.services.get('db')
    this._p2p = this.node.services.get('p2p')
    this._header = this.node.services.get('header')
    this._network = this.node.network
    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
    this._mempool = this.node.services.get('mempool')
    this.GENESIS_HASH = QTUM_GENESIS_HASH[this._network]
    this.GENESIS_BLOCK_HEX = QTUM_GENESIS_BLOCK_HEX[this._network]
    this._initialSync = false
    this._processingBlock = false
    this._blocksInQueue = 0
    this._recentBlockHashesCount = options.recentBlockHashesCount || 144
    this._recentBlockHashes = new LRU(this._recentBlockHashesCount)
    this._readAheadBlockCount = options.readAheadBlockCount || 2
    this._pauseSync = options.pause
    this._reorgToBlock = options.reorgToBlock
  }

  static get dependencies() {
    return ['db', 'header', 'mempool', 'p2p']
  }

  subscribe(name, emitter) {
    let subscription = this._subscriptions[name]
    subscription.push(emitter)
    this.node.log.info(
      emitter.remoteAddress,
      'subscribe:', 'block/' + name,
      'total:', subscription.length
    )
  }

  unsubscribe(name, emitter) {
    let subscription = this._subscriptions[name]
    let index = subscription.indexOf(emitter)
    if (index >= 0) {
      subscription.splice(index, 1)
      this.node.log.info(
        emitter.remoteAddress,
        'subscribe:', 'block/' + name,
        'total:', subscription.length
      )
    }
  }

  get publishEvents() {
    return [{
      name: 'block/block',
      subscribe: this.subscribe.bind(this, 'block'),
      unsubscribe: this.unsubscribe.bind(this, 'block')
    }]
  }

  get APIMethods() {
    return [
      ['getInfo', this.getInfo.bind(this), 0],
      ['getBlock', this.getBlock.bind(this), 1],
      ['getBlockOverview', this.getBlockOverview.bind(this), 1],
      ['getBestBlockHash', this.getBestBlockHash.bind(this), 0],
      ['syncPercentage', this.syncPercentage.bind(this), 0],
      ['isSynced', this.isSynced.bind(this), 0]
    ]
  }

  getInfo() {
    return {
      blocks: this.getTip().height,
      connections: this._p2p.getNumberOfPeers(),
      timeoffset: 0,
      proxy: '',
      testnet: this._network !== 'livenet',
      errors: '',
      network: this._network,
      relayFee: 0,
      version: '',
      protocolversion: 70016,
      difficulty: this._header.getCurrentDifficulty()
    }
  }

  isSynced() {
    return !this._initialSync
  }

  getBestBlockHash() {
    return this._header.getLastHeader().hash
  }

  getTip() {
    return this._tip
  }

  async getBlock(arg) {
    let block
    if (Number.isInteger(arg)) {
      block = await Block.findOne({height: arg})
    } else {
      block = await Block.findOne({hash: arg})
    }
    if (block) {
      let nextBlock = await Block.findOne({height: block.height + 1})
      if (nextBlock) {
        block.nextHash = nextBlock.hash
      }
    }
    return block
  }

  async getBlockOverview(hash) {
    let block = await Block.findOne({hash})
    if (!block) {
      return
    }
    let target = getTarget(block.bits)
    let difficulty = getDifficulty(target)
    return {
      hash: block.hash,
      version: block.version,
      confirmations: this.getTip().height - header.height + 1,
      height: block.height,
      prevHash: block.prevHash,
      nextHash: block.nextHash,
      merkleRoot: block.merkleRoot,
      timestamp: block.timestamp,
      nonce: block.nonce,
      bits: block.bits,
      difficulty,
      hashStateRoot: block.hashStateRoot,
      hashUTXORoot: block.hashUTXORoot,
      prevOutStakeHash: block.prevOutStakeHash,
      prevOutStakeN: block.prevOutStakeN,
      vchBlockSig: block.vchBlockSig,
      chainwork: block.chainwork,
      txids: block.transactions
    }
  }

  async _checkTip() {
    this.node.log.info('Block Service: checking the saved tip...')
    let header = (await this._header.getBlockHeader(this._tip.height)) || this._header.getLastHeader()
    if (header.hash === this._tip.hash && !this._reorgToBlock) {
      this.node.log.info('Block Service: saved tip is good to go.')
    }
    await this._handleReorg()
  }

  async _resetTip() {
    if (!this._tipResetNeeded) {
      return
    }
    this._tipResetNeeded = false
    let bar = new IndeterminateProgressBar()
    this.node.log.warn('Block Service: resetting tip due to a non-existent tip block...')
    let header = this._header.getLastHeader()
    let height = header.height
    this.node.log.info('Block Service: retrieved all the headers for lookups.')
    let block
    do {
      block = await Block.findOne({hash: header.hash})
      if (!block) {
        this.node.log.debug('Block Service: block:', header.hash, 'was not found, proceeding to older blocks.')
      }
      header = await Block.findOne({height: --height})
      assert(header, 'Header not found for reset')
      if (!block) {
        this.node.log.debug('Block Service: trying block:', header.hash)
      }
      if (process.stdout.isTTY) {
        bar.tick()
      }
    } while (!block)
    await this._setTip({hash: block.hash, height: height + 1})
  }

  async _performSanityCheck(tip) {
    if (tip.height === 0) {
      return tip
    }
    if (await Block.findOne({hash: tip.hash})) {
      return tip
    }
  }

  async start() {
    let tip = await this._db.getServiceTip('block')
    tip = await this._performSanityCheck(tip)
    this._blockProcessor = new AsyncQueue(this._onBlock.bind(this))
    this._bus = this.node.openBus({remoteAddress: 'localhost-block'})
    if (!tip) {
      this._tipResetNeeded = true
      return
    }
    await Block.remove({height: {$gt: tip.height}})
    this._header.on('reorg', () => this._reorging = true)
    this._header.on('reorg complete', () => this._reorging = false)
    await this._setTip(tip)
    await this._loadRecentBlockHashes()
  }

  async _loadRecentBlockHashes() {
    let hash = this._tip.hash
    let times = Math.min(this._tip.height, this._recentBlockHashesCount)
    for (let i = 0; i < times; ++i) {
      let block = await this.getBlock(hash)
      assert(block, 'Block Service: attempted to retrive block: ' + hash + ' but was not in the index.')
      this._recentBlockHashes.set(hash, block.prevHash)
      hash = block.prevHash
    }
    assert(
      this._recentBlockHashes.length === times,
      'Block Service: did not load enouth recent block hashes from the index.'
    )
    this.node.log.info('Block Service: loaded:', this._recentBlockHashes.length, 'hashes from the index.')
  }

  async _getTimeSinceLastBlock() {
    let header = await Block.findOne({height: Math.max(this._tip.height - 1, 0)}, 'timestamp')
    assert(header, 'Block Service: we should have a header in order to get time since last block.')
    let tip = await Block.findOne({hash: this._tip.hash}, 'timestamp')
    return convertSecondsToHumanReadable(tip.timestamp - header.timestamp)
  }

  _queueBlock(block) {
    ++this._blocksInQueue
    this._blockProcessor.push(block, err => {
      if (err) {
        this._handleError(err)
      } else {
        this._logSynced(block.hash)
        --this._blocksInQueue
      }
    })
  }

  syncPercentage() {
    let height = this._header.getLastHeader().height
    let ratio = this._tip.height / height
    return (ratio * 100).toFixed(2)
  }

  _detectReorg(block) {
    return Buffer.from(block.prevBlock, 'hex').reverse().toString('hex') !== this._tip.hash
  }

  async _getHash(blockArg) {
    if (Number.isInteger(blockArg)) {
      let header = await this._header.getBlockHeader(blockArg)
      if (header) {
        return header.hash
      }
    } else {
      return blockArg
    }
  }

  async onReorg(_, block) {
    await Block.remove({height: block.height})
  }

  async _onReorg(commonAncestorHash, block) {
    for (let service of this.node.services.values()) {
      if (service.onReorg) {
        this.node.log.info('Block Service: Reorging', service.name, 'service.')
        await service.onReorg(commonAncestorHash, block)
      }
    }
  }

  _removeAllSubscriptions() {
    this._bus.unsubscribe('p2p/block')
    this._bus.removeAllListeners()
    this.removeAllListeners()
    this._subscribedBlock = false
    if (this._reportInterval) {
      clearInterval(this._reportInterval)
    }
    if (this._getBlocksTimer) {
      clearTimeout(this._getBlocksTimer)
    }
  }

  onHeaders() {
    if (this._pauseSync) {
      this.node.log.warn('Block Service: pausing sync due to config option.')
    } else {
      this._initialSync = true
      return new Promise((resolve, reject) => {
        let interval = setInterval(() => {
          if (!this._processingBlock) {
            clearInterval(interval)
            resolve(this._onHeaders())
          }
        }, 1000)
      })
    }
  }

  async _onHeaders() {
    await this._resetTip()
    return new Promise((resolve, reject) => {
      let interval = setInterval(async () => {
        if (this._blocksInQueue === 0) {
          clearInterval(interval)
          this._removeAllSubscriptions()
          try {
            await this._checkTip()
            this._reorging = false
            await this._startSync()
            resolve()
          } catch (err) {
            reject(err)
          }
        }
      }, 1000)
    })
  }

  _startBlockSubscription() {
    if (this._subscribedBlock) {
      return
    }
    this._subscribedBlock = true
    this.node.log.info('Block Service: starting p2p block subscription.')
    this._bus.on('p2p/block', this._queueBlock.bind(this))
    this._bus.subscribe('p2p/block')
  }

  async _findLatestValidBlockHeader() {
    if (this._reorgToBlock) {
      let header = await this._header.getBlockHeader(this._reorgToBlock)
      if (!header) {
        throw new Error('Block Service: header not found to reorg to.')
      }
      return header
    }
    let blockServiceHash = this._tip.hash
    let blockServiceHeight = this._tip.height
    let header
    for (let i = 0; i <= this._recentBlockHashes.length; ++i) {
      let _header = await this._header.getBlockHeader(blockServiceHash)
      let hash = blockServiceHash
      let height = blockServiceHeight--
      blockServiceHash = this._recentBlockHashes.get(hash)
      if (_header && _header.hash === hash && _header.height === height) {
        header = _header
        break
      }
    }
    assert(
      header,
      'Block Service: we could not locate any of our recent block hashes in the header service index. '
        + 'Perhaps our header service sync\'ed to the wrong chain?'
    )
    assert(
      header.height <= this._tip.height,
      'Block Service: we found a common ancestor header whose height was greater than our current tip. '
        + 'This should be impossible.'
    )
    return header
  }

  async _findBlocksToRemove(commonHeader) {
    let {hash, height} = this._tip
    let blocks = []
    for (let i = 0; i < this._recentBlockHashes.length && hash !== commonHeader.hash; ++i) {
      let block = await Block.findOne({hash})
      assert(block, 'Block Service: block not found in index.')
      block = await toRawBlock(block)
      block.height = height
      block.header.time = block.header.timestamp = block.timestamp
      blocks.push(block)
      hash = Buffer.from(block.prevBlock, 'hex').reverse().toString('hex')
      --height
    }
    return blocks
  }

  async _handleReorg() {
    this._p2p.clearInventoryCache()
    let commonAncestorHeader = await this._findLatestValidBlockHeader()
    if (commonAncestorHeader.hash === this._tip.hash) {
      return
    }
    let blocksToRemove = await this._findBlocksToRemove(commonAncestorHeader)
    assert(
      blocksToRemove.length > 0 && blocksToRemove.length <= this._recentBlockHashes.length,
      'Block Service: the number of blocks to remove looks to be incorrect.'
    )
    this.node.log.warn(
      'Block Service: chain reorganization detected, current height/hash:',
      this._tip.height + '/' + this._tip.hash,
      'common ancestor hash:', commonAncestorHeader.hash,
      'at height:', commonAncestorHeader.height,
      'There are:', blocksToRemove.length, 'block(s) to remove.'
    )
    await this._setTip({hash: commonAncestorHeader.hash, height: commonAncestorHeader.height})
    await this._processReorg(commonAncestorHeader, blocksToRemove)
  }

  async _processReorg(commonAncestorHeader, blocksToRemove) {
    let operations = []
    let blockCount = 0
    let bar = new IndeterminateProgressBar()
    for (let block of blocksToRemove) {
      if (process.stdout.isTTY) {
        bar.tick()
      }
      await this._onReorg(commonAncestorHeader.hash, block)
      ++blockCount
      this._recentBlockHashes.del(block.hash)
    }
    this.node.log.info('Block Service: removed', blockCount, 'block(s) during the reorganization event.')
  }

  async _onBlock(block) {
    if (this._reorging) {
      this._processingBlock = false
      return
    }
    this._processingBlock = true
    try {
      let _block = await Block.findOne({hash: block.hash})
      if (_block) {
        this._processingBlock = false
        this.node.log.debug('Block Service: not syncing, block already in database.')
      } else {
        return await this._processBlock(block)
      }
    } catch (err) {
      this._processingBlock = false
      this._handleError(err)
    }
  }

  async _processBlock(block) {
    if (this.node.stopping) {
      this._processingBlock = false
      return
    }
    this.node.log.debug('Block Service: new block:', block.hash)
    if (!this._detectReorg(block)) {
      await this._saveBlock(block)
    } else {
      this._processingBlock = false
    }
  }

  async _saveBlock(block) {
    if (!('height' in block)) {
      block.height = this._tip.height + 1
    }
    try {
      for (let service of this.node.services.values()) {
        if (service.onBlock) {
          await service.onBlock(block)
        }
      }
      await this.__onBlock(block)
      this._recentBlockHashes.set(
        block.hash,
        Buffer.from(block.prevBlock, 'hex').reverse().toString('hex')
      )
      await this._setTip({hash: block.hash, height: block.height})
      this._processingBlock = false
      for (let subscription of this._subscriptions.block) {
        subscription.emit('block/block', block)
      }
    } catch (err) {
      this._processingBlock = false
      throw err
    }
  }

  _handleError(err) {
    if (!this.node.stopping) {
      this.node.log.error('Block Service: handle error', err)
      this.node.stop()
    }
  }

  async _syncBlock(block) {
    clearTimeout(this._getBlocksTimer)
    if (this._lastBlockSaved === block.hash) {
      this._processingBlock = false
      return
    }
    try {
      await this._saveBlock(block)
      this._lastBlockSaved = block.hash
      if (this._tip.height < this._header.getLastHeader().height) {
        this.emit('next block')
      } else {
        this.emit('synced')
      }
    } catch (err) {
      this._handleError(err)
    }
  }

  async __onBlock(block) {
    let header
    do {
      header = await Header.findOne({hash: block.hash})
    } while (!header)
    return new Block({
      hash: header.hash,
      height: header.height,
      version: header.version,
      prevHash: header.prevHash,
      merkleRoot: header.merkleRoot,
      timestamp: header.timestamp,
      bits: header.bits,
      nonce: header.nonce,
      hashStateRoot: header.hashStateRoot,
      hashUTXORoot: header.hashUTXORoot,
      prevOutStakeHash: header.prevOutStakeHash,
      prevOutStakeN: header.prevOutStakeN,
      vchBlockSig: header.vchBlockSig,
      chainwork: header.chainwork,
      transactions: block.transactions.map(tx => tx.id)
    }).save()
  }

  async _setTip(tip) {
    this.node.log.debug('Block Service: Setting tip to height:', tip.height)
    this.node.log.debug('Block Service: Setting tip to hash:', tip.hash)
    this._tip = tip
    await this._db.updateServiceTip(this.name, tip)
  }

  async _logSynced() {
    if (this._reorging) {
      return
    }
    try {
      let diff = await this._getTimeSinceLastBlock()
      this.node.log.info(
        'Block Service: The best block hash is:', this._tip.hash,
        'at height:', this._tip.height + '.',
        'Time between the last 2 blocks (adjusted):', diff
      )
    } catch (err) {
      this._handleError(err)
    }
  }

  _onSynced() {
    if (this._reportInterval) {
      clearInterval(this._reportInterval)
    }
    this._logProgress()
    this._initialSync = false
    this._startBlockSubscription()
    this._logSynced(this._tip.hash)
    this._mempool.enable()
  }

  async _startSync() {
    let numNeeded = Math.max(this._header.getLastHeader().height - this._tip.height, 0)
    this.node.log.info('Block Service: Gathering:', numNeeded, 'block(s) from the peer-to-peer network.')
    if (numNeeded > 0) {
      this.on('next block', this._sync.bind(this))
      this.on('synced', this._onSynced.bind(this))
      clearInterval(this._reportInterval)
      if (this._tip.height === 0) {
        let genesisBlock = new qtuminfo.Block(Buffer.from(this.GENESIS_BLOCK_HEX, 'hex'))
        genesisBlock.height = 0
        await this._saveBlock(genesisBlock)
      }
      this._reportInterval = setInterval(this._logProgress.bind(this), 5000)
      this._reportInterval.unref()
      await this._sync()
    } else {
      this._onSynced()
    }
  }

  async _sync() {
    if (this.node.stopping || this._reorging) {
      return
    }
    this._processingBlock = true
    this.node.log.debug('Block Service: querying header service for next block using tip:', this._tip.hash)
    try {
      let {targetHash, endHash} = await this._header.getEndHash(this._tip, this._readAheadBlockCount)
      if (!targetHash && !endHash) {
        this._processingBlock = false
        this.emit('synced')
      } else {
        this._p2p.clearInventoryCache()
        this._getBlocksTimer = setTimeout(() => {
          this.node.log.debug('Block Service: block timeout, emitting for next block')
          this._processingBlock = false
          if (!this._reorging) {
            this.emit('next block')
          }
        }, 5000)
        this._getBlocksTimer.unref()
        let block = await this._p2p.getP2PBlock({
          filter: {startHash: this._tip.hash, endHash},
          blockHash: targetHash
        })
        await this._syncBlock(block)
      }
    } catch (err) {
      if (err) {
        this._processingBlock = false
        this._handleError(err)
      }
    }
  }

  _logProgress() {
    if (!this._initialSync) {
      return
    }
    let bestHeight = Math.max(this._header.getBestHeight(), this._tip.height)
    let progress = bestHeight === 0 ? 0 : (this._tip.height / bestHeight * 100).toFixed(4)
    this.node.log.info(
      'Block Service: download progress:',
      this._tip.height + '/' + bestHeight,
      `(${progress}%)`
    )
  }
}

module.exports = BlockService
