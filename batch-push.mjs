import { readdirSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { execSync, spawn } from 'child_process'
import { fileURLToPath } from 'url'

const BATCH_LIMIT = 50 * 1024 * 1024
const ROOT = resolve(fileURLToPath(import.meta.url), '..')
const SELF = relative(ROOT, fileURLToPath(import.meta.url))
const EXCLUDE = new Set(['.git', SELF])

function toHuman(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

function getAllFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (EXCLUDE.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...getAllFiles(full))
    else files.push(full)
  }
  return files
}

function exec(cmd) {
  return execSync(cmd, { encoding: 'utf-8', cwd: ROOT }).trim()
}

async function main() {
  const repoUrl = process.argv[2]
  if (!repoUrl) {
    console.log('Usage: node batch-push.mjs <github-repo-url>')
    process.exit(1)
  }

  console.log(':: Scanning files...')
  const allFiles = getAllFiles(ROOT)
  const fileSizes = allFiles.map(f => ({ path: f, size: statSync(f).size }))
  const totalBytes = fileSizes.reduce((a, b) => a + b.size, 0)
  console.log(`  Files: ${fileSizes.length}  Total: ${toHuman(totalBytes)}\n`)

  console.log(`:: Batching (max ${toHuman(BATCH_LIMIT)} per push)...`)
  const sorted = [...fileSizes].sort((a, b) => b.size - a.size)
  const batches = []
  let accum = []
  let accumSize = 0

  for (const f of sorted) {
    if (accumSize + f.size <= BATCH_LIMIT) {
      accum.push(f)
      accumSize += f.size
    } else {
      if (accum.length) batches.push(accum)
      accum = [f]
      accumSize = f.size
    }
  }
  if (accum.length) batches.push(accum)

  console.log(`  Created ${batches.length} batch(es)\n`)

  const remoteName = repoUrl.replace(/^https?:\/\//, '')
  console.log(':: Setting remote origin...')
  try { exec('git remote remove origin') } catch {}
  exec(`git remote add origin "${repoUrl}"`)

  console.log(':: Initializing LFS...')
  exec('git lfs install')

  let pushedBytes = 0

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    const batchSize = batch.reduce((a, f) => a + f.size, 0)
    const pct = Math.round((b / batches.length) * 100)
    const remaining = totalBytes - pushedBytes - batchSize

    console.log('='.repeat(48))
    console.log(`  Batch ${b + 1} of ${batches.length}  |  ${pct}% done`)
    console.log(`  Size:     ${toHuman(batchSize)}`)
    console.log(`  Files:    ${batch.length}`)
    console.log(`  Pushed:   ${toHuman(pushedBytes)} / ${toHuman(totalBytes)}`)
    console.log(`  Left:     ${toHuman(remaining)}`)
    console.log('='.repeat(48))

    const paths = batch.map(f => f.path)
    exec(`git add ${paths.map(p => `"${p}"`).join(' ')}`)

    const msg = `Add batch ${b + 1} of ${batches.length} - ${batch.length} files, ${toHuman(batchSize)}`
    exec(`git commit -m "${msg}"`)

    process.stdout.write('  Pushing...')
    const start = Date.now()

    const push = spawn('git', ['push', 'origin', 'main', '--progress'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    })

    push.stderr.on('data', d => {
      const s = d.toString().replace(/\n/g, ' ')
      const m = s.match(/(\d+)\/(\d+)/)
      if (m) process.stdout.write(`\r  ${m[1]} / ${m[2]} objects`)
    })

    await new Promise((res, rej) => {
      push.on('close', c => c === 0 ? res() : rej(new Error(`git push exited with code ${c}`)))
      push.on('error', rej)
    })

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const speed = batchSize / parseFloat(elapsed)
    process.stdout.write(`\r  \u2713 Pushed in ${elapsed}s (${toHuman(speed)}/s)\n\n`)

    pushedBytes += batchSize
  }

  console.log('='.repeat(48))
  console.log(`  All done!  ${toHuman(pushedBytes)} across ${batches.length} batch(es)`)
  console.log('='.repeat(48))
}

main().catch(err => {
  console.error(`\n  \u2717 ${err.message}`)
  process.exit(1)
})
