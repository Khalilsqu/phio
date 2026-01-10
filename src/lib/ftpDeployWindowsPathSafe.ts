import * as ftp from 'basic-ftp'
import fs from 'fs'
import { globSync } from 'glob'
import prettyBytes from 'pretty-bytes'

import { fileHash, HashDiff } from '@samkirkland/ftp-deploy/src/HashDiff'
import { prettyError } from '@samkirkland/ftp-deploy/src/errorHandling'
import {
  ensureDir,
  FTPSyncProvider,
} from '@samkirkland/ftp-deploy/src/syncProvider'
import {
  currentSyncFileVersion,
  syncFileDescription,
  type IDiff,
  type IFileList,
  type IFtpDeployArguments,
  type IFtpDeployArgumentsWithDefaults,
  type Record,
} from '@samkirkland/ftp-deploy/src/types'
import {
  applyExcludeFilter,
  formatNumber,
  getDefaultSettings,
  Logger,
  retryRequest,
  Timings,
  type ILogger,
  type ITimings,
} from '@samkirkland/ftp-deploy/src/utilities'

function normalizeToPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

let didWarnOnWindowsSeparators = false

function assertPosixPath(p: string) {
  if (p.includes('\\')) {
    throw new Error(
      `Internal error: expected POSIX '/' path separators but got a Windows path: ${p}`
    )
  }
}

async function getLocalFilesNormalized(
  args: IFtpDeployArgumentsWithDefaults,
  logger: ILogger
): Promise<IFileList> {
  const rawFiles = globSync(args.include, {
    ignore: args.exclude,
    cwd: args['local-dir'],
  })

  const shouldNormalize = rawFiles.some((p) => p.includes('\\'))

  if (didWarnOnWindowsSeparators === false && shouldNormalize) {
    didWarnOnWindowsSeparators = true
    logger.standard(
      `⚠️  Detected Windows-style path separators (\\) from glob; normalizing to POSIX '/' for FTP.`
    )
  }

  const files = shouldNormalize ? rawFiles.map(normalizeToPosixPath) : rawFiles
  if (shouldNormalize) {
    files.forEach(assertPosixPath)
  }
  logger.verbose(`Local files:`, JSON.stringify({ files }, null, 2))

  const records: Record[] = []

  for (const filePath of files) {
    if (shouldNormalize) {
      assertPosixPath(filePath)
    }
    const stat = fs.lstatSync(`${args['local-dir']}${filePath}`)

    if (stat.isDirectory()) {
      records.push({
        type: 'folder',
        name: filePath,
        size: undefined,
      })
      continue
    }

    if (stat.isFile()) {
      records.push({
        type: 'file',
        name: filePath,
        size: stat.size,
        hash: await fileHash(`${args['local-dir']}${filePath}`, 'sha256'),
      })
      continue
    }

    if (stat.isSymbolicLink()) {
      console.warn(
        'This script is currently unable to handle symbolic links - please add a feature request if you need this'
      )
    }
  }

  return {
    description: syncFileDescription,
    version: currentSyncFileVersion,
    generatedTime: new Date().getTime(),
    data: records,
  }
}

async function downloadFileList(
  client: ftp.Client,
  logger: ILogger,
  path: string
): Promise<IFileList> {
  const maxAttempts = 3

  const remoteSize: number | null = await (async () => {
    try {
      return await retryRequest(logger, async () => await client.size(path))
    } catch {
      return null
    }
  })()

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tempFileName = `.ftp-deploy-sync-server-state-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.json`

    try {
      await retryRequest(
        logger,
        async () => await client.downloadTo(tempFileName, path)
      )

      const localSize = fs.statSync(tempFileName).size
      if (remoteSize !== null && localSize !== remoteSize) {
        logger.standard(
          `Downloaded state file size mismatch (remote ${remoteSize} bytes, local ${localSize} bytes). Retrying (${attempt}/${maxAttempts})...`
        )
        continue
      }

      const fileAsString = fs.readFileSync(tempFileName, { encoding: 'utf-8' })
      try {
        const fileAsObject = JSON.parse(fileAsString) as IFileList
        return fileAsObject
      } catch (parseError) {
        const previewStart = fileAsString.slice(0, 200).replace(/\r?\n/g, '\\n')
        const previewEnd = fileAsString
          .slice(Math.max(0, fileAsString.length - 200))
          .replace(/\r?\n/g, '\\n')
        logger.standard(
          `Downloaded state file is not valid JSON. Retrying (${attempt}/${maxAttempts})...`
        )
        logger.verbose(`State file preview (start): ${previewStart}`)
        logger.verbose(`State file preview (end): ${previewEnd}`)

        if (attempt === maxAttempts) {
          throw parseError
        }
      }
    } finally {
      try {
        if (fs.existsSync(tempFileName)) {
          fs.unlinkSync(tempFileName)
        }
      } catch {
        // best-effort cleanup
      }
    }
  }

  throw new Error(
    'Failed to download and parse server state file after retries'
  )
}

function createLocalState(
  localFiles: IFileList,
  logger: ILogger,
  args: IFtpDeployArgumentsWithDefaults
): void {
  logger.verbose(
    `Creating local state at ${args['local-dir']}${args['state-name']}`
  )
  fs.writeFileSync(
    `${args['local-dir']}${args['state-name']}`,
    JSON.stringify(localFiles, undefined, 4),
    { encoding: 'utf8' }
  )
  logger.verbose('Local state created')
}

function readLocalStateFileIfPresent(
  logger: ILogger,
  localStatePath: string
): IFileList | null {
  try {
    if (!fs.existsSync(localStatePath)) return null
    const raw = fs.readFileSync(localStatePath, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw) as IFileList
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.description === syncFileDescription &&
      parsed.version === currentSyncFileVersion &&
      Array.isArray(parsed.data)
    ) {
      return parsed
    }
    return null
  } catch (e) {
    logger.verbose(`Failed to read local sync state cache: ${e}`)
    return null
  }
}

async function connect(
  client: ftp.Client,
  args: IFtpDeployArgumentsWithDefaults,
  logger: ILogger
) {
  let secure: boolean | 'implicit' = false
  if (args.protocol === 'ftps') {
    secure = true
  } else if (args.protocol === 'ftps-legacy') {
    secure = 'implicit'
  }

  client.ftp.verbose = args['log-level'] === 'verbose'

  const rejectUnauthorized = args.security === 'strict'

  try {
    await client.access({
      host: args.server,
      user: args.username,
      password: args.password,
      port: args.port,
      secure,
      secureOptions: {
        rejectUnauthorized,
      },
    })
  } catch (error) {
    logger.all(
      `Failed to connect, are you sure your server works via FTP or FTPS? Users sometimes get this error when the server only supports SFTP.`
    )
    throw error
  }

  if (args['log-level'] === 'verbose') {
    client.trackProgress((info) => {
      logger.verbose(
        `${info.type} progress for "${info.name}". Progress: ${info.bytes} bytes of ${info.bytesOverall} bytes`
      )
    })
  }
}

async function getServerFiles(
  client: ftp.Client,
  logger: ILogger,
  timings: ITimings,
  args: IFtpDeployArgumentsWithDefaults
): Promise<IFileList> {
  try {
    await ensureDir(client, logger, timings, args['server-dir'])

    if (args['dangerous-clean-slate']) {
      logger.all(
        `----------------------------------------------------------------`
      )
      logger.all(
        `🗑️ Removing all files on the server because 'dangerous-clean-slate' was set, this will make the deployment very slow...`
      )
      if (args['dry-run'] === false) {
        await client.clearWorkingDir()
      }
      logger.all('Clear complete')

      throw new Error('dangerous-clean-slate was run')
    }

    const serverFiles = await downloadFileList(
      client,
      logger,
      args['state-name']
    )
    logger.all(
      `----------------------------------------------------------------`
    )
    logger.all(
      `Last published on 📅 ${new Date(
        serverFiles.generatedTime
      ).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      })}`
    )

    if (args.exclude.length > 0) {
      const filteredData = serverFiles.data.filter((item) =>
        applyExcludeFilter(
          { path: item.name, isDirectory: () => item.type === 'folder' },
          args.exclude
        )
      )
      serverFiles.data = filteredData
    }

    return serverFiles
  } catch (error) {
    const maybeCode = (error as any)?.code
    const message = String((error as any)?.message ?? '')

    const isMissingStateFile =
      maybeCode === 550 ||
      /no such file or directory/i.test(message) ||
      /not found/i.test(message)

    if (isMissingStateFile) {
      logger.all(
        `----------------------------------------------------------------`
      )
      logger.all(
        `No file exists on the server "${
          args['server-dir'] + args['state-name']
        }" - this must be your first publish! 🎉`
      )
      logger.all(
        `The first publish will take a while... but once the initial sync is done only differences are published!`
      )
      logger.all(
        `If you get this message and its NOT your first publish, something is wrong.`
      )

      return {
        description: syncFileDescription,
        version: currentSyncFileVersion,
        generatedTime: new Date().getTime(),
        data: [],
      }
    }

    logger.all(
      `----------------------------------------------------------------`
    )
    logger.all(
      `Failed to read existing server state file "${
        args['server-dir'] + args['state-name']
      }"; refusing to do a full re-sync.`
    )
    logger.all(error)
    throw error
  }
}

async function deployWithDefaults(
  args: IFtpDeployArgumentsWithDefaults,
  logger: ILogger,
  timings: ITimings
): Promise<void> {
  timings.start('total')

  logger.all(`----------------------------------------------------------------`)
  logger.all(`🚀 Thanks for using ftp-deploy. Let's deploy some stuff!   `)
  logger.all(`----------------------------------------------------------------`)
  logger.all(`If you found this project helpful, please support it`)
  logger.all(
    `by giving it a ⭐ on Github --> https://github.com/SamKirkland/FTP-Deploy-Action`
  )
  logger.all(
    `or add a badge 🏷️ to your projects readme --> https://github.com/SamKirkland/FTP-Deploy-Action#badge`
  )
  logger.verbose(
    `Using the following include filters: ${JSON.stringify(args.include)}`
  )
  logger.verbose(
    `Using the following excludes filters: ${JSON.stringify(args.exclude)}`
  )

  timings.start('hash')
  const localFiles = await getLocalFilesNormalized(args, logger)
  timings.stop('hash')

  // Cache the previous run's local sync state before we overwrite it.
  // This is useful as a fallback when the remote state file can't be downloaded
  // reliably (seen under Bun/basic-ftp on Windows).
  const localStatePath = `${args['local-dir']}${args['state-name']}`
  const cachedServerFiles = readLocalStateFileIfPresent(logger, localStatePath)

  createLocalState(localFiles, logger, args)

  const client = new ftp.Client(args.timeout)

  // Preserve the upstream global-based reconnect hook.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).reconnect = async function () {
    timings.start('connecting')
    await connect(client, args, logger)
    timings.stop('connecting')
  }

  let totalBytesUploaded = 0
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (globalThis as any).reconnect()

    const serverFiles = await (async () => {
      try {
        return await getServerFiles(client, logger, timings, args)
      } catch (e) {
        if (cachedServerFiles) {
          logger.standard(
            `⚠️  Falling back to local sync-state cache because remote state could not be read. This may miss out-of-band server changes.`
          )
          return cachedServerFiles
        }
        throw e
      }
    })()

    timings.start('logging')
    const diffTool: IDiff = new HashDiff()

    logger.standard(
      `----------------------------------------------------------------`
    )
    logger.standard(`Local Files:\t${formatNumber(localFiles.data.length)}`)
    logger.standard(`Server Files:\t${formatNumber(serverFiles.data.length)}`)
    logger.standard(
      `----------------------------------------------------------------`
    )
    logger.standard(`Calculating differences between client & server`)
    logger.standard(
      `----------------------------------------------------------------`
    )
    logger.verbose(`Local files:`, JSON.stringify(localFiles, null, 2))
    logger.verbose(`Server files:`, JSON.stringify(serverFiles, null, 2))

    const diffs = diffTool.getDiffs(localFiles, serverFiles)

    diffs.upload
      .filter((itemUpload) => itemUpload.type === 'folder')
      .map((itemUpload) => {
        logger.standard(`📁 Create: ${itemUpload.name}`)
      })

    diffs.upload
      .filter((itemUpload) => itemUpload.type === 'file')
      .map((itemUpload) => {
        logger.standard(`📄 Upload: ${itemUpload.name}`)
      })

    diffs.replace.map((itemReplace) => {
      logger.standard(`🔁 File replace: ${itemReplace.name}`)
    })

    diffs.delete
      .filter((itemUpload) => itemUpload.type === 'file')
      .map((itemDelete) => {
        logger.standard(`📄 Delete: ${itemDelete.name}    `)
      })

    diffs.delete
      .filter((itemUpload) => itemUpload.type === 'folder')
      .map((itemDelete) => {
        logger.standard(`📁 Delete: ${itemDelete.name}    `)
      })

    diffs.same.map((itemSame) => {
      if (itemSame.type === 'file') {
        logger.standard(
          `⚖️  File content is the same, doing nothing: ${itemSame.name}`
        )
      }
    })
    timings.stop('logging')

    totalBytesUploaded = diffs.sizeUpload + diffs.sizeReplace

    timings.start('upload')
    try {
      const syncProvider = new FTPSyncProvider(
        client,
        logger,
        timings,
        args['local-dir'],
        args['server-dir'],
        args['state-name'],
        args['dry-run']
      )
      await syncProvider.syncLocalToServer(diffs)
    } finally {
      timings.stop('upload')
    }
  } catch (error) {
    prettyError(logger, args, error)
    throw error
  } finally {
    client.close()
    timings.stop('total')
  }

  const uploadSpeed = prettyBytes(
    totalBytesUploaded / (timings.getTime('upload') / 1000)
  )

  logger.all(`----------------------------------------------------------------`)
  logger.all(`Time spent hashing: ${timings.getTimeFormatted('hash')}`)
  logger.all(
    `Time spent connecting to server: ${timings.getTimeFormatted('connecting')}`
  )
  logger.all(
    `Time spent deploying: ${timings.getTimeFormatted(
      'upload'
    )} (${uploadSpeed}/second)`
  )
  logger.all(`  - changing dirs: ${timings.getTimeFormatted('changingDir')}`)
  logger.all(`  - logging: ${timings.getTimeFormatted('logging')}`)
  logger.all(`----------------------------------------------------------------`)
  logger.all(`Total time: ${timings.getTimeFormatted('total')}`)
  logger.all(`----------------------------------------------------------------`)
}

/**
 * Drop-in replacement for `@samkirkland/ftp-deploy` that normalizes Windows `\\`
 * paths to POSIX `/` before computing diffs and issuing FTP commands.
 */
export async function deployFixed(args: IFtpDeployArguments): Promise<void> {
  const argsWithDefaults = getDefaultSettings(args)
  const logger = new Logger(argsWithDefaults['log-level'])
  const timings = new Timings()
  await deployWithDefaults(argsWithDefaults, logger, timings)
}
