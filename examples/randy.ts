import express from "express"
import pkg from "body-parser"
import { NeuroServer, type OutgoingMessage } from "../src"
import { JSONSchemaFaker } from "json-schema-faker"
import util from "util"

const { json } = pkg

const app = express()
app.use(json())
app.listen(1337)

app.post("/", (req, res) => {
    send(req.body)
    res.sendStatus(200)
})

const server = new NeuroServer("127.0.0.1", 8000)

let actions: Action[] = []
let pendingResult: { id: string; actionName: string } | null = null
let actionForceQueue: string[] = []

async function onMessageReceived(message: Message) {
    console.log("<---", util.inspect(message, false, null, true))

    if (!message.data) return

    switch (message.command) {
        case "actions/register": {
            actions.push(...(message.data.actions as Action[]))
            break
        }

        case "actions/unregister": {
            actions = actions.filter(a => !message.data!.action_names.includes(a.name))
            break
        }

        case "actions/force": {
            const actionName: string = message.data.action_names[Math.floor(Math.random() * message.data.action_names.length)]
            if (pendingResult === null) {
                setTimeout(() => sendAction(actionName), 500)
            } else {
                console.warn("! Received new actions/force while waiting for result; sent to queue")
                actionForceQueue.push(actionName)
            }
            break
        }

        case "action/result": {
            if (pendingResult === null) {
                console.warn(`! Received unexpected action/result: '${message.data.id}'`)
                break
            }

            if (message.data.id === pendingResult.id) {
                const actionName = pendingResult.actionName
                pendingResult = null

                if (!message.data.success) {
                    setTimeout(() => sendAction(actionName), 500)
                } else if (actionForceQueue.length > 0) {
                    setTimeout(() => sendAction(actionForceQueue.shift()!), 500)
                }
            } else {
                console.warn(`! Received unknown action/result '${message.data.id}' while waiting for '${pendingResult.id}'`)
            }
            break
        }
    }
}

// Register handlers with the NeuroServer
server['commandHandler'].registerHandler('actions/register', async (data: any) => {
    await onMessageReceived({ command: 'actions/register', data })
})

server['commandHandler'].registerHandler('actions/unregister', async (data: any) => {
    await onMessageReceived({ command: 'actions/unregister', data })
})

server['commandHandler'].registerHandler('actions/force', async (data: any) => {
    await onMessageReceived({ command: 'actions/force', data })
})

server['commandHandler'].registerHandler('action/result', async (data: any) => {
    await onMessageReceived({ command: 'action/result', data })
})

function sendAction(actionName: string) {
    const id = Math.random().toString()

    if (actionName == "choose_name") {
        send({ command: "action", data: { id, name: "choose_name", data: JSON.stringify({ name: "RANDY" }) } })
        return
    }

    const action = actions.find(a => a.name === actionName)
    if (!action) return

    const responseObj = !action?.schema ? undefined : JSON.stringify(JSONSchemaFaker.generate(action.schema))

    send({ command: "action", data: { id, name: action.name, data: responseObj } })
}

export function send(msg: Message) {
    if (msg.command === "action" && msg.data) {
        pendingResult = { id: msg.data.id, actionName: msg.data.name }
    }

    console.log("--->", util.inspect(msg, false, null, true))

    // Broadcast to all connected clients
    server.broadcast(msg as OutgoingMessage)
}

type Message = {
    command: string,
    data?: { [key: string]: any }
}

type Action = {
    name: string,
    schema: any
}
