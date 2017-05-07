
const {
  co
} = require('../utils')

const { TYPE } = require('../constants')
const ONLINE = 'I\'m back! How long was I gone?'

module.exports = function sillyStrategy (bot) {
  const send = function (user, object) {
    return bot.send({ userId: user.id, object })
  }

  co(function* sayHello () {
    const users = yield bot.users.list()

    for (let { value } of users) {
      send(value, ONLINE)
    }
  })()

  function oncreate (user) {
    send(user, 'Nice to meet you!')
  }

  const onmessage = co(function* ({ user, wrapper }) {
    const { message } = wrapper
    const { object } = message
    const type = object[TYPE]
    switch (type) {
    case 'tradle.SelfIntroduction':
    case 'tradle.IdentityPublishRequest':
      if (!object.profile) break

      let name = object.profile.firstName
      let oldName = user.profile && user.profile.firstName
      user.profile = object.profile
      yield bot.users.save(user)
      if (name !== oldName) {
        yield send(user, `${name}, eh? Hot name!`)
      }

      break
    case 'tradle.SimpleMessage':
      yield send(user, `tell me more about this "${object.message}," it sounds interesting`)
      break
    case 'tradle.CustomerWaiting':
      yield send(user, 'Buahahaha! ...I mean welcome to my super safe world')
      break
    default:
      yield send(user, `Huh? What's a ${type}? I only understand simple messages. One day, when I'm a real boy...`)
      break
    }
  })

  const removeHandler = bot.hook('receive', onmessage)
  bot.users.on('create', oncreate)

  return function disable () {
    removeHandler()
    bot.users.removeListener('create', oncreate)
  }
}
