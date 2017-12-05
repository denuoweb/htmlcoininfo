const {Writable} = require('stream')
const Router = require('koa-router')
const morgan = require('koa-morgan')
const compress = require('koa-compress')
const bodyparser = require('koa-bodyparser')
const BaseService = require('qtumscan-node/lib/service')
const BlockController = require('./controllers/blocks')
const TransactionController = require('./controllers/transactions')
const RateLimiter = require('./components/rate-limiter')

class QtumscanAPI extends BaseService {
  constructor(options) {
    super(options)

    this.subscriptions = {inv: []}

    this.enableCache = options.enableCache
    this.cacheShortSeconds = options.cacheShortSeconds
    this.cacheLongSeconds = options.cacheLongSeconds

    this.rateLimiterOptions = options.rateLimiterOptions || {}
    this.disableRateLimiter = options.disableRateLimiter

    this.blockSummaryCacheSize = options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE
    this.blockCacheSize = options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE

    if ("routePrefix" in options) {
      this._routePrefix = options.routePrefix
    } else {
      this._routePrefix = this.name
    }

    let blockOptions = {
      node: this.node,
      blockSummaryCache: this.blockSummaryCache,
      blockCacheSize: this.blockCacheSize,
      transactionService: this.transactionService
    }
    this.blockController = new BlockController(blockOptions)

    this.transactionController = new TransactionController(this.node)
  }

  cache(maxAge) {
    return async (ctx, next) => {
      if (this.enableCache) {
        ctx.set('Cache-Control', `public, max-age=${maxAge}`)
      }
      await next()
    }
  }

  cacheShort() {
    return this.cache(this.cacheShortSeconds || 30)
  }

  cacheLong() {
    return this.cache(this.cacheLongSeconds || 24 * 60 * 60)
  }

  static get dependencies() {
    return ['block', 'header', 'mempool', 'timestamp', 'transaction', 'web']
  }

  get routePrefix() {
    return this._routePrefix
  }

  async start() {
    if (!this._subscribed) {
      return
    }
    this._subscribed = true

    if (!this._bus) {
      this._bus = this.node.openBus({remoteAddress: 'localhost-qtumscan-api'})
    }
    this._bus.on('mempool/transaction', this.transactionEventHandler.bind(this))
    this._bus.subscribe('mempool/transaction')
    this._bus.on('block/block', this.blockEventHandler.bind(this))
    this._bus.subscribe('block/block')
  }

  createLogInfoStream() {
    const that = this

    class Log extends Writable {
      _write(chunk, encoding, callback) {
        that.node.log.info(chunk.slice(0, chunk.length - 1))
        callback()
      }
    }

    return new Log()
  }

  getRemoteAddress(req) {
    return req.headers['cf-connecting-ip'] || req.socket.remoteAddress
  }

  _getRateLimiter() {
    let rateLimiterOptions = Object.assign({node: this.node}, this.rateLimiterOptions)
    return new RateLimiter(rateLimiterOptions)
  }

  setupRoutes(app) {
    if (!this.disableRateLimiter) {
      let limiter = this._getRateLimiter()
      app.use(limiter.middleware())
    }

    morgan.token('remote-forward-addr', req => this.getRemoteAddress(req))
    let logFormat = ':remote-forward-addr ":method :url" :status :res[content-length] :response-time ":user-agent" '
    let logStream = this.createLogInfoStream()
    app.use(morgan(logFormat, {stream: logStream}))

    app.use(async (ctx, next) => {
      ctx.set('Access-Control-Allow-Origin', '*')
      ctx.set('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, OPTIONS')
      ctx.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Content-Length, Cache-Control, cf-connecting-ip')

      if (ctx.method.toUpperCase() === 'OPTIONS') {
        ctx.body = null
        return
      }

      try {
        await next()
      } catch (err) {
        ctx.status = err.status || 500
        ctx.body = err.message
        app.emit('error', err, ctx)
      }
    })

    app.use(compress())
    app.use(bodyparser())

    let router = new Router()

    let blocks = this.blockController
    router.get('/blocks', this.cacheShort(), blocks.list.bind(blocks))
    router.get(
      '/block/:blockHash',
      this.cacheShort(),
      blocks.checkBlockHash.bind(blocks),
      blocks.block.bind(blocks),
      blocks.show.bind(blocks)
    )
    router.get(
      '/rawblock/:blockHash',
      this.cacheLong(),
      blocks.checkBlockHash.bind(blocks),
      blocks.rawBlock.bind(blocks),
      blocks.showRaw.bind(blocks)
    )
    router.get('/block-index/:height', this.cacheShort(), blocks.blockIndex.bind(blocks))

    let transactions = this.transactionController
    router.get(
      '/tx/:txid',
      this.cacheShort(),
      transactions.transaction.bind(transactions),
      transactions.show.bind(transactions)
    )
    router.get('/txs', this.cacheShort(), transactions.list.bind(transactions))
    router.post('/tx/send', transactions.send.bind(transactions))
    router.get(
      '/rawtx/:txid',
      this.cacheLong(),
      transactions.rawTransaction.bind(transactions),
      transactions.showRaw.bind(transactions)
    )

    app.use(router.routes()).use(router.allowedMethods())
  }

  get publishEvents() {
    return [{
      name: 'inv',
      subscribe: emitter => this.subscribe(emitter),
      unsubscribe: emitter => this.unsubscribe(emitter),
      extraEvents: ['block', 'tx']
    }]
  }

  blockEventHandler(hashBuffer) {
    for (let event of this.subscriptions.inv) {
      event.emit('block', hashBuffer.toString('hex'))
    }
  }

  transactionEventHandler(tx) {
    let result = this.transactionController.transformInvTransaction(tx)

    for (let event of this.subscriptions.inv) {
      event.emit('tx', result)
    }
  }

  subscribe(emitter, room) {
    let emitters = this.subscriptions[room]
    if (!emitters.includes(emitter)) {
      emitters.push(emitter)
    }
  }

  unsubscribe(emitter, room) {
    let emitters = this.subscriptions[room]
    let index = emitters.indexOf(emitter)
    if (index !== -1) {
      emitters.splice(index, 1)
    }
  }
}

module.exports = QtumscanAPI
