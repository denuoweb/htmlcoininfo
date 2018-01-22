const path = require('path')
const fs = require('fs')

function findConfig(cwd) {
  let directory = cwd
  while (!fs.existsSync(path.resolve(directory, 'qtuminfo-node.json'))) {
    directory = path.resolve(directory, '..')
    if (directory === '/') {
      return false
    }
  }
  return {
    path: directory,
    config: require(path.resolve(directory, 'qtuminfo-node.json'))
  }
}

module.exports = findConfig
