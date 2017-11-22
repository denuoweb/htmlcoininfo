const BN = require('./bn')
const ec = require('elliptic').curves.secp256k1
const ecPoint = ec.curve.point.bind(ec.curve)
const ecPointFromX = ec.curve.pointFromX.bind(ec.curve)

function Point(x, y, isRed) {
  let point = ecPoint(x, y, isRed)
  point.validate()
  return point
}

Point.prototype = Object.getPrototypeOf(ec.curve.point())

Point.fromX = function(odd, x) {
  let point = ecPointFromX(odd, x)
  point.validate()
  return point
}

Point.getG = function() {
  return ec.curve.g
}

Point.getN = function() {
  return new BN(ec.curve.n.toArray())
}

Point.prototype._getX = Point.prototype.getX

Point.prototype.getX = function() {
  return new BN(this._getX().toArray())
}

Point.prototype._getY = Point.prototype.getY

Point.prototype.getY = function() {
  return new BN(this._getY().toArray())
}

Point.prototype.validate = function() {
  if (this.isInfinity()) {
    throw new Error('Point cannot be equal to Infinity')
  }

  if (this.getX().cmp(BN.Zero) === 0 || this.getY().cmp(BN.Zero) === 0) {
    throw new Error('Invalid x,y value for curve, cannot equal 0.')
  }

  let p2 = ecPointFromX(this.getY().isOdd(), this.getX())
  if (p2.y.cmp(this.y) !== 0) {
    throw new Error('Invalid y value for curve.')
  }

  let xValidRange = (this.getX().gt(BN.Minus1) && this.getX().lt(Point.getN()))
  let yValidRange = (this.getY().gt(BN.Minus1) && this.getY().lt(Point.getN()))
  if (!xValidRange || !yValidRange) {
    throw new Error('Point does not lie on the curve')
  }

  if (!(this.mul(Point.getN()).isInfinity())) {
    throw new Error('Point times N must be infinity')
  }

  return this
}

Point.pointToCompressed = function(point) {
  let xbuf = point.getX().toBuffer({size: 32})
  let ybuf = point.getY().toBuffer({size: 32})

  let prefix
  if (ybuf[ybuf.length - 1] & 1) {
    prefix = Buffer.from([0x03])
  } else {
    prefix = Buffer.from([0x02])
  }
  return Buffer.concat([prefix, xbuf])
}

module.exports = Point
