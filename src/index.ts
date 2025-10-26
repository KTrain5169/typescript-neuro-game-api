import { WebSocketServer, WebSocket } from 'ws'
import type { JSONSchema7 } from 'json-schema'
import type { IncomingMessage as HttpIncomingMessage } from 'http'

// Type definitions for messages received from games
export interface Action {
    name: string
    description: string
    schema?: Omit<JSONSchema7, 'type'> & { type: 'object' }
}

export interface ExtraConfigOptions {
    /** Whether this is a test mode. Useful for automated testing purposes. */
    test?: boolean
    /** Whether or not the server should support multi-connects. Defaults to `false` since for most purposes you shouldn't be needing this. */
    multiConnect?: boolean
}

// Message types (what the server sends TO games)
export interface OutgoingMessage {
    command: string
    data?: { [key: string]: any }
}

// Connection interface
export interface ClientConnection {
    id: number
    socket: WebSocket
    gameName?: string
    isAlive: boolean
}

// Event handlers for server events
export interface ServerEventHandlers {
    onGameStartup?: (gameName: string, connection: ClientConnection) => void
    onGameContext?: (gameName: string, message: string, silent: boolean, connection: ClientConnection) => void
    onActionsRegistered?: (gameName: string, actions: Action[], connection: ClientConnection) => void
    onActionsUnregistered?: (gameName: string, actionNames: string[], connection: ClientConnection) => void
    onActionsForce?: (gameName: string, query: string, actionNames: string[], state?: string, ephemeralContext?: boolean) => void
    onActionResult?: (gameName: string, actionId: string, success: boolean, message?: string) => void
}

// Command handler for incoming messages from games
export class CommandHandler {
    private handlers: Map<string, (data: any, connection: ClientConnection) => Promise<void>> = new Map()

    registerHandler(command: string, handler: (data: any, connection: ClientConnection) => Promise<void>): void {
        this.handlers.set(command, handler)
    }

    async handle(command: string, data: any, connection: ClientConnection): Promise<void> {
        const handler = this.handlers.get(command)
        if (handler) {
            try {
                await handler(data, connection)
            } catch (error) {
                console.error(`Error handling command ${command}:`, error)
            }
        } else {
            console.warn(`Unknown command: ${command}`)
        }
    }
}

/** The NeuroServer is a class that receives connections from games and acts as Neuro */
export class NeuroServer {
    /** The WebSocket server */
    public readonly wss: WebSocketServer
    /** Actions currently registered per game */
    private readonly gameActions: Map<string, Map<string, Action>> = new Map()
    /** Currently connected clients */
    private readonly connections: Map<number, ClientConnection> = new Map()
    /** Command handler */
    private readonly commandHandler: CommandHandler = new CommandHandler()
    /** Connection ID counter */
    private connectionIdCounter = 0
    /** Event handlers */
    private readonly eventHandlers: ServerEventHandlers = {}
    /**
     * Extra configuration options for this server.
     * See {@link ExtraConfigOptions} for these config types.
     */
    private readonly extraConfigs?: ExtraConfigOptions

    /** 
     * Constructs a Neuro API server.
     * @param host The host to spawn the socket server on.
     * @param port The port to spawn the socket server on.
     * @param onStartup A function to run when the server starts listening.
     * @param extraConfigs Extra configuration options. Currently unused.
     */
    constructor(host = "127.0.0.1", port = 8000, onStartup?: () => void, extraConfigs?: ExtraConfigOptions) {
        if (extraConfigs) this.extraConfigs = extraConfigs
        this.wss = new WebSocketServer({ host, port }, onStartup)

        this.setupEventHandlers(onStartup)
        this.setupCommandHandlers()
        this.startHeartbeat()
    }

    /** Set event handlers for server events */
    public setEventHandlers(handlers: ServerEventHandlers): void {
        Object.assign(this.eventHandlers, handlers)
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

    /** Get the command handler for registering custom handlers */
    public getCommandHandler(): CommandHandler {
        return this.commandHandler
    }

    /** Send a message to a specific connection */
    public sendToConnection(connectionId: number, message: OutgoingMessage): void {
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
            const connectionId = ++this.connectionIdCounter
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
                }
            })

            socket.on('close', () => {
                console.log(`- Connection ${connectionId} closed`)
                this.connections.delete(connectionId)
            })

            socket.on('error', (error) => {
                console.error(`Connection ${connectionId} error:`, error)
            })

            socket.on('pong', () => {
                connection.isAlive = true
            })

            // Send reregister_all command to new connections
            this.sendToConnection(connectionId, { command: 'actions/reregister_all' })
        })

        this.wss.on('listening', () => {
            const address = this.wss.address()
            onStartup?.()
        })
    }

    private setupCommandHandlers(): void {
        // Handle startup messages
        this.commandHandler.registerHandler('startup', async (data: any, connection: ClientConnection) => {
            if (!connection.gameName) {
                const gameName = data?.game || 'unknown'
                console.log(`Connection ${connection.id} registered as game: ${gameName}`)
                connection.gameName = gameName

                // Initialize action storage for this game
                if (!this.gameActions.has(gameName)) {
                    this.gameActions.set(gameName, new Map())
                }

                // Call event handler if defined
                this.eventHandlers.onGameStartup?.(gameName, connection)
            }
        })

        // Handle context messages
        this.commandHandler.registerHandler('context', async (data: any, connection: ClientConnection) => {
            console.log(`Context from ${connection.gameName}: ${data?.message} (silent: ${data?.silent})`)

            // Call event handler if defined
            if (connection.gameName) {
                this.eventHandlers.onGameContext?.(connection.gameName, data?.message || '', data?.silent || false, connection)
            }
        })

        // Handle action registration
        this.commandHandler.registerHandler('actions/register', async (data: any, connection: ClientConnection) => {
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
        })

        // Handle action unregistration
        this.commandHandler.registerHandler('actions/unregister', async (data: any, connection: ClientConnection) => {
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
        })

        // Handle action forcing (game is requesting Neuro to choose an action)
        this.commandHandler.registerHandler('actions/force', async (data: any, connection: ClientConnection) => {
            if (!connection.gameName) return

            const actionNames: string[] = data?.action_names || []
            const query: string = data?.query || ''
            const state: string | undefined = data?.state
            const ephemeralContext: boolean = data?.ephemeral_context || false

            console.log(`Action force from ${connection.gameName}: ${query} (actions: ${actionNames.join(', ')})`)

            // Call event handler if defined
            this.eventHandlers.onActionsForce?.(connection.gameName, query, actionNames, state, ephemeralContext)
        })

        // Handle action results (game reporting action execution result)
        this.commandHandler.registerHandler('action/result', async (data: any, connection: ClientConnection) => {
            const id: string = data?.id || ''
            const success: boolean = data?.success || false
            const message: string = data?.message || ''

            console.log(`Action result from ${connection.gameName}: ${id} - ${success ? 'SUCCESS' : 'FAILURE'}: ${message}`)

            // Call event handler if defined
            if (connection.gameName) {
                this.eventHandlers.onActionResult?.(connection.gameName, id, success, message)
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

        await this.commandHandler.handle(message.command, message.data, connection)
    }

    /** Start heartbeat to detect dead connections */
    private startHeartbeat(): void {
        setInterval(() => {
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
