import { WebSocketServer, WebSocket } from 'ws'
import crypto from 'node:crypto'
import type { IncomingMessage as HttpIncomingMessage } from 'http'

// Message types come from `neuro-api-types`, which names them from the *game's*
// perspective: "outgoing" messages are sent by the game to Neuro, and
// "incoming" messages are sent by Neuro to the game. This package implements
// the Neuro side, so the directions are flipped here: we receive the game's
// outgoing messages, and we send the game's incoming messages.
import type { BaseIncomingMessage } from 'neuro-api-types'
import type {
    Action,
    ActionMessage,
    ActionResultMessage,
    ForceActionMessage,
    RegisterActionMessage,
    UnregisterActionMessage,
} from 'neuro-api-types/actions'
import type {
    ContextMessage,
    SpeechEndedMessage,
    SpeechStartedMessage,
} from 'neuro-api-types/context'
import type { StartupAcknowledgementMessage, StartupMessage } from 'neuro-api-types/startup'
import type {
    AllOutgoingControlPackets,
    AudioToServerFrames,
    RegisterSpeakersMessage,
    SpeakingCancelledMessage,
    SpeakingIndicatorMessage,
    UnregisterSpeakersMessage,
    VoiceReadyMessage,
    VoiceStartMessage,
    VoiceStopMessage,
    VoiceUnavailableMessage,
} from 'neuro-api-types/voice'
import type { ReregisterAllActionsMessage } from 'neuro-api-types/proposals'
import type { SpeechFinishedMessage } from 'neuro-api-types/voice'

/**
 * How urgently Neuro should respond to an `actions/force`.
 * @see https://github.com/VedalAI/neuro-sdk/blob/main/API/SPECIFICATION.md#force-actions
 */
export type ActionForcePriority = NonNullable<ForceActionMessage['data']['priority']>

/**
 * Every known message a game can send to this server, per the Neuro API
 * specification.
 *
 * Messages with an unrecognized command are not part of this union; per the
 * specification they are silently ignored.
 */
export type GameToServerMessage =
    | StartupMessage
    | ContextMessage
    | SpeechStartedMessage
    | SpeechEndedMessage
    | RegisterActionMessage
    | UnregisterActionMessage
    | ForceActionMessage
    | ActionResultMessage

/**
 * An action to send to a game in response to an actions force.
 */
export interface ActionToSend {
    /** A unique id for this action attempt. See {@link NeuroServer.generateActionId}. */
    id: string
    /** The name of the action to execute. */
    name: string
    /** The JSON-stringified parameters for the action, if any. */
    data?: string
}

/**
 * Character info to include in a startup acknowledgement.
 */
export type StartupSessionInfo = Pick<StartupAcknowledgementMessage['data']['session'], 'characterId' | 'displayName'>

/** Matches the voice chat connection path, `/game/<url-encoded game name>/voice`. */
const VOICE_PATH_PATTERN = /^\/game\/(.+)\/voice\/?$/

/**
 * Extract the game name from a voice chat connection path
 * (`/game/<url-encoded game name>/voice`), or `undefined` if the path is not
 * a voice chat path.
 */
function parseVoicePath(url: string | undefined): string | undefined {
    if (!url) return undefined
    let pathname: string
    try {
        pathname = new URL(url, 'http://localhost').pathname
    } catch {
        return undefined
    }
    const encoded = VOICE_PATH_PATTERN.exec(pathname)?.[1]
    if (encoded === undefined) return undefined
    try {
        return decodeURIComponent(encoded)
    } catch {
        return undefined
    }
}

export interface ExtraConfigOptions {
    /** A function that is ran upon the server starting successfully. */
    onStartup?: () => void
    /** Whether this is a test mode. Useful for automated testing purposes. */
    test?: boolean
    /** Whether or not the server should support multi-connects. Defaults to `false` since for most purposes you shouldn't be needing this. */
    multiConnect?: boolean
    /** Whether or not to automatically detect dead connections. Defaults to `false`. */
    autoDetectDeadConnects?: boolean
    /**
     * A {@link NeuroVoiceServer} to serve voice chat connections on this
     * server's port. When provided, connections to `/game/<name>/voice` are
     * routed to it; when omitted, they are rejected so that games can
     * gracefully continue without voice. It can also be attached later with
     * {@link NeuroServer.attachVoiceServer}.
     */
    voiceServer?: NeuroVoiceServer
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
    onGameStartup?: (gameName: string, connection: ClientConnection) => Promiseish<StartupSessionInfo | void>
    onGameContext?: (gameName: string, message: string, silent: boolean) => Promiseish<void>
    /** Called when a game reports that a line of in-game dialogue (an NPC, a narrator, a cutscene) has started being spoken out loud. */
    onSpeechStarted?: (gameName: string, speech: SpeechStartedMessage['data'], connection: ClientConnection) => Promiseish<void>
    /** Called when a game reports that a line previously reported with `speech/started` has stopped, either because it finished or because it was skipped. */
    onSpeechEnded?: (gameName: string, speechId: string, connection: ClientConnection) => Promiseish<void>
    onActionsRegistered?: (gameName: string, actions: Action[], connection: ClientConnection) => Promiseish<void>
    onActionsUnregistered?: (gameName: string, actionNames: string[]) => Promiseish<void>
    onActionsForce?: (gameName: string, query: string, actionNames: string[], state?: string, ephemeralContext?: boolean, priority?: ActionForcePriority, silent?: boolean) => Promiseish<ActionToSend | void>
    onActionResult?: (gameName: string, actionId: string, success: boolean, message?: string) => Promiseish<void>
}

// Error handlers for server errors
export interface ServerErrorHandlers {
    onMessageParseError?: (error: Error, rawData: Buffer, connection: ClientConnection) => Promiseish<void>
    onConnectionError?: (error: Error, connection: ClientConnection) => Promiseish<void>
    onServerError?: (error: Error) => Promiseish<void>
}

/** The NeuroServer is a class that receives connections from games and acts as Neuro */
export class NeuroServer {
    /** The WebSocket server */
    public readonly wss: WebSocketServer
    /** Actions currently registered per game */
    private readonly gameActions: Map<string, Map<string, Action>> = new Map()
    /** Currently connected clients */
    public readonly connections: Map<string, ClientConnection> = new Map()
    /** Event handlers */
    private readonly eventHandlers: ServerEventHandlers = {}
    /** Error handlers */
    private readonly errorHandlers: ServerErrorHandlers = {}
    /**
     * Extra configuration options for this server.
     * See {@link ExtraConfigOptions} for these config types.
     */
    private readonly extraConfigs?: ExtraConfigOptions
    /** The attached voice server, if any. See {@link NeuroServer.attachVoiceServer}. */
    private voiceServer?: NeuroVoiceServer | undefined

    /**
     * Constructs a Neuro API server.
     * @param host The host to spawn the socket server on.
     * @param port The port to spawn the socket server on.
     * @param extraConfigs Extra configuration options. Currently mostly unused.
     */
    constructor(host = "127.0.0.1", port = 8000, extraConfigs?: ExtraConfigOptions) {
        if (extraConfigs) this.extraConfigs = extraConfigs
        this.voiceServer = extraConfigs?.voiceServer
        this.wss = new WebSocketServer({ host, port })

        this.setupEventHandlers(extraConfigs?.onStartup)
        this.startHeartbeat()
    }

    /**
     * Attach a {@link NeuroVoiceServer} to serve voice chat connections on
     * this server's port. Voice chat connections (`/game/<name>/voice`) are
     * routed to it, and are paired with this server's connections by game
     * name. Equivalent to passing `voiceServer` in the extra config options.
     * @param voiceServer The voice server to attach.
     */
    public attachVoiceServer(voiceServer: NeuroVoiceServer): void {
        this.voiceServer = voiceServer
    }

    /**
     * Detach the currently attached voice server, if any. Voice chat
     * connections are rejected afterwards, so games gracefully continue
     * without voice.
     */
    public detachVoiceServer(): void {
        this.voiceServer = undefined
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
    public sendToConnection(connectionId: string, message: BaseIncomingMessage): void {
        const connection = this.connections.get(connectionId)
        if (connection && connection.socket.readyState === WebSocket.OPEN) {
            connection.socket.send(JSON.stringify(message))
        }
    }

    /** Send a message to all connections of a specific game */
    public sendToGame(gameName: string, message: BaseIncomingMessage): void {
        this.getConnectedClients(gameName).forEach(connection => {
            if (connection.socket.readyState === WebSocket.OPEN) {
                connection.socket.send(JSON.stringify(message))
            }
        })
    }

    /** Send a message to all connections */
    public broadcast(message: BaseIncomingMessage): void {
        Array.from(this.connections.values()).forEach(connection => {
            if (connection.socket.readyState === WebSocket.OPEN) {
                connection.socket.send(JSON.stringify(message))
            }
        })
    }

    /** Send an `action` message to a specific game (server acting as Neuro). */
    public sendAction(gameName: string, actionId: string, actionName: string, actionData?: string): void {
        const message: ActionMessage = {
            command: 'action',
            data: {
                id: actionId,
                name: actionName,
            },
        }
        if (actionData !== undefined) message.data.data = actionData
        this.sendToGame(gameName, message)
    }

    /**
     * Send a `speech_finished` message to a specific game (server acting as Neuro).
     * @param gameName The game to send the message to.
     * @param isFinal Whether Neuro has finished what she is currently saying. Games wait for this to be `true`.
     * @param cancelled Set to `true` if her speech was cut off instead of completing normally.
     * @param reason If cancelled, a short description of why (e.g. `"interrupted"`).
     */
    public sendSpeechFinished(gameName: string, isFinal: boolean, cancelled?: boolean, reason?: string): void {
        const message: SpeechFinishedMessage = {
            command: 'speech_finished',
            data: {
                isFinal,
            },
        }
        if (cancelled !== undefined) message.data.cancelled = cancelled
        if (reason !== undefined) message.data.reason = reason
        this.sendToGame(gameName, message)
    }

    /**
     * Request all actions to be reregistered (server acting as Neuro).
     *
     * Note that `actions/reregister_all` is part of the [API
     * proposals](https://github.com/VedalAI/neuro-sdk/blob/main/API/PROPOSALS.md#reregister-all-actions),
     * and is not part of the specification proper. Games may silently ignore it.
     */
    public requestReregisterAll(gameName?: string): void {
        const message: ReregisterAllActionsMessage = { command: 'actions/reregister_all' }
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
        this.wss.on('connection', (socket: WebSocket, request: HttpIncomingMessage) => {
            // Voice chat runs on its own path, `/game/<name>/voice`, per the
            // voice chat specification. Route those connections to the
            // attached voice server if there is one, and reject them
            // otherwise so that games gracefully continue without voice.
            if (parseVoicePath(request.url) !== undefined) {
                const voiceServer = this.voiceServer
                if (voiceServer) {
                    voiceServer.handleVoiceConnection(socket, request)
                } else {
                    console.log(`+ Voice connection rejected, no voice server attached: '${request.url ?? ''}'`)
                    socket.close()
                }
                return
            }

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
                    const message = JSON.parse(data.toString()) as GameToServerMessage
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
    private async handleIncomingMessage(message: GameToServerMessage, connection: ClientConnection): Promise<void> {
        console.log(`<-- [${connection.id}] ${message.command}`, message.data || {})

        // Set game name if provided. Per the specification it should always be
        // the same, so only the first value is kept.
        if (message.game && !connection.gameName) {
            connection.gameName = message.game
        }

        const command = message.command

        try {
            switch (command) {
                case 'startup':
                    await this.handleStartup(message, connection)
                    break
                case 'context':
                    await this.handleContext(message, connection)
                    break
                case 'speech/started':
                    await this.handleSpeechStarted(message, connection)
                    break
                case 'speech/ended':
                    await this.handleSpeechEnded(message, connection)
                    break
                case 'actions/register':
                    await this.handleActionsRegister(message, connection)
                    break
                case 'actions/unregister':
                    await this.handleActionsUnregister(message, connection)
                    break
                case 'actions/force':
                    await this.handleActionsForce(message, connection)
                    break
                case 'action/result':
                    await this.handleActionResult(message, connection)
                    break
                default:
                    console.warn('Unknown command:', command)
            }
        } catch (error) {
            console.error(`Error handling command ${command}:`, error)
            if (this.errorHandlers.onConnectionError && error instanceof Error) {
                await this.errorHandlers.onConnectionError(error, connection)
            }
        }
    }

    private async handleStartup(message: StartupMessage, connection: ClientConnection): Promise<void> {
        // The game name is a top-level field on every message, and is captured
        // by `handleIncomingMessage` before dispatching.
        const gameName = connection.gameName ?? message.game
        if (!gameName) return
        connection.gameName = gameName
        console.log(`Connection ${connection.id} registered as game: ${gameName}`)

        // Per the specification, startup clears all previously registered
        // actions for this game. Only this game's actions are affected.
        this.gameActions.set(gameName, new Map())

        // Call event handler if defined
        const sessionInfo = await this.eventHandlers.onGameStartup?.(gameName, connection)
        if (sessionInfo) {
            // Startup acknowledgement, per the specification:
            // https://github.com/VedalAI/neuro-sdk/blob/main/API/SPECIFICATION.md#startup-acknowledgement
            const acknowledgement: StartupAcknowledgementMessage = {
                command: 'startup',
                data: {
                    session: {
                        sessionId: connection.id,
                        characterId: sessionInfo.characterId,
                        displayName: sessionInfo.displayName,
                    },
                },
            }
            connection.socket.send(JSON.stringify(acknowledgement))
        }
    }

    private async handleContext(message: ContextMessage, connection: ClientConnection): Promise<void> {
        console.log(`Context from ${connection.gameName}: ${message.data.message} (silent: ${String(message.data.silent)})`)

        // Call event handler if defined
        if (connection.gameName) {
            await this.eventHandlers.onGameContext?.(connection.gameName, message.data.message, message.data.silent)
        }
    }

    private async handleSpeechStarted(message: SpeechStartedMessage, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) return

        console.log(`Speech started in ${connection.gameName}: ${message.data.speaker}: ${message.data.text ?? '(no text)'}`)

        await this.eventHandlers.onSpeechStarted?.(connection.gameName, message.data, connection)
    }

    private async handleSpeechEnded(message: SpeechEndedMessage, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) return

        console.log(`Speech ended in ${connection.gameName}: ${message.data.id}`)

        await this.eventHandlers.onSpeechEnded?.(connection.gameName, message.data.id, connection)
    }

    private async handleActionsRegister(message: RegisterActionMessage, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) return

        const actions = message.data.actions
        const gameActions = this.gameActions.get(connection.gameName) || new Map()

        actions.forEach(action => {
            gameActions.set(action.name, action)
            console.log(`Registered action '${action.name}' for game '${connection.gameName}'`)
        })

        this.gameActions.set(connection.gameName, gameActions)

        // Call event handler if defined
        await this.eventHandlers.onActionsRegistered?.(connection.gameName, actions, connection)
    }

    private async handleActionsUnregister(message: UnregisterActionMessage, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) return

        const actionNames = message.data.action_names
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

    private async handleActionsForce(message: ForceActionMessage, connection: ClientConnection): Promise<void> {
        if (!connection.gameName) return

        const actionNames = message.data.action_names
        const query = message.data.query
        const state = message.data.state
        const ephemeralContext = message.data.ephemeral_context ?? false
        const priority = message.data.priority ?? 'low'
        const silent = message.data.silent ?? false

        console.log(`Action force from ${connection.gameName}: ${query} (actions: ${actionNames.join(', ')})`)

        // Call event handler if defined
        const sentAction = await this.eventHandlers.onActionsForce?.(connection.gameName, query, actionNames, state, ephemeralContext, priority, silent)
        if (sentAction) {
            this.sendAction(connection.gameName, sentAction.id, sentAction.name, sentAction.data)
        }
    }

    private async handleActionResult(message: ActionResultMessage, connection: ClientConnection): Promise<void> {
        const id = message.data.id
        const success = message.data.success
        const resultMessage = message.data.message ?? ''

        console.log(`Action result from ${connection.gameName}: ${id} - ${success ? 'SUCCESS' : 'FAILURE'}: ${resultMessage}`)

        // Call event handler if defined
        if (connection.gameName) {
            await this.eventHandlers.onActionResult?.(connection.gameName, id, success, resultMessage)
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
    /**
     * Whether to spawn a dedicated WebSocket server for voice. Defaults to
     * `true`. Set to `false` when attaching to a `NeuroServer` via its
     * `voiceServer` config option, or when wiring connections yourself.
     */
    spawnServer?: boolean
    /**
     * The maximum number of concurrent registered speakers. Defaults to `32`,
     * per the voice chat specification.
     */
    maxSpeakers?: number
    onStartup?: () => void
}

export interface IncomingAudioFrame {
    version: 1;
    flags: number;
    speakerId: number;
    samples: Float32Array;
}

/**
 * Every packet a game can send on a voice connection: JSON control packets
 * (from `neuro-api-types`), or a binary audio frame.
 */
export type IncomingVoicePackets = AllOutgoingControlPackets | AudioToServerFrames

interface VoiceEventHandlers {
    onNewVoiceSession?: (game: string, connection: ClientConnection) => Promiseish<({ success: true } & VoiceReadyMessage['data']) | { success: false, reason: string }>
    onStopVoiceSession?: (game: string) => Promiseish<void>
    onNewSpeakerRegistered?: (game: string, speakers: RegisterSpeakersMessage['data']['speakers']) => Promiseish<void>
    onSpeakerUnregistered?: (game: string, speakerIds: number[]) => Promiseish<void>
    onAudioReceived?: (game: string, version: 1, flags: number, speakerId: number, audio: Float32Array) => Promiseish<void>
}

export class NeuroVoiceServer {
    public readonly wss?: WebSocketServer
    public readonly connections: Map<string, ClientConnection> = new Map()
    /** Connection ids with an active voice session (between `voice/ready` and `voice/stop`). */
    private readonly activeSessions: Set<string> = new Set()
    /**
     * The maximum number of concurrent registered speakers.
     * Defaults to `32`, per the voice chat specification.
     * See {@link VoiceServerInputs.maxSpeakers}.
     */
    public readonly maxSpeakers: number

    public readonly eventHandlers: VoiceEventHandlers = {}
    public readonly speakers: Map<number, string> = new Map()

    constructor({ host, port, spawnServer, maxSpeakers, onStartup }: VoiceServerInputs) {
        this.maxSpeakers = maxSpeakers ?? 32  // spec cap is 32
        if (spawnServer !== false) {
            this.wss = new WebSocketServer({ host, port })
        }
        this.setupEventHandlers(onStartup)
    }

    /**
     * Handle a WebSocket connection on a voice chat path,
     * `/game/<url-encoded game name>/voice`. Connections on any other path
     * are rejected.
     */
    public handleVoiceConnection(socket: WebSocket, request: HttpIncomingMessage): void {
        const gameName = parseVoicePath(request.url)
        if (gameName === undefined) {
            console.log(`+ Voice connection rejected, unexpected path: '${request.url ?? ''}'`)
            socket.close()
            return
        }
        this.registerConnection(socket, gameName)
    }

    /** Setup the WebSocket server event handlers, if the server owns one. */
    private setupEventHandlers(onStartup?: () => void): void {
        if (!this.wss) {
            onStartup?.()
            return
        }

        this.wss.on('listening', () => {
            onStartup?.()
        })

        this.wss.on('error', (error) => {
            console.error('Voice WebSocket server error:', error)
        })

        this.wss.on('connection', (socket: WebSocket, request: HttpIncomingMessage) => this.handleVoiceConnection(socket, request))
    }

    /** Register a new voice connection and set up its socket event handlers. */
    private registerConnection(socket: WebSocket, gameName: string): void {
        const connectionId = crypto.randomUUID()
        const connection: ClientConnection = {
            id: connectionId,
            socket,
            gameName,
            isAlive: true
        }

        this.connections.set(connectionId, connection)

        console.log(`+ Voice connection ${connectionId} opened for game '${gameName}'`)

        socket.on('message', async (data: Buffer, isBinary: boolean) => {
            try {
                if (isBinary) {
                    const audio = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
                    await this.handleAudio(gameName, audio)
                } else {
                    const packet = JSON.parse(data.toString()) as VoiceStartMessage | VoiceStopMessage | RegisterSpeakersMessage | UnregisterSpeakersMessage
                    await this.handle(gameName, packet, connection)
                }
            } catch (error) {
                console.error(`Error handling voice message from connection ${connectionId}:`, error)
            }
        })

        socket.on('close', () => {
            console.log(`- Voice connection ${connectionId} closed`)
            this.connections.delete(connectionId)
            this.activeSessions.delete(connectionId)
        })

        socket.on('error', (error) => {
            console.error(`Voice connection ${connectionId} error:`, error)
        })
    }

    public decodeAudio(audio: ArrayBuffer): IncomingAudioFrame {
        if (audio.byteLength < 4) {
            throw new Error("Audio frame is too short");
        }

        const pcmBytes = audio.byteLength - 4
        if (pcmBytes % 4 !== 0) {
            throw new Error("PCM payload is not 4-byte aligned")
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
            const command = data.command
            switch (command) {
                case 'voice/start': {
                    await this.handleNewSession(data, connection)
                    break;
                }
                case 'voice/stop':
                    await this.handleStopSession(data, connection)
                    break;
                case 'voice/speakers/register':
                    await this.handleNewSpeaker(data)
                    break;
                case 'voice/speakers/unregister':
                    await this.handleRemovedSpeaker(data)
                    break;
                default:
                    console.warn('Unknown voice command:', command)
            }
        }
    }

    public registerEventHandler<const TEvents extends keyof VoiceEventHandlers>(event: TEvents, handler: VoiceEventHandlers[TEvents]): void {
        this.eventHandlers[event] = handler
    }

    public async handleAudio(game: string, audio: ArrayBuffer): Promise<void> {
        const audioData = this.decodeAudio(audio)
        // Per the specification, audio for unregistered speakers is dropped.
        if (!this.speakers.has(audioData.speakerId)) return
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
        const client = this.getActiveVoiceClients(game)

        client.forEach((c) => {
            if (c.socket.readyState === WebSocket.OPEN) {
                const speakingStart: SpeakingIndicatorMessage = { command: "voice/speaking", data: { speaking: true } }
                c.socket.send(JSON.stringify(speakingStart))
                c.socket.send(buffer)
                const speakingEnd: SpeakingIndicatorMessage = { command: "voice/speaking", data: { speaking: false } }
                c.socket.send(JSON.stringify(speakingEnd))
            }
        })
    }

    /**
     * Tell a game that Neuro's speech was interrupted, so it should
     * immediately discard any buffered downstream audio and release
     * push-to-talk.
     */
    public sendCancelled(gameName: string): void {
        const message: SpeakingCancelledMessage = { command: 'voice/cancelled' }
        this.getActiveVoiceClients(gameName).forEach((c) => {
            if (c.socket.readyState === WebSocket.OPEN) {
                c.socket.send(JSON.stringify(message))
            }
        })
    }

    /** Get currently connected clients for a game */
    public getConnectedClients(gameName?: string): ClientConnection[] {
        const clients = Array.from(this.connections.values())
        return gameName ? clients.filter(c => c.gameName === gameName) : clients
    }

    /** Get connections with an active voice session, optionally for a specific game. */
    private getActiveVoiceClients(gameName?: string): ClientConnection[] {
        return this.getConnectedClients(gameName).filter(c => this.activeSessions.has(c.id))
    }

    private async handleNewSession(data: VoiceStartMessage, client: ClientConnection) {
        if (!client.gameName) {
            const gameName = data.game
            console.log('[NeuroVoiceClient] New session started for ' + gameName)
            client.gameName = gameName
        }

        const details = await this.eventHandlers.onNewVoiceSession?.(client.gameName, client)

        if (details?.success) {
            const ready: VoiceReadyMessage = {
                command: 'voice/ready',
                data: {
                    sample_rate: details.sample_rate,
                    channels: details.channels,
                },
            }
            client.socket.send(JSON.stringify(ready))
            this.connections.set(client.id, client)
            this.activeSessions.add(client.id)
        } else {
            const unavailable: VoiceUnavailableMessage = { command: 'voice/unavailable' }
            if (details) unavailable.data = { reason: details.reason }
            client.socket.send(JSON.stringify(unavailable))
            // Per the specification, the server closes the socket after
            // sending voice/unavailable.
            client.socket.close()
        }
    }

    private async handleStopSession(data: VoiceStopMessage, connection: ClientConnection): Promise<void> {
        await this.eventHandlers.onStopVoiceSession?.(data.game)
        // The session ends, but the socket stays usable for a fresh voice/start.
        this.activeSessions.delete(connection.id)
    }

    private async handleNewSpeaker(data: RegisterSpeakersMessage) {
        await this.eventHandlers.onNewSpeakerRegistered?.(data.game, data.data.speakers)
        data.data.speakers.forEach((s) => {
            // Re-registering an existing id just renames the speaker, but new
            // ids are capped.
            if (!this.speakers.has(s.id) && this.speakers.size >= this.maxSpeakers) {
                console.warn(`Cannot register speaker '${s.name}' (${s.id}): speaker cap of ${this.maxSpeakers} reached`)
                return
            }
            this.speakers.set(s.id, s.name)
        })
    }

    private async handleRemovedSpeaker(data: UnregisterSpeakersMessage) {
        await this.eventHandlers.onSpeakerUnregistered?.(data.game, data.data.ids)
        data.data.ids.forEach((i) => this.speakers.delete(i))
    }

    public broadcastAudio(audio: Float32Array): void {
        const buffer = this.encodeAudio(audio)
        const client = this.getActiveVoiceClients()

        client.forEach((c) => {
            if (c.socket.readyState === WebSocket.OPEN) {
                c.socket.send(buffer)
            }
        })
    }
}
