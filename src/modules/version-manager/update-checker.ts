/**
 * UpdateChecker — queries the npm registry for the latest package version.
 *
 * Uses Node.js built-in `https` module (no extra HTTP dependency).
 * Uses `semver` for major-version comparison (AC7, AC8).
 */

import https from 'https'
import * as semver from 'semver'

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when an update check fails due to network error, timeout, or bad response.
 */
export class UpdateCheckError extends Error {
  readonly name = 'UpdateCheckError'

  constructor(message: string) {
    super(message)
    // Restore prototype chain
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// UpdateChecker class
// ---------------------------------------------------------------------------

/**
 * Queries the npm registry to determine the latest published version of a package.
 */
export class UpdateChecker {
  private readonly timeoutMs: number

  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs
  }

  /**
   * Fetch the latest published version of a package from the npm registry.
   *
   * @param packageName - npm package name (e.g. 'substrate')
   * @returns The latest version string (semver)
   * @throws {UpdateCheckError} on timeout, network error, non-200 HTTP status, or parse failure
   */
  fetchLatestVersion(packageName: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const url = `https://registry.npmjs.org/${packageName}/latest`
      let settled = false

      const safeReject = (err: UpdateCheckError): void => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      }

      const safeResolve = (value: string): void => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
      }

      // Use setTimeout + req.destroy() to implement the timeout, since the
      // https.get legacy callback API does not accept an AbortSignal directly.
      // eslint-disable-next-line prefer-const
      let req: ReturnType<typeof https.get>
      const timer = setTimeout(() => {
        req.destroy()
        safeReject(new UpdateCheckError(`Update check timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      const followRedirect = (location: string, hopsLeft: number): void => {
        const redirectReq = https.get(location, (redirectRes) => {
          // Handle up to 2 redirect hops
          if (
            redirectRes.statusCode !== undefined &&
            redirectRes.statusCode >= 300 &&
            redirectRes.statusCode < 400 &&
            redirectRes.headers.location &&
            hopsLeft > 0
          ) {
            redirectRes.resume()
            followRedirect(redirectRes.headers.location, hopsLeft - 1)
            return
          }

          if (redirectRes.statusCode !== 200) {
            redirectRes.resume()
            safeReject(
              new UpdateCheckError(
                `npm registry returned HTTP ${String(redirectRes.statusCode)} for ${packageName}`
              )
            )
            return
          }
          collectBody(redirectRes, safeResolve, safeReject)
        })
        redirectReq.on('error', (err) => {
          safeReject(new UpdateCheckError(`Update check network error: ${err.message}`))
        })
        // Apply the same timeout to redirect requests
        redirectReq.setTimeout(this.timeoutMs, () => {
          redirectReq.destroy()
          safeReject(new UpdateCheckError(`Update check timed out after ${this.timeoutMs}ms`))
        })
      }

      req = https.get(url, (res) => {
        // Handle redirects
        if (
          res.statusCode !== undefined &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume()
          // Follow up to 2 redirect hops
          followRedirect(res.headers.location, 1)
          return
        }

        if (res.statusCode !== 200) {
          res.resume()
          safeReject(
            new UpdateCheckError(
              `npm registry returned HTTP ${String(res.statusCode)} for ${packageName}`
            )
          )
          return
        }

        collectBody(res, safeResolve, safeReject)
      })

      req.on('error', (err) => {
        // When req.destroy() is called on timeout, this fires with the destroy error.
        // safeReject handles the settled check to avoid double-rejection.
        safeReject(new UpdateCheckError(`Update check network error: ${err.message}`))
      })
    })
  }

  /**
   * Determine whether upgrading from currentVersion to latestVersion is a breaking (major) change.
   *
   * @param currentVersion - The currently installed version (semver string)
   * @param latestVersion - The available latest version (semver string)
   * @returns true if the major version increases; false if either version is invalid
   */
  isBreaking(currentVersion: string, latestVersion: string): boolean {
    if (!semver.valid(currentVersion) || !semver.valid(latestVersion)) {
      return false
    }

    const currentMajor = semver.major(currentVersion)
    const latestMajor = semver.major(latestVersion)

    return latestMajor > currentMajor
  }

  /**
   * Return a changelog URL for the given version.
   *
   * @param latestVersion - The version to link to
   * @returns A URL string pointing to the GitHub release page
   */
  getChangelog(latestVersion: string): string {
    return `See https://github.com/jplanow/ai-dev-toolkit-new/releases/tag/v${latestVersion}`
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type IncomingMessage = Parameters<Parameters<typeof https.get>[1]>[0]

function collectBody(
  res: IncomingMessage,
  resolve: (value: string) => void,
  reject: (reason: UpdateCheckError) => void
): void {
  const chunks: Buffer[] = []

  res.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })

  res.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf-8')
      const data = JSON.parse(body) as { version?: string }
      if (typeof data.version !== 'string' || data.version.length === 0) {
        reject(new UpdateCheckError('npm registry response missing version field'))
        return
      }
      resolve(data.version)
    } catch {
      reject(new UpdateCheckError('Failed to parse npm registry response'))
    }
  })

  res.on('error', (err: Error) => {
    reject(new UpdateCheckError(`Response stream error: ${err.message}`))
  })
}
