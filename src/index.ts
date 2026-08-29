import { WebSocketServer, WebSocket } from 'ws'
import crypto from 'node:crypto';
import type { JSONSchema7 } from 'json-schema'
import type { IncomingMessage as HttpIncomingMessage } from 'http'

// Type definitions for messages received from games
export interface Action {
    name: string
    description: string
    schema?: Omit<JSONSchema7, 'type'> & { type: 'object' }
}

export interface ExtraConfigOptions {
    /** A function that is ran upon the server starting successfully. */
    onStartup?: () => void
    /** Whether this is a test mode. Useful for automated testing purposes. */
    test?: boolean
    /** Whether or not the server should support multi-connects. Defaults to `false` since for most purposes you shouldn't be needing this. */
    multiConnect?: boolean;
    /** Whether or not to automatically detect dead connections. Defaults to `false`. */
    autoDetectDeadConnects?: boolean;
    /** Whether or not your server accepts the voice API. */
    voiceApi?: boolean;
}

// Message types (what the server sends TO games)
export interface OutgoingMessage {
    command: string
    data?: { [key: string]: any }
}

// Connection interface
export interface ClientConnection {
    id: string
    socket: WebSocket
    gameName?: string
    isAlive: boolean
}

type Promiseish<T> = T | PromiseLike<T>

// Event handlers for server events
export interface ServerEventHandlers {
    onGameStartup?: (gameName: string, connection: ClientConnection) => Promiseish<{ characterId: string; displayName: string; } | void>
    onGameContext?: (gameName: string, message: string, silent: boolean) => Promiseish<void>
    onActionsRegistered?: (gameName: string, actions: Action[], connection: ClientConnection) => Promiseish<void>
    onActionsUnregistered?: (gameName: string, actionNames: string[]) => Promiseish<void>
    onActionsForce?: (gameName: string, query: string, actionNames: string[], state?: string, ephemeralContext?: boolean, priority?: ActionForcePriority) => Promiseish<{ id: string, name: string, data?: any }>
    onActionResult?: (gameName: string, actionId: string, success: boolean, message?: string) => Promiseish<void>
}

// Error handlers for server errors
export interface ServerErrorHandlers {
    onMessageParseError?: (error: Error, rawData: Buffer, connection: ClientConnection) => Promiseish<void>
    onConnectionError?: (error: Error, connection: ClientConnection) => Promiseish<void>
    onServerError?: (error: Error) => Promiseish<void>
}

export type ActionForcePriority = "low" | "medium" | "high" | "critical"

export abstract class BaseNeuroServer {
    public readonly wss?: WebSocketServer
    private readonly connections: Map<string, ClientConnection> = new Map()
}

/** The NeuroServer is a class that receives connections from games and acts as Neuro */
export class NeuroServer {
    /** The WebSocket server */
    public readonly wss: WebSocketServer
    /** Actions currently registered per game */
    private readonly gameActions: Map<string, Map<string, Action>> = new Map()
    /** Currently connected clients */
    private readonly connections: Map<string, ClientConnection> = new Map()
    /** Event handlers */
    private readonly eventHandlers: ServerEventHandlers = {}
    /** Error handlers */
    private readonly errorHandlers: ServerErrorHandlers = {}
    /**
     * Extra configuration options for this server.
     * See {@link ExtraConfigOptions} for these config types.
     */
    private readonly extraConfigs?: ExtraConfigOptions

    /** 
     * Constructs a Neuro API server.
     * @param host The host to spawn the socket server on.
     * @param port The port to spawn the socket server on.
     * @param extraConfigs Extra configuration options. Currently mostly unused.
     */
    constructor(host = "127.0.0.1", port = 8000, extraConfigs?: ExtraConfigOptions) {
        if (extraConfigs) this.extraConfigs = extraConfigs
        this.wss = new WebSocketServer({ host, port }, extraConfigs?.onStartup)

        this.setupEventHandlers(extraConfigs?.onStartup)
        this.startHeartbeat()
    }

    /** Set event handlers for server events */
    public setEventHandlers(handlers: ServerEventHandlers): void {
        Object.assign(this.eventHandlers, handlers)
    }

    /** Set error handlers for server errors */
    public setErrorHandlers(handlers: ServerErrorHandlers): void {
        Object.assign(this.errorHandlers, handlers)
    }

    /** Get all actions for a specific game */
    public getGameActions(gameName: string): Action[] {
        const gameActions = this.gameActions.get(gameName)
        return gameActions ? Array.from(gameActions.values()) : []
    }

    /** Get currently connected clients for a game */
    public getConnectedClients(gameName?: string): ClientConnection[] {
        const clients = Array.from(this.connections.values())
        return gameName ? clients.filter(c => c.gameName === gameName) : clients
    }

    public registerEventHandler<const TCommand extends keyof ServerEventHandlers>(command: TCommand, handler: ServerEventHandlers[TCommand]) {
        this.eventHandlers[command] = handler
    }

    public registerErrorHandler<const TError extends keyof ServerErrorHandlers>(handlerKey: TError, handler: ServerErrorHandlers[TError]) {
        this.errorHandlers[handlerKey] = handler
    }

    /** Send a message to a specific connection */
    public sendToConnection(connectionId: string, message: OutgoingMessage): void {
        const connection = this.connections.get(connectionId)
        if (connection && connection.socket.readyState === WebSocket.OPEN) {
            connection.socket.send(JSON.stringify(message))
        }
    }

    /** Send a message to all connections of a specific game */
    public sendToGame(gameName: string, message: OutgoingMessage): void {
        this.getConnectedClients(gameName).forEach(connection => {
            if (connection.socket.readyState === WebSocket.OPEN) {
                connection.socket.send(JSON.stringify(message))
            }
        })
    }

    /** Send a message to all connections */
    public broadcast(message: OutgoingMessage): void {
        Array.from(this.connections.values()).forEach(connection => {
            if (connection.socket.readyState === WebSocket.OPEN) {
                connection.socket.send(JSON.stringify(message))
            }
        })
    }

    /** Send an action command to a specific game (server acting as Neuro) */
    public sendAction(gameName: string, actionId: string, actionName: string, actionData?: string): void {
        const message: OutgoingMessage = {
            command: 'action',
            data: {
                id: actionId,
                name: actionName,
                data: actionData
            }
        }
        this.sendToGame(gameName, message)
    }

    /** Request all actions to be reregistered (server acting as Neuro) */
    public requestReregisterAll(gameName?: string): void {
        const message: OutgoingMessage = { command: 'actions/reregister_all' }
        if (gameName) {
            this.sendToGame(gameName, message)
        } else {
            this.broadcast(message)
        }
    }

    /** Generate a unique action ID */
    public generateActionId(): string {
        return `action_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    }

    /** Setup WebSocket event handlers */
    private setupEventHandlers(onStartup?: () => void): void {
        this.wss.on('connection', (socket: WebSocket, _request: HttpIncomingMessage) => {
            const connectionId = crypto.randomUUID()
            const connection: ClientConnection = {
                id: connectionId,
                socket,
                isAlive: true
            }

            this.connections.set(connectionId, connection)

            console.log(`+ Connection ${connectionId} opened`)

            socket.on('message', async (data: Buffer) => {
                try {
                    const message: any = JSON.parse(data.toString())
                    await this.handleIncomingMessage(message, connection)
                } catch (error) {
                    console.error(`Error parsing message from connection ${connectionId}:`, error)
                    if (this.errorHandlers.onMessageParseError && error instanceof Error) {
                        await this.errorHandlers.onMessageParseError(error, data, connection)
                    }
                }
            })

            socket.on('close', () => {
                console.log(`- Connection ${connectionId} closed`)
                this.connections.delete(connectionId)
            })

            socket.on('error', async (error) => {
                console.error(`Connection ${connectionId} error:`, error)
                if (this.errorHandlers.onConnectionError) {
                    await this.errorHandlers.onConnectionError(error, connection)
                }
            })

            socket.on('pong', () => {
                connection.isAlive = true
            })

            // Send reregister_all command to new connections (deprecated behaviour now)
            this.sendToConnection(connectionId, { command: 'actions/reregister_all' })
        })

        this.wss.on('listening', () => {
            onStartup?.()
        })

        this.wss.on('error', async (error) => {
            console.error('WebSocket server error:', error)
            if (this.errorHandlers.onServerError) {
                await this.errorHandlers.onServerError(error)
            }
        })
    }

    /** Handle incoming messages from game clients */
    private async handleIncomingMessage(message: any, connection: ClientConnection): Promise<void> {
        console.log(`<-- [${connection.id}] ${message.command}`, message.data || {})

        // Set game name if provided
        if (message.game && !connection.gameName) {
            connection.gameName = message.game
        }

        const data = message.data
        const command = message.command

        try {
            switch (command) {
                case 'startup':
                    await this.handleStartup(data, connection)
                    break
                case 'context':
                    await this.handleContext(data, connection)
                    break
                case 'actions/register':
                    await this.handleActionsRegister(data, connection)
                    break
                case 'actions/unregister':
                    await this.handleActionsUnregister(data, connection)
                    break
                case 'actions/force':
                    await this.handleActionsForce(data, connection)
                    break
                case 'action/result':
                    await this.handleActionResult(data, connection)
                    break
                default:
                    console.warn(`Unknown command: ${command}`)
            }
        } catch (error) {
            console.error(`Error handling command ${command}:`, error)
            if (this.errorHandlers.onConnectionError && error instanceof Error) {
                await this.errorHandlers.onConnectionError(error, connection)
            }
        }
    }

    private async handleStartup(data: any, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) {
            const gameName = (data?.game as string) || 'unknown'
            console.log(`Connection ${connection.id} registered as game: ${gameName}`)
            connection.gameName = gameName
        }
        // Initialize action storage for this game
        if (!this.gameActions.has(connection.gameName)) {
            this.gameActions.set(connection.gameName, new Map())
        }

        // Call event handler if defined
        const startupData = await this.eventHandlers.onGameStartup?.(connection.gameName, connection)
        if (startupData) {
            connection.socket.send(JSON.stringify({ ...startupData, sessionId: connection.id }))
        }
    }

    private async handleContext(data: any, connection: ClientConnection): Promise<void> {
        console.log(`Context from ${connection.gameName}: ${data?.message} (silent: ${data?.silent})`)

        // Call event handler if defined
        if (connection.gameName) {
            await this.eventHandlers.onGameContext?.(connection.gameName, data?.message || '', data?.silent || false)
        }
    }

    private async handleActionsRegister(data: any, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) return

        const actions: Action[] = data?.actions || []
        const gameActions = this.gameActions.get(connection.gameName) || new Map()

        actions.forEach(action => {
            gameActions.set(action.name, action)
            console.log(`Registered action '${action.name}' for game '${connection.gameName}'`)
        })

        this.gameActions.set(connection.gameName, gameActions)

        // Call event handler if defined
        await this.eventHandlers.onActionsRegistered?.(connection.gameName, actions, connection)
    }

    private async handleActionsUnregister(data: any, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) return

        const actionNames: string[] = data?.action_names || []
        const gameActions = this.gameActions.get(connection.gameName)

        if (gameActions) {
            actionNames.forEach(name => {
                gameActions.delete(name)
                console.log(`Unregistered action '${name}' for game '${connection.gameName}'`)
            })

            // Call event handler if defined
            await this.eventHandlers.onActionsUnregistered?.(connection.gameName, actionNames)
        }
    }

    private async handleActionsForce(data: any, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) return

        const actionNames: string[] = data?.action_names || []
        const query: string = data?.query || ''
        const state: string | undefined = data?.state
        const ephemeralContext: boolean = data?.ephemeral_context || false
        const priority: ActionForcePriority = data?.priority || 'low'

        console.log(`Action force from ${connection.gameName}: ${query} (actions: ${actionNames.join(', ')})`)

        // Call event handler if defined
        const sentAction = await this.eventHandlers.onActionsForce?.(connection.gameName, query, actionNames, state, ephemeralContext, priority)
        if (sentAction) {
            this.sendAction(connection.gameName, sentAction.id, sentAction.name, sentAction.data)
        }
    }

    private async handleActionResult(data: any, connection: ClientConnection): Promise<void> {
        const id: string = data?.id || ''
        const success: boolean = data?.success || false
        const message: string = data?.message || ''

        console.log(`Action result from ${connection.gameName}: ${id} - ${success ? 'SUCCESS' : 'FAILURE'}: ${message}`)

        // Call event handler if defined
        if (connection.gameName) {
            await this.eventHandlers.onActionResult?.(connection.gameName, id, success, message)
        }
    }

    /** Start heartbeat to detect dead connections */
    private startHeartbeat(): void {
        setInterval(() => {
            if (!this.extraConfigs?.autoDetectDeadConnects) return;
            this.connections.forEach((connection, id) => {
                if (!connection.isAlive) {
                    console.log(`Connection ${id} failed heartbeat, terminating`)
                    connection.socket.terminate()
                    this.connections.delete(id)
                    return
                }

                connection.isAlive = false
                connection.socket.ping()
            })
        }, 30000) // 30 seconds
    }

    /** Close the server */
    public close(): Promise<void> {
        return new Promise((resolve) => {
            this.wss.close(() => {
                console.log('Neuro API server closed')
                resolve()
            })
        })
    }
}

interface VoiceServerInputs {
    host?: string
    port?: number
    spawnServer?: boolean
    onStartup?: () => void
}

export interface IncomingAudioFrame {
    version: 1;
    flags: number;
    speakerId: number;
    samples: Float32Array;
}

type IncomingVoicePackets = {
    command: "voice/start"
    game: string
} | {
    command: "voice/stop"
    game: string
} | {
    command: "voice/speakers/register"
    game: string
    data: {
        speakers: {
            id: number
            name: string
        }[]
    }
} | {
    command: "voice/speakers/unregister"
    game: string
    data: {
        ids: number[]
    }
} | ArrayBuffer

interface VoiceEventHandlers {
    onNewVoiceSession?: (game: string, connection: ClientConnection) => Promiseish<{ sample_rate: 48000, channels: 1 }>
    onStopVoiceSession?: (game: string) => Promiseish<void>
    onNewSpeakerRegistered?: (game: string, speakers: { id: number, name: string }[]) => Promiseish<void>
    onSpeakerUnregistered?: (game: string, speakerIds: number[]) => Promiseish<void>
    onAudioReceived?: (game: string, version: 1, flags: number, speakerId: number, audio: Float32Array) => Promiseish<void>
}

export class NeuroVoiceServer {
    public readonly wss?: WebSocketServer
    public readonly connections: Map<string, ClientConnection> = new Map()

    public readonly eventHandlers: VoiceEventHandlers = {}

    constructor({ host, port, spawnServer, onStartup }: VoiceServerInputs) {
        if (!spawnServer || spawnServer === true) {
            this.wss = new WebSocketServer({ host, port })
        }
        onStartup?.()
    }

    public decodeAudio(audio: ArrayBuffer): IncomingAudioFrame {
        if (audio.byteLength < 4) {
            throw new Error("Audio frame is too short");
        }

        const pcmBytes = audio.byteLength - 4
        if (pcmBytes % 4 !== 0) {
            throw new Error("PCm payload is not 4-byte aligned")
        }

        const view = new DataView(audio)

        const version = view.getUint8(0)

        if (version !== 1) {
            throw new Error(`Binary frame sent with unsupported protocol version ${version}`)
        }

        const flags = view.getUint8(1)
        if (flags !== 0) {
            console.warn("Binary frame sent unsupported flags, treating as if it were 0.")
        }

        const id = view.getUint16(2, true)

        const samples = new Float32Array(pcmBytes / 4)

        for (let i = 0; i < samples.length; i++) {
            samples[i] = view.getFloat32(4 + i * 4, true);
        }

        return {
            version,
            speakerId: id,
            flags,
            samples
        }
    }

    public async handle(game: string, data: IncomingVoicePackets, connection: ClientConnection): Promise<void> {
        if (data instanceof ArrayBuffer) {
            await this.handleAudio(game, data)
        } else {
            switch (data.command) {
                case 'voice/start': {
                    const sessionData = await this.eventHandlers.onNewVoiceSession?.(data.game, connection)
                    connection.socket.send(JSON.stringify(sessionData))
                    break;
                }
                case 'voice/stop':
                    await this.eventHandlers.onStopVoiceSession?.(data.game)
                    break;
                case 'voice/speakers/register':
                    await this.eventHandlers.onNewSpeakerRegistered?.(data.game, data.data.speakers)
                    break;
                case 'voice/speakers/unregister':
                    await this.eventHandlers.onSpeakerUnregistered?.(data.game, data.data.ids)
                    break;
            }
        }
    }

    public registerEventHandler<const TEvents extends keyof VoiceEventHandlers>(event: TEvents, handler: VoiceEventHandlers[TEvents]): void {
        this.eventHandlers[event] = handler
    }

    public async handleAudio(game: string, audio: ArrayBuffer): Promise<void> {
        const audioData = this.decodeAudio(audio)
        await this.eventHandlers.onAudioReceived?.(game, audioData.version, audioData.flags, audioData.speakerId, audioData.samples)
    }

    public encodeAudio(audio: Float32Array): ArrayBuffer {
        const buffer = new ArrayBuffer(audio.length * 4)
        const view = new DataView(buffer)

        let offset = 0;

        for (const a of audio) {
            view.setFloat32(offset, a, true);
            offset += 4;
        }

        return buffer;
    }

    public sendAudio(game: string, audio: Float32Array): void {
        const buffer = this.encodeAudio(audio)
        const client = this.getConnectedClients(game)

        client.forEach((c) => {
            if (c.socket.readyState === WebSocket.OPEN) {
                c.socket.send(buffer)
            }
        })
    }

    /** Get currently connected clients for a game */
    public getConnectedClients(gameName?: string): ClientConnection[] {
        const clients = Array.from(this.connections.values())
        return gameName ? clients.filter(c => c.gameName === gameName) : clients
    }

    public broadcastAudio(audio: Float32Array): void {
        const buffer = this.encodeAudio(audio)
        const client = this.getConnectedClients()

        client.forEach((c) => {
            if (c.socket.readyState === WebSocket.OPEN) {
                c.socket.send(buffer)
            }
        })
    }
}
