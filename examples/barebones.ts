import { NeuroServer } from '../src'

// Create and start the server
const server = new NeuroServer("127.0.0.1", 8000)

console.log('Barebones Neuro API server started!')
console.log('Connect your game client to ws://localhost:8000')

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down server...')
    await server.close()
    process.exit(0)
})

// Keep the process alive
process.stdin.resume()
