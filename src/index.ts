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

// Event handlers for server events
export interface ServerEventHandlers {
    onGameStartup?: (gameName: string, connection: ClientConnection) => { characterId: string; displayName: string; } | void
    onGameContext?: (gameName: string, message: string, silent: boolean, connection: ClientConnection) => void
    onActionsRegistered?: (gameName: string, actions: Action[], connection: ClientConnection) => void
    onActionsUnregistered?: (gameName: string, actionNames: string[], connection: ClientConnection) => void
    onActionsForce?: (gameName: string, query: string, actionNames: string[], state?: string, ephemeralContext?: boolean, priority?: ActionForcePriority) => { id: string, name: string, data?: any }
    onActionResult?: (gameName: string, actionId: string, success: boolean, message?: string) => void
}

// Error handlers for server errors
export interface ServerErrorHandlers {
    onMessageParseError?: (error: Error, rawData: Buffer, connection: ClientConnection) => void
    onConnectionError?: (error: Error, connection: ClientConnection) => void
    onServerError?: (error: Error) => void
}

export type ActionForcePriority = "low" | "medium" | "high" | "critical"

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
                        this.errorHandlers.onMessageParseError(error, data, connection)
                    }
                }
            })

            socket.on('close', () => {
                console.log(`- Connection ${connectionId} closed`)
                this.connections.delete(connectionId)
            })

            socket.on('error', (error) => {
                console.error(`Connection ${connectionId} error:`, error)
                if (this.errorHandlers.onConnectionError) {
                    this.errorHandlers.onConnectionError(error, connection)
                }
            })

            socket.on('pong', () => {
                connection.isAlive = true
            })

            // Send reregister_all command to new connections (deprecated behaviour now)
            this.sendToConnection(connectionId, { command: 'actions/reregister_all' })
        })

        this.wss.on('listening', () => {
            const address = this.wss.address()
            onStartup?.()
        })

        this.wss.on('error', (error) => {
            console.error('WebSocket server error:', error)
            if (this.errorHandlers.onServerError) {
                this.errorHandlers.onServerError(error)
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
                this.errorHandlers.onConnectionError(error, connection)
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
        const startupData = this.eventHandlers.onGameStartup?.(connection.gameName, connection)
        if (startupData) {
            connection.socket.send(JSON.stringify({ ...startupData, sessionId: connection.id }))
        }
    }

    private async handleContext(data: any, connection: ClientConnection): Promise<void> {
        console.log(`Context from ${connection.gameName}: ${data?.message} (silent: ${data?.silent})`)

        // Call event handler if defined
        if (connection.gameName) {
            this.eventHandlers.onGameContext?.(connection.gameName, data?.message || '', data?.silent || false, connection)
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
        this.eventHandlers.onActionsRegistered?.(connection.gameName, actions, connection)
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
            this.eventHandlers.onActionsUnregistered?.(connection.gameName, actionNames, connection)
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
        const sentAction = this.eventHandlers.onActionsForce?.(connection.gameName, query, actionNames, state, ephemeralContext, priority)
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
            this.eventHandlers.onActionResult?.(connection.gameName, id, success, message)
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
