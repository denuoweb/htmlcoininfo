const path = require('path')
const fs = require('fs')

function findConfig(cwd) {
  let directory = cwd
  while (!fs.existsSync(path.resolve(directory, 'qtumscan-node.json'))) {
    directory = path.resolve(directory, '..')
    if (directory === '/') {
      return false
    }
  }
  return {
    path: directory,
    config: require(path.resolve(directory, 'qtumscan-node.json'))
  }
}

module.exports = findConfig
