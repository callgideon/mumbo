// Build the `mumbo-box` E2B template from a shipped mumbo web image in ECR. dsh is not started here: the edge
// starts it per user with that user's box token (edge/edge.mjs startScript).
// Usage (needs the edge/node_modules e2b SDK and E2B_API_URL / E2B_SANDBOX_URL / E2B_API_KEY):
//   ECR_PASSWORD=$(aws ecr get-login-password --region us-east-1) node template.mjs (inside the edge image, or from deploy/boxes/edge) <ecr image uri>
import { Sandbox, Template } from 'e2b'
const image = process.argv[2] ?? (() => { throw new Error('pass the ECR image URI') })()
const tpl = Template().fromImage(image, { username: 'AWS', password: process.env.ECR_PASSWORD }).setUser('root')
const info = await Template.build(tpl, 'mumbo-box', { cpuCount: 2, memoryMB: 4096 })
console.log('built', info.templateId, info.buildId)
// Smoke: a box from the template has the app, no prior user data, and curl for backups.
const s = await Sandbox.create('mumbo-box', { timeoutMs: 120_000 })
const out = (await s.commands.run('test -f /src/apps/cli/src/bin.ts && echo app; test -e /root/.dsh && echo HAS-DSH-HOME || echo clean; command -v curl tar | wc -l')).stdout
await s.kill()
console.log(out.trim().replace(/\n/g, ' '))
if (!/app clean 2/.test(out.trim().replace(/\n/g, ' '))) process.exit(1)
