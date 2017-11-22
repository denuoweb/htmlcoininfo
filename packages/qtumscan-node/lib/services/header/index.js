const assert = require('assert')
const BN = require('bn.js')
const BaseService = require('../../service')
const {QTUM_GENESIS_HASH} = require('../../constants')
const {encodeTip, AsyncQueue} = require('../../utils')
const Encoding = require('./encoding')

function fromCompact(compact) {
  if (compact === 0) {
    return new BN(0)
  }
  let exponent = compact >>> 24
  let negative = (compact >>> 23) & 1
  let mantissa = compact & 0x7fffff
  let num
  if (exponent <= 3) {
    mantissa >>>= 8 * (3 - exponent)
    num = new BN(mantissa)
  } else {
    num = new BN(mantissa)
    num.iushln(8 * (exponent - 3))
  }
  if (negative) {
    num.ineg()
  }
  return num
}

function getTarget(bits) {
  let target = fromCompact(bits)
  assert(!target.isNeg(), 'Target is negative.')
  assert(!target.isZero(), 'Target is zero.')
  return target.toArrayLike(Buffer, 'le', 32);
}

function double256(target) {
  assert(target.length === 32)
  let hi = target.readUInt32LE(28, true)
  let lo = target.readUInt32LE(24, true)
  let n = (hi * 2 ** 32 + lo) * 2 ** 192
  hi = target.readUInt32LE(20, true)
  lo = target.readUInt32LE(16, true)
  n += (hi * 2 ** 32 + lo) * 2 ** 128
  hi = target.readUInt32LE(12, true)
  lo = target.readUInt32LE(8, true)
  n += (hi * 2 ** 32 + lo) * 2 ** 64
  hi = target.readUInt32LE(4, true)
  lo = target.readUInt32LE(0, true)
  return n + hi * 2 ** 32 + lo
}

function getDifficulty(target) {
  let d = 2 ** 224 - 2 ** 208
  let n = common.double256(target)
  return n === 0 ? d : Math.floor(d / n)
}

function revHex(data) {
  let buffer = []
  for (let i = 0; i < data.length; i += 2) {
    buffer.push(data.slice(i, i + 2))
  }
  return buffer.reverse().join('')
}

const MAX_CHAINWORK = new BN(1).ushln(256)
const STARTING_CHAINWORK = '0'.repeat(52) + '0001'.repeat(3)

class HeaderService extends BaseService {
  constructor(options) {
    super(options)
    this._tip = null
    this._p2p = this.node.services.get('p2p')
    this._db = this.node.services.get('db')
    this._hashes = []
    this._subscriptions = {block: []}
    this._checkpoint = options.checkpoint || 2000
    this.GENESIS_HASH = QTUM_GENESIS_HASH[this.node.network]
    this._lastHeader = null
    this._initialSync = true
    this._originalHeight = 0
    this._lastHeaderCount = 2000
    this._slowMode = options.slowMode
  }

  static get dependencies() {
    return ['db', 'p2p']
  }

  subscribe(name, emitter) {
    let subscription = this.subscriptions[name]
    subscription.push(emitter)
    this.node.log.info(
      emitter.remoteAddress,
      'subscribe:', 'header/' + name,
      'total:', subscription.length
    )
  }

  unsubscribe(name, emitter) {
    let subscription = this.subscriptions[name]
    let index = subscription.indexOf(emitter)
    if (index >= 0) {
      subscription.splice(index, 1)
      this.node.log.info(emitter.remoteAddress, 'unsubscribe:', 'header/' + name, 'total:', subscription.length)
    }
  }

  get APIMethods() {
    return [
      ['getAllHeaders', this.getAllHeaders.bind(this), 0],
      ['getBestHeight', this.getBestHeight.bind(this), 0],
      ['getBlockHeader', this.getBlockHeader.bind(this), 1]
    ]
  }

  getCurrentDifficulty() {
    return getDifficulty(getTarget(this._lastHeader.bits))
  }

  getAllHeaders() {
    let start = this._encoding.encodeHeaderHeightKey(0)
    let end = this._encoding.encodeHeaderHeightKey(this._tip.height + 1)
    let allHeaders = new Map()
    let stream = this._db.createReadStream({gte: start, lt: end})

    return new Promise((resolve, reject) => {
      stream.on('error', reject)
      stream.on('data', data => {
        let header = this._encoding.decodeHeaderValue(data.value)
        allHeaders.set(header.hash, header)
      })
      stream.on('end', () => resolve(allHeaders))
    })
  }

  getBlockHeader(arg) {
    if (Number.isInteger(arg)) {
      return this._getHeader(arg, null)
    } else {
      return this._getHeader(null, arg)
    }
  }

  getBestHeight() {
    return this._tip.height
  }

  _adjustTipBackToCheckpoint() {
    this._originalHeight = this._tip.height
    if (this._checkpoint === -1 || this._tip.height < this._checkpoint) {
      this._tip.height = 0
      this._tip.hash = this.GENESIS_HASH
    } else {
      this._tip.height -= this._checkpoint
    }
  }

  _setGenesisBlock() {
    assert(this._tip.hash === this.GENESIS_HASH, 'Expected tip hash to be genesis hash, but it was not.')
    let genesisHeader = {
      hash: this.GENESIS_HASH,
      height: 0,
      chainwork: STARTING_CHAINWORK,
      version: 1,
      prevHash: '0'.repeat(64),
      timestamp: 1504695029,
      nonce: 8026361,
      bits: 0x1f00ffff,
      merkleRoot: 'ed34050eb5909ee535fcb07af292ea55f3d2f291187617b44d3282231405b96d'
    }
    this._lastHeader = genesisHeader
    return this._db.batch([
      {
        type: 'put',
        key: this._encoding.encodeHeaderHeightKey(0),
        value: this._encoding.encodeHeaderValue(genesisHeader)
      },
      {
        type: 'put',
        key: this._encoding.encodeHeaderHashKey(this.GENESIS_HASH),
        value: this._encoding.encodeHeaderValue(genesisHeader)
      }
    ])
  }

  async start() {
    let prefix = await this._db.getPrefix(this.name)
    this._encoding = new Encoding(prefix)
    this._tip = await this._db.getServiceTip(this.name)
    this._adjustTipBackToCheckpoint()
    if (this._tip.height === 0) {
      await this._setGenesisBlock()
    }
    await this._adjustHeadersForCheckPointTip()
    this._blockProcessor = new AsyncQueue(this._processBlocks.bind(this))
    this._setListeners()
    this._bus = this.node.openBus({remoteAddress: 'localhost-header'})
  }

  _startHeaderSubscription() {
    if (this._subscribedHeaders) {
      return
    }
    this._subscribedHeaders = true
    this.node.log.info('Header Service: subscribed to p2p headers.')
    this._bus.on('p2p/headers', this._onHeaders.bind(this))
    this._bus.subscribe('p2p/headers')
  }

  get publishEvents() {
    return [{
      name: 'header/block',
      subscribe: this.subscribe.bind(this, 'block'),
      unsubscribe: this.unsubscribe.bind(this, 'block')
    }]
  }

  _queueBlock(block) {
    this._blockProcessor.push(block, err => {
      if (err) {
        this._handleError(err)
      } else {
        this.node.log.debug(
          'Header Service: completed processing block:', block.hash,
          'prev hash:', revHex(block.prevBlock)
        )
      }
    })
  }

  async _processBlocks(block) {
    if (this.node.stopping || this._reorging) {
      return
    }
    try {
      let header = await this.getBlockHeader(block.hash)
      if (header) {
        this.node.log.debug('Header Service: block already exists in data set.')
      } else {
        return this._persistHeader(block)
      }
    } catch (err) {
      this._handleError(err)
    }
  }

  async _persistHeader(block) {
    if (!this._detectReorg(block)) {
      return this._syncBlock(block)
    }
    this._reorging = true
    this._emit('reorg')
    await this._handleReorg(block)
    this._startSync()
  }

  _formatHeader(block) {
    let header = block.header.toJSON()
    console.log(header);
    header.timestamp = header.ts
    header.prevHash = header.prevBlock
    return header
  }

  _syncBlock(block) {
    let header = this._formatHeader(block)
    this.node.log.debug('Header Service: new block:', block.hash)
    let dbOps = this._getDBOpForLastHeader(header).concat(this._onHeader(header))
    return this._saveHeaders(dbOps)
  }

  _broadcast(block) {
    for (let emitter of this.subscriptions.block) {
      emitter.emit('header/block', block)
    }
  }

  _onHeader(header) {
    if (!header) {
      return []
    }
    header.height = this._lastHeader.height + 1
    header.chainwork = this._getChainwork(header, this._lastHeader).toString(16, 64)
    header.timestamp = header.timestamp || header.time
    this._lastHeader = header
    this._tip.height = header.height
    this._tip.hash = header.hash
    return [
      {
        type: 'put',
        key: this._encoding.encodeHeaderHashKey(header.hash),
        value: this._encoding.encodeHeaderValue(header)
      },
      {
        type: 'put',
        key: this._encoding.encodeHeaderHeightKey(header.height),
        value: this._encoding.encodeHeaderValue(header)
      }
    ]
  }

  _transformHeaders(headers) {
    let result = []
    for (let i = 0; i < headers.length; ++i) {
      let header = headers[i].toObject()
      if (i < headers.length - 1) {
        header.nextHash = headers[i + 1].hash
      }
      result.push(header)
    }
    return result
  }

  _getDBOpForLastHeader(nextHeader) {
    this._lastHeader.nextHash = nextHeader.hash
    let keyHash = this._encoding.encodeHeaderHashKey(this._lastHeader.hash)
    assert(this._lastHeader.height >= 0, 'Trying to save a header with incorrect height.')
    let keyHeight = this._encoding.encodeHeaderHeightKey(this._lastHeader.height)
    let value = this._encoding.encodeHeaderValue(this._lastHeader)
    return [
      {type: 'del', key: keyHash},
      {type: 'del', key: keyHeight},
      {type: 'put', key: keyHash, value},
      {type: 'put', key: keyHeight, value}
    ]
  }

  async _onHeaders(headers) {
    if (headers.length === 0) {
      this._onHeadersSave().catch(err => this._handleError(err))
    }
    this._lastHeaderCount = headers.length
    this.node.log.debug('Header Service: Received:', headers.length, 'header(s).')
    if (!headers[0]) {
      return
    }
    let dbOps = this._getDBOpForLastHeader(headers[0])
    let transformedHeaders = this._transformHeaders(headers)
    for (let header of transformedHeaders) {
      assert(
        this._lastHeader.hash === header.prevHash,
        `headers not in order: ${this._lastHeader.hash} -and- ${header.prevHash}, `
          + `Last header at height: ${this._lastHeader.height}`
      )
      dbOps.push(...this._onHeader(header))
    }
    try {
      await this._saveHeaders(dbOps)
    } catch (err) {
      this._handleError(err)
    }
  }

  _handleError(err) {
    this.node.log.error('Header Service:', err)
    this.node.stop()
  }

  async _saveHeaders(dbOps) {
    let tipOps = encodeTip(this._tip, this.name)
    dbOps.push({type: 'put', key: tipOps.key, value: tipOps.value})
    await this._db.batch(dbOps)
    return this._onHeadersSave()
  }

  async _onHeadersSave() {
    this._logProgress()
    if (!this._syncComplete()) {
      this._sync()
      return
    }
    this._endHeaderSubscription()
    this._startBlockSubscription()
    this._setBestHeader()
    if (!this._initialSync) {
      return
    }
    this.node.log.info('Header Service: sync complete.')
    this._initialSync = false
    for (let service of this.node.services) {
      if (service.onHeaders) {
        await service.onHeaders()
      }
    }
    this.emit('reorg complete')
    this._reorging = false
  }

  _endHeaderSubscription() {
    if (this._subscribedHeaders) {
      this._subscribedHeaders = false
      this.node.log.info('Header Service: p2p header subscription no longer needed, unsubscribing.')
      this._bus.unsubscribe('p2p/headers')
    }
  }

  _startBlockSubscription() {
    if (this._subscribedBlock) {
      return
    }
    this._subscribedBlock = true
    this.node.log.info('Header Service: starting p2p block subscription.')
    this._bus.on('p2p/block', this._queueBlock.bind(this))
    this._bus.subscribe('p2p/block')
  }

  _syncComplete() {
    return this._lastHeaderCount < 2000
  }

  _setBestHeader() {
    this.node.log.debug('Header Service:', this._lastHeader.hash, 'is the best bock hash.')
  }

  async _getHeader(height, hash) {
    if (!hash && height < 0) {
      throw new Error('invalid arguments')
    }
    if (this._lastHeader.height === height || this._lastHeader.hash === hash) {
      return this._lastHeader
    }
    let key
    if (hash) {
      key = this._encoding.encodeHeaderHashKey(hash)
    } else {
      key = this._encoding.encodeHeaderHeightKey(height)
    }
    let data = await this._db.get(key)
    if (data) {
      return this._encoding.decodeHeaderValue(data)
    }
  }

  _detectReorg(block) {
    return revHex(block.prevBlock !== this._lastHeader.hash)
  }

  _handleReorg(block) {
    this.node.log.warn(
      `Header Service: Reorganization detected, current tip hash: ${this._tip.hash},`,
      'new block causing the reorg:', block.hash
    )
    this._adjustTipBackToCheckpoint()
    return this._adjustHeadersForCheckPointTip()
  }

  _setListeners() {
    this._p2p.on('bestHeight', this._onBestHeight.bind(this))
  }

  _onBestHeight(height) {
    this.node.log.info('Header Service: Best Height is:', height)
    this._bestHeight = height
    this._startSync()
  }

  _startSync() {
    this._initialSync = true
    this.node.log.debug(
      'Header Service: starting sync routines, ensuring no pre-exiting subscriptions to p2p blocks.'
    )
    this._removeAllSubscriptions()
    let interval = setInterval(() => {
      if (this._blockProcessor.length === 0) {
        clearInterval(interval)
        this._reorging = true
        let numNeeded = Math.max(this._bestHeight, this._originalHeight) - this._tip.height
        if (numNeeded > 0) {
          this.node.log.info('Header Service: Gathering:', numNeeded, 'header(s) from the peer-to-peer network.')
          this._sync()
        } else if (numNeeded === 0) {
          this.node.log.info('Header Service: wee seem to be already synced with the peer.')
          this._onHeadersSave().catch(err => this._handleError(err))
        } else {
          this._handleLowTipHeight()
        }
      }
    }, 0)
  }

  _removeAllSubscriptions() {
    this._bus.unsubscribe('p2p/headers')
    this._bus.unsubscribe('p2p/block')
    this._subscribedBlock = false
    this._subscribedHeaders = false
    this._bus.removeAllListeners()
  }

  async _findReorgConditionInNewPeer() {
    let newPeerHeaders = []
    let allHeaders = await this.getAllHeaders()
    this.node.log.warn('Header Service: re-subscribing to p2p headers to gather new peer\'s headers.')
    this._getP2PHeaders(this.GENESIS_HASH)

    return new Promise((resolve, reject) => {
      this._bus.subscribe('p2p/headers')
      this._bus.on('p2p/headers', headers => {
        for (let header of headers) {
          newPeerHeaders.push([header.hash, header])
        }
        if (newPeerHeaders.length < this._bestHeight) {
          return this._getP2PHeaders(headers[headers.length - 1].hash)
        }
        let reorgInfo = {commonHeader: null, blockHash: null}
        for (let i = newPeerHeaders.length; --i >= 0;) {
          let newHeader = newPeerHeaders[i]
          let oldHeader = allHeaders.get(newHeader.hash)
          if (oldHeader) {
            if (!reorgInfo.blockHash) {
              resolve()
            }
            reorgInfo.commonHeader = oldHeader
            resolve(reorgInfo)
          }
          reorgInfo.blockHash = newHeader.hash
        }
      })
    })
  }

  async _handleLowTipHeight() {
    this.node.log.warn(
      'Header Service: Connected Peer has a best height',
      `(${this._bestHeight})`,
      'which is lower than our tip height',
      `(${this._tip.height}).`,
      'This means that this peer is not fully synchronized with the network',
      '-or- the peer has reorganized itself.',
      'Checking the new peer\'s headers for a reorganization event.'
    )
    try {
      let reorgInfo = await this._findReorgConditionInNewPeer()
      if (!reorgInfo) {
        this.node.log.info(
          'Header Service: it appears that our peer is not yet synchronized with the network',
          '(we have a strict superset of the peer\'s blocks).',
          'We will wait for more blocks to arrive...'
        )
        await this._onHeadersSave()
      } else {
        let block = await this._p2p.getP2PBlock({
          filter: {startHash: reorgInfo.commonHeader.hash, endHash: 0},
          blockHash: reorgInfo.blockHash
        })
        this._initialSync = true
        await this._handleReorg(block, reorgInfo.commonHeader)
        this._startSync()
      }
    } catch (err) {
      this._handleError(err)
    }
  }

  _logProgress() {
    if (!this._initialSync || this._lastTipHeightReported === this._tip.height) {
      return
    }
    let progress
    let bestHeight = Math.max(this._bestHeight, this._lastHeader.height)
    if (bestHeight === 0) {
      progress = 0
    } else {
      progress = (this._tip.height / bestHeight * 100).toFixed(2)
    }
    this.node.log.info(
      'Header Service: download progress:',
      this._tip.height + '/' + bestHeight,
      '(' + progress + '%)'
    )
    this._lastTipHeightReported = this._tip.height
  }

  _getP2PHeaders(hash) {
    this._p2p.getHeaders({startHash: hash})
  }

  _sync() {
    this._startHeaderSubscription()
    this._getP2PHeaders(this._tip.hash)
  }

  getEndHash(tip, blockCount) {
    assert(blockCount >= 1, 'Header Service: block count to getEndHash must be at least 1.')
    let numResultsNeeded = Math.min(this._tip.height - tip.height, blockCount + 1)
    if (numResultsNeeded === 0 && this._tip.hash === tip.hash) {
      return
    } else if (numResultsNeeded <= 0) {
      throw new Error('Header Service: block service is mis-aligned')
    }
    let startingHeight = tip.height + 1
    let start = this._encoding.encodeHeaderHeightKey(startingHeight)
    let end = this._encoding.encodeHeaderHeightKey(startingHeight + blockCount)
    let results = []
    let stream = this._db.createReadStream({gte: start, lte: end})

    return new Promise((resolve, reject) => {
      stream.on('error', reject)
      stream.on('data', data => results.push(this._encoding.decodeHeaderValue(data.value).hash))
      stream.on('end', () => {
        assert(results.length === numResultsNeeded, 'getEndHash returned incorrect number of results.')
        let index = numResultsNeeded - 1
        let endHash = index <= 0 || !results[index] ? results[index] : 0
        if (this._slowMode) {
          setTimeout(() => resolve({targetHash: results[0], endHash}), this._slowMode)
        } else {
          resolve({targetHash: results[0], endHash})
        }
      })
    })
  }

  getLastheader() {
    assert(this._lastHeader, 'Last header should be populated.')
    return this._lastHeader
  }

  _adjustHeadersForCheckPointTip() {
    let removalOps = []
    let start = this._encoding.encodeHeaderHeightKey(this._tip.height)
    let end = this._encoding.encodeHeaderHeightKey(0xffffffff)
    this.node.log.info('Getting last header synced at height:', this._tip.height)
    let stream = this._db.createReadStream({gte: start, lte: end})

    return new Promise((resolve, reject) => {
      stream.on('error', reject)
      stream.on('data', data => {
        let header = this._encoding.decodeHeaderValue(data.value)
        if (header.height > this._tip.height) {
          removalOps.push(
            {type: 'del', key: data.key},
            {type: 'del', key: this._encoding.encodeHeaderHashKey(header.hash)}
          )
        } else if (header.height === this._tip.height) {
          this._lastHeader = header
        }
      })
      stream.on('end', () => {
        assert(this._lastHeader, 'The last synced header was not in the database.')
        this._tip.hash = this._lastHeader.hash
        this._tip.height = this._lastHeader.height
        resolve(this._db.batch(removalOps))
      })
    })
  }

  _getChainwork(header, prevHeader) {
    let prevChainwork = new BN(Buffer.from(prevHeader.chainwork, 'hex'))
    return this._computeChainwork(header.bits, prevChainwork)
  }

  _computeChainwork(bits, prev) {
    let target = fromCompact(bits)
    if (target.isNeg() || target.cmpn(0) === 0) {
      return new BN(0)
    }
    let proof = MAX_CHAINWORK.div(target.iaddn(1))
    return prev ? proof.iadd(prev) : proof
  }
}

module.exports = HeaderService
