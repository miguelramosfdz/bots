const ip = require('ip')
const Promise = require('bluebird')
const co = Promise.coroutine
const Backoff = require('backoff')
const shallowClone = require('xtend')
const shallowExtend = require('xtend/mutable')
const bodyParser = require('body-parser')
const safeStringify = require('safe-json-stringify')
const traverse = require('traverse')
const clone = require('clone')
const debug = require('debug')('tradle:bots:utils')
const Errors = require('./errors')
const BACKOFF_DEFAULTS = {
  randomisationFactor: 0,
  initialDelay: 1000,
  // 1 min
  maxDelay: 60000
}

function createSimpleMessage (message) {
  return {
    _t: 'tradle.SimpleMessage',
    message
  }
}

function isPromise (obj) {
  return obj && typeof obj.then === 'function'
}

function bigJsonParser () {
  return bodyParser.json({ limit: '50mb' })
}

function* sendRequest (req) {
  let res
  try {
    res = yield req
  } catch (err) {
    if (err.response) {
      err = errorFromResponse(err.response)
    }

    if (err.status === 404) {
      err = Errors.notFound(err)
    } else if (err.status === 409) {
      err = Errors.duplicate(err)
    }

    throw err
  }

  const { ok, body } = res
  if (!ok) {
    throw errorFromResponse(res)
  }

  return body
}

function errorFromResponse (res) {
  const { body={}, text, status } = res
  const err = new Error(text)
  err.body = body.error || body
  err.status = status
  return err
}

const tryWithExponentialBackoff = co(function* tryWithExponentialBackoff (opts) {
  const {
    worker,
    maxTries=Infinity,
    backoffOpts=BACKOFF_DEFAULTS,
    // onAttemptFailed=noop,
    name='task'
  } = opts

  const backoff = Backoff.exponential(backoffOpts)

  let tries = 0
  while (tries++ < maxTries) {
    try {
      return yield worker()
    } catch (err) {
      if (err instanceof TypeError || err instanceof ReferenceError) {
        throw Errors.developer(err)
      }

      debug(`attempt to run ${name} failed, backing off before retrying`, err)
      yield new Promise(resolve => {
        backoff.once('ready', resolve)
        backoff.backoff()
      })
    }
  }

  throw new Error('failed after retrying max tries')
})

function assert (statement, err) {
  if (!statement) {
    throw new Error(err || 'assertion failed')
  }
}

function addAndRemover (arr) {
  return function add (item) {
    arr.push(item)
    return function remove () {
      const idx = arr.indexOf(item)
      if (idx) {
        arr.splice(idx, 1)
        return true
      }
    }
  }
}

const series = co(function* series (fns, ...args) {
  for (let i = 0; i < fns.length; i++) {
    let fn = fns[i]
    let maybePromise = fn(...args)
    if (isPromise(maybePromise)) {
      yield maybePromise
    }
  }
})

// TODO: optimize
function toSafeJson (obj) {
  return JSON.parse(safeStringify(obj))
}

// function convertTradleWrapper (wrapper) {
//   // message object
//   const { object } = wrapper
//   const object = object.object
//   return {
//     object,
//     message: object,
//     raw: wrapper
//   }
// }

function normalizeConf (conf) {
  conf.providerURL = conf.providerURL.replace(/\/+$/, '')
  if (!conf.webhookURL) {
    conf.webhookURL = `http://${ip.address()}:${conf.port}`
  }

  if (conf.autostart !== false) {
    conf.autostart = true
  }

  return conf
}

function forceLog (debugNamespace, ...args) {
  /* eslint no-console: "off" */
  if (debugNamespace.enabled) debugNamespace(...args)
  else console.log(...args)
}

function validateObject (object) {
  if (hasUndefinedValues(object)) {
    throw new Error('object may not have undefined for any nested values')
  }
}

function hasUndefinedValues (obj) {
  let has
  traverse(obj).forEach(function (val) {
    if (val === undefined) {
      has = true
      /* eslint no-invalid-this: "off" */
      this.update(undefined, true) // stop traversing
    }
  })

  return has
}

function wait (millis, ...args) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(...args)
    }, millis)
  })
}

module.exports = {
  Promise,
  co,
  clone,
  shallowClone,
  shallowExtend,
  safeStringify,
  toSafeJson,
  createSimpleMessage,
  isPromise,
  bigJsonParser,
  sendRequest: co(sendRequest),
  tryWithExponentialBackoff,
  assert,
  addAndRemover,
  series,
  normalizeConf,
  forceLog,
  validateObject,
  wait
}
