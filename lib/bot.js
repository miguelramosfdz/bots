
const { EventEmitter } = require('events')
const path = require('path')
const low = require('lowdb')
const debug = require('debug')('tradle:bots:bot')
const {
  Promise,
  co,
  shallowClone,
  shallowExtend,
  createSimpleMessage,
  isPromise,
  tryWithExponentialBackoff,
  assert,
  addAndRemover,
  series,
  forceLog,
  validateObject
} = require('./utils')

const Errors = require('./errors')
const managePersistentQueues = require('./queues')
const manageUsers = require('./users')
const manageSeals = require('./seals')
const manageShared = require('./sharedstorage')
const manageStrategies = require('./strategies')
const reliableSender = require('./sender')

const DEFAULT_SHOULD_RETRY = {
  send: ({ user, data, err }) => {
    return !Errors.isNotFoundError(err) &&
      !Errors.isDuplicateError(err) &&
      !Errors.isUserNotFoundError(err)
  },
  receive: ({ user, wrapper }) => {
    return true
  }
}

const SIG = '_s'

module.exports = createBot

/**
 * create a bot runner
 * @param  {Function}  opts.send           function to deliver a message to the provider
 * @param  {Function}  opts.seal           function to request the provider to seal an object on blockchain
 * @param  {String}    [opts.dir]          directory where to store databases. If omitted, in-memory databases will be used
 * @param  {Object}    [opts.shouldRetry=DEFAULT_SHOULD_RETRY]  functions to determine whether to retry failed operations
 * @param  {Boolean}   [opts.autostart] if true, queued operations will commence immediately
 * @return {Object}
 */
function createBot ({ dir, send, seal, shouldRetry=DEFAULT_SHOULD_RETRY, autostart }) {
  const paths = {}
  if (dir) {
    paths.shared = path.join(dir, 'shareddb.json')
    paths.users = path.join(dir, 'users.json')
    paths.sendQueues = path.join(dir, 'send-queues.json')
    paths.receiveQueues = path.join(dir, 'receive-queues.json')
  }

  const bot = new EventEmitter()
  bot.on('error', function (err) {
    debug(`experienced error: ${err.message}`)
  })

  const receiveHandlers = []
  bot.addReceiveHandler = addAndRemover(receiveHandlers)

  const users = manageUsers(paths.users)
  const shared = manageShared(paths.shared)
  const seals = manageSeals({ seal, dir, shouldRetry: shouldRetry.seal })
  ;['push', 'read', 'wrote'].forEach(event => {
    seals.on(event, function (...args) {
      bot.emit('seal:' + event, ...args)
    })
  })

  ;['create', 'delete', 'clear', 'update'].forEach(event => {
    users.on(event, function (...args) {
      if (event === 'delete') {
        const user = args[0]
        sends.clear(user)
        receives.clear(user)
      } else if (event === 'clear') {
        sends.clear()
        receives.clear()
      }

      bot.emit('user:' + event, ...args)
    })
  })

  const enqueueSend = co(function* ({ userId, object }) {
    assert(typeof userId === 'string', 'expected string "userId"')
    assert(
      typeof object === 'object' || typeof object === 'string',
      'expected object or string "object"'
    )

    if (typeof object === 'string') {
      object = createSimpleMessage(object)
    } else {
      validateObject(object)
    }

    const user = users.get(userId) || users.create(userId)

    // signing is done on the tradle server
    if (object[SIG]) {
      delete object[SIG]
      debug(`stripping "${SIG}" property, as signing is done on the Tradle server`)
    }

    sends.enqueue(user, object)
  })

  const enqueueReceive = co(function* (wrapper) {
    assert(typeof wrapper.author === 'string', 'expected string "author"')
    assert(typeof wrapper.object === 'object', 'expected object "object"')

    // a sample message object can be found below
    // you're likely most interested in the object: the "object" property
    // {
    //   "_s": "..signature..",
    //   "_n": "..sequence marker..",
    //   "_t": "tradle.Message",
    //   "recipientPubKey": { ..your tradle server's bot's pubKey.. },
    //   "object": {
    //     "_t": "tradle.SimpleMessage",
    //     "message": "this is one happy user!"
    //   }
    // }

    const id = wrapper.author
    const user = users.get(id) || users.create(id)
    receives.enqueue(user, wrapper)
  })

  /**
   * process an incoming message from a client
   * @param {Object} user           user state object
   * @param {Object} wrapper.object message object
   * @param {String} wrapper.link   unique message identifier
   * @return {Promise}
   */
  const doReceive = co(function* doReceive (user, wrapper) {
    debug('receiving a message from ' + user.id)

    // message object
    const { objectinfo, object, link } = wrapper
    wrapper.inbound = true
    user.history.push(wrapper)
    users.save(user)
    debug('received a message from ' + user.id)

    const receiving = {
      user,
      link: objectinfo.link,
      object: object.object,
      message: object,
      raw: wrapper
    }

    yield series(receiveHandlers, receiving)

    bot.emit('message', receiving)
  })

  const sends = managePersistentQueues({
    path: paths.sendQueues,
    worker: reliableSender({
      bot,
      users,
      send,
      shouldRetry: shouldRetry.send
    })
  })

  const receives = managePersistentQueues({
    path: paths.receiveQueues,
    worker: co(function* tryReceive ({ user, data }) {
      try {
        return yield doReceive(user, data)
      } catch (err) {
        // important to display this one way or another
        forceLog(debug, `Error receiving message due to error in strategy. Pausing receive for user ${user.id}`, err)
        err = Errors.developer(err)
        bot.emit('error', Errors.forAction(err, 'receive'))
        return new Promise(resolve => {
          // stall this receive queue
          // after the developer fixes the error and restarts, receive will be re-attempted
        })
      }
    })
  })

  const strategies = manageStrategies(bot)

  function useStrategy (...args) {
    strategies.use(...args)
  }

  let started

  function start () {
    if (!started)

    started = true
    sends.start()
    receives.start()
    seals.start()
  }

  if (autostart) process.nextTick(start)

  return shallowExtend(bot, {
    use: useStrategy,
    strategies,
    users,
    shared,
    receive: enqueueReceive,
    // export for use in repl and testing
    send: enqueueSend,
    seals,
    seal: seals.seal,
    start,
    queued: {
      send: sends.queued,
      receive: receives.queued,
      seal: seals.queued
    }
  })
}
