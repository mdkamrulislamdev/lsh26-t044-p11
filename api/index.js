// Vercel entry point. The same Express app the Docker image runs — one
// codebase, two hosts. Migrations run via `npm run migrate`, not per request.
import { createApp } from '../server/src/app.js'

export default createApp()
