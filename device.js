const EventEmitter = require('events')
const rgba = require('color-rgba')

const {
    BUTTONS,
    COMMANDS,
    DEFAULT_RECONNECT_INTERVAL,
    DISPLAYS,
    HAPTIC,
    MAX_BRIGHTNESS,
} = require('./constants')
const WSConnection = require('./connections/ws')
const SerialConnection = require('./connections/serial')

class LoupedeckDevice extends EventEmitter {
    static async list({ ignoreSerial = false, ignoreWebsocket = false } = {}) {
        const ps = []

        if (!ignoreSerial) ps.push(SerialConnection.discover())
        if (!ignoreWebsocket) ps.push(WSConnection.discover())

        // Run them in parallel
        const rawDevices = await Promise.all(ps)

        return rawDevices.flat()
    }
    constructor({ host, path, autoConnect = true, reconnectInterval = DEFAULT_RECONNECT_INTERVAL } = {}) {
        super()
        this.transactionID = 0
        this.touches = {}
        this.handlers = {
            [COMMANDS.BUTTON_PRESS]: this.onButton.bind(this),
            [COMMANDS.KNOB_ROTATE]: this.onRotate.bind(this),
            [COMMANDS.SERIAL]: this.onSerial.bind(this),
            [COMMANDS.TICK]: () => {},
            [COMMANDS.TOUCH]: this.onTouch.bind(this, 'touchmove'),
            [COMMANDS.TOUCH_END]: this.onTouch.bind(this, 'touchend'),
            [COMMANDS.VERSION]: this.onVersion.bind(this),
        }
        // Track pending transactions
        this.pendingTransactions = {}
        // How long between reconnect attempts
        this.reconnectInterval = reconnectInterval
        // Host for websocket connections
        this.host = host
        // Path for serial connections
        this.path = path
        // Automatically connect?
        if (autoConnect) this._connectBlind()
    }
    close() {
        if (!this.connection) return
        return this.connection.close()
    }
    async connect() {
        // Explicitly asked for a serial connection (V0.2.X)
        if (this.path) this.connection = new SerialConnection({ path: this.path })
        // Explicitly asked for a websocket connection (V0.1.X)
        else if (this.host) this.connection = new WSConnection({ host: this.host })
        // Autodiscover
        else {
            const devices = await this.constructor.list()
            if (devices.length > 0) {
                const { type, ...args } = devices[0]
                this.connection = new type(args)
            }
            if (!this.connection) {
                return Promise.reject(this.onDisconnect(new Error('No devices found')))
            }
        }

        this.connection.on('connect', this.onConnect.bind(this))
        this.connection.on('message', this.onReceive.bind(this))
        this.connection.on('disconnect', this.onDisconnect.bind(this))
        return this.connection.connect()
    }
    _connectBlind() {
        return this.connect().catch(() => {})
    }
    // Draw an arbitrary buffer to the device
    // Buffer format must be 16bit 5-6-5
    async drawBuffer({ id, width, height, x = 0, y = 0, autoRefresh = true }, buffer) {
        const displayInfo = DISPLAYS[id]
        if (!width) width = displayInfo.width
        if (!height) height = displayInfo.height

        const pixelCount = width * height * 2
        if (buffer.length !== pixelCount) {
            throw new Error(`Expected buffer length of ${pixelCount}, got ${buffer.length}!`)
        }

        // Header with x/y/w/h and display ID
        const header = Buffer.alloc(8)
        header.writeUInt16BE(x, 0)
        header.writeUInt16BE(y, 2)
        header.writeUInt16BE(width, 4)
        header.writeUInt16BE(height, 6)

        // Write to frame buffer
        await this.send(COMMANDS.FRAMEBUFF, Buffer.concat([displayInfo.id, header, buffer]))

        // Draw to display
        if (autoRefresh) await this.refresh(id)
    }
    // Create a canvas with correct dimensions and pass back for drawing
    drawCanvas({ id, width, height, ...args }, cb) {
        const displayInfo = DISPLAYS[id]
        if (!width) width = displayInfo.width
        if (!height) height = displayInfo.height
        let createCanvas
        try {
            createCanvas = require('canvas').createCanvas
        } catch(e) {
            throw new Error('Using callbacks requires the `canvas` library to be installed. Install it using `npm install canvas`.')
        }

        const canvas = createCanvas(width, height)
        const ctx = canvas.getContext('2d', { pixelFormat: 'RGB16_565' }) // Loupedeck uses 16-bit (5-6-5) LE RGB colors
        cb(ctx, width, height)
        const buffer = canvas.toBuffer('raw')
        return this.drawBuffer({ id, width, height, ...args }, buffer)
    }
    // Draw to a specific key index (0-12)
    drawKey(index, cb) {
        // Get offset x/y for key index
        const width = 90
        const height = 90
        const x = index % 4 * width
        const y = Math.floor(index / 4) * height
        return this[cb instanceof Buffer ? 'drawBuffer' : 'drawCanvas']({ id: 'center', x, y, width, height }, cb)
    }
    // Draw to a specific screen
    drawScreen(id, cb) {
        return this[cb instanceof Buffer ? 'drawBuffer' : 'drawCanvas']({ id }, cb)
    }
    async getInfo() {
        if (!this.connection || !this.connection.isReady()) throw new Error('Not connected!')
        return {
            serial: await this.send(COMMANDS.SERIAL),
            version: await this.send(COMMANDS.VERSION)
        }
    }
    onButton(buff) {
        const id = BUTTONS[buff[0]]
        const event = buff[1] === 0x00 ? 'down' : 'up'
        this.emit(event, { id })
    }
    onConnect(info) {
        this.emit('connect', info)
    }
    onDisconnect(error) {
        this.emit('disconnect', error)
        clearTimeout(this._reconnectTimer)
        this.connection = null
        // Normal disconnect, do not reconnect
        if (!error) return
        // Reconnect if desired
        if (this.reconnectInterval) {
            this._reconnectTimer = setTimeout(this._connectBlind.bind(this), this.reconnectInterval)
        }
        return error.message
    }
    onReceive(buff) {
        const msgLength = buff[0]
        const handler = this.handlers[buff[1]]
        const transactionID = buff[2]
        const response = handler ? handler(buff.slice(3, msgLength)) : buff
        const resolver = this.pendingTransactions[transactionID]
        if (resolver) resolver(response)
        return response
    }
    onRotate(buff) {
        const id = BUTTONS[buff[0]]
        const delta = buff.readInt8(1)
        this.emit('rotate', { id, delta })
    }
    onSerial(buff) {
        return buff.toString().trim()
    }
    onTouch(event, buff) {
        const x = buff.readUInt16BE(1)
        const y = buff.readUInt16BE(3)
        const id = buff[5]

        // Determine target
        const screen = x < 60 ? 'left' : x >= 420 ? 'right' : 'center'
        let key
        if (screen === 'center') {
            const column = Math.floor((x - 60) / 90)
            const row = Math.floor(y / 90)
            key = row * 4 + column
        }

        // Create touch
        const touch = { x, y, id, target: { screen, key } }

        // End touch, remove from local cache
        if (event === 'touchend') {
            delete this.touches[touch.id]
        } else {
            // First time seeing this touch, emit touchstart instead of touchmove
            if (!this.touches[touch.id]) event = 'touchstart'
            this.touches[touch.id] = touch
        }

        this.emit(event, { touches: Object.values(this.touches), changedTouches: [touch] })
    }
    onVersion(buff) {
        return `${buff[0]}.${buff[1]}.${buff[2]}`
    }
    // Display the current framebuffer
    refresh(id) {
        const displayInfo = DISPLAYS[id]
        return this.send(COMMANDS.DRAW, displayInfo.id)
    }
    send(command, data = Buffer.alloc(0)) {
        if (!this.connection || !this.connection.isReady()) return
        this.transactionID = (this.transactionID + 1) % 256
        // Skip transaction ID's of zero since the device seems to ignore them
        if (this.transactionID === 0) this.transactionID++
        const header = Buffer.alloc(3)
        header[0] = Math.min(3 + data.length, 0xff)
        header[1] = command
        header[2] = this.transactionID
        const packet = Buffer.concat([header, data])
        this.connection.send(packet)
        return new Promise(res => {
            this.pendingTransactions[this.transactionID] = res
        })
    }
    setBrightness(value) {
        const byte = Math.max(0, Math.min(MAX_BRIGHTNESS, Math.round(value * MAX_BRIGHTNESS)))
        return this.send(COMMANDS.SET_BRIGHTNESS, Buffer.from([byte]))
    }
    setButtonColor({ id, color }) {
        const key = Object.keys(BUTTONS).find(k => BUTTONS[k] === id)
        if (!key) throw new Error(`Invalid button ID: ${id}`)
        const [r, g, b] = rgba(color)
        const data = Buffer.from([key, r, g, b])
        return this.send(COMMANDS.SET_COLOR, data)
    }
    vibrate(pattern = HAPTIC.SHORT) {
        return this.send(COMMANDS.SET_VIBRATION, Buffer.from([pattern]))
    }
}

module.exports = LoupedeckDevice