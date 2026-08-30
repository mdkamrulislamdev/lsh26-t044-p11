import 'dotenv/config'
import { createApp } from './app.js'
import { migrate } from './migrate.js'

const port = Number(process.env.PORT) || 8080

const boot = async () => {
  try {
    await migrate()
  } catch (e) {
    // A dead database must not stop the planner from answering read-only calls.
    console.error(JSON.stringify({ level: 'error', msg: 'migrate failed', err: e.message }))
  }
  const server = createApp().listen(port, () =>
    console.log(JSON.stringify({ level: 'info', msg: 'listening', port })),
  )
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

boot()
