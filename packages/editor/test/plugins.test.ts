import { afterEach, describe, expect, test } from 'vitest'
import type {
  EditorInjectedTextRowProvider,
  EditorPlugin,
  EditorPluginContext,
  EditorPluginHostEvents,
} from '../src/plugins'
import type { EditorDisposable } from '../src/editor/disposables'
import { EditorPluginHost } from '../src/plugins'

const hosts: EditorPluginHost[] = []

afterEach(() => {
  for (const host of hosts.splice(0)) captureCleanupErrors(() => host.dispose())
})

describe('editor plugin host teardown', () => {
  test.each(['activation', 'activation array', 'installation'] as const)(
    'finishes %s cleanup, its registrations and later plugins after returned cleanup fails',
    (phase) => {
      const host = ownedHost()
      const calls: string[] = []
      const failures: unknown[] = []
      const disposed: string[] = []
      let commandsChanged = 0
      const firstFailure = { phase }
      const cleanup = (context: EditorPluginContext) => {
        registerCleanup(context, 'phase older', calls)
        registerCleanup(context, 'phase throwing', calls, () => {
          throw new Error('registration')
        })
        registerCleanup(context, 'phase newer', calls)
        const result = [
          {
            dispose: () => {
              calls.push('returned older')
              throw new Error('later result')
            },
          },
          {
            dispose: () => {
              calls.push('returned throwing')
              throw firstFailure
            },
          },
          {
            dispose: () => {
              calls.push('returned newer')
            },
          },
        ]
        return phase === 'activation array' ? Object.freeze(result) : result[1]
      }
      host.setEvents({
        onPluginDeactivateFailed: (_name, error) => {
          failures.push(['deactivate', error])
        },
        onPluginDisposeFailed: (_name, error) => {
          failures.push(['dispose', error])
        },
        onPluginDisposed: (name) => {
          disposed.push(name)
        },
        onContributedCommandsChanged: () => {
          commandsChanged += 1
        },
      })
      const plugin: EditorPlugin = {
        name: 'failing-returned',
        commands: [{ id: 'test.cleanup', title: 'Cleanup', mutates: false }],
        install: phase === 'installation' ? cleanup : undefined,
        activate: phase === 'installation' ? () => undefined : cleanup,
      }
      host.setPlugins([
        plugin,
        {
          name: 'later-plugin',
          activate: (context) => {
            registerCleanup(context, 'later registration', calls)
          },
          dispose: () => {
            calls.push('later plugin')
          },
        },
      ])
      expect(host.getInjectedTextRowProviders()).toHaveLength(4)
      expect(host.getContributedCommands()).toHaveLength(1)
      commandsChanged = 0

      const errors = captureCleanupErrors(() => host.dispose())
      expect(calls).toEqual(
        (phase === 'activation array'
          ? ['returned newer', 'returned throwing', 'returned older']
          : ['returned throwing']
        ).concat([
          'phase newer',
          'phase throwing',
          'phase older',
          'later registration',
          'later plugin',
        ]),
      )
      expect(errors).toEqual([])
      expect(failures).toEqual([
        [phase === 'installation' ? 'dispose' : 'deactivate', firstFailure],
      ])
      expect(disposed).toEqual(['failing-returned', 'later-plugin'])
      expect(commandsChanged).toBe(1)
      expect(host.getInjectedTextRowProviders()).toEqual([])
      expect(host.getActivePluginNames()).toEqual([])
      expect(host.getContributedCommands()).toEqual([])
      const completed = calls.slice()
      host.dispose()
      expect(calls).toEqual(completed)
    },
  )

  test('keeps a falsy deactivation hook failure ahead of returned and active cleanup failures', () => {
    const host = ownedHost()
    const failures: unknown[] = []
    const calls: string[] = []
    let context: EditorPluginContext | undefined
    host.setEvents({
      onPluginDeactivateFailed: (_name, error) => {
        failures.push(error)
      },
    })
    const plugin: EditorPlugin = {
      activate: (value) => {
        context = value
        return {
          dispose: () => {
            calls.push('returned')
            throw new Error('returned')
          },
        }
      },
      deactivate: () => {
        calls.push('hook')
        throw undefined
      },
    }
    host.setPlugins([plugin])
    expect(context).toBeDefined()
    if (!context) throw new Error('missing plugin context')
    registerCleanup(context, 'active older', calls)
    registerCleanup(context, 'active throwing', calls, () => {
      throw new Error('active')
    })

    const errors = captureCleanupErrors(() => host.removePlugin(plugin))
    expect(calls).toEqual(['hook', 'returned', 'active throwing', 'active older'])
    expect(errors).toEqual([])
    expect(failures).toEqual([undefined])
    expect(host.getActivePluginNames()).toEqual([])
    expect(host.getInjectedTextRowProviders()).toEqual([])
  })

  test('keeps a falsy dispose hook failure ahead of installation and installed cleanup failures', () => {
    const host = ownedHost()
    const calls: string[] = []
    const failures: unknown[] = []
    host.setEvents({
      onPluginDisposeFailed: (_name, error) => {
        failures.push(error)
      },
    })
    host.setPlugins([
      {
        install: () => ({
          dispose: () => {
            calls.push('returned')
            throw new Error('returned')
          },
        }),
        activate: () => undefined,
        dispose: (context) => {
          registerCleanup(context, 'installed older', calls)
          registerCleanup(context, 'installed throwing', calls, () => {
            throw new Error('installed')
          })
          calls.push('hook')
          throw null
        },
      },
    ])

    const errors = captureCleanupErrors(() => host.setPlugins([]))
    expect(calls).toEqual(['hook', 'returned', 'installed throwing', 'installed older'])
    expect(errors).toEqual([])
    expect(failures).toEqual([null])
    expect(host.getInjectedTextRowProviders()).toEqual([])
  })

  test.each(['install', 'activate'] as const)(
    'preserves the original %s error after rollback unsubscribe throws',
    (phase) => {
      const host = ownedHost()
      const calls: string[] = []
      const failures: unknown[] = []
      const original = { phase }
      host.setEvents({
        onPluginInstallFailed: (_name, error) => {
          failures.push(['install', error])
        },
        onPluginActivationFailed: (_name, error) => {
          failures.push(['activate', error])
        },
      })
      const fail = (context: EditorPluginContext): never => {
        registerCleanup(context, 'older', calls)
        registerCleanup(context, 'throwing', calls, () => {
          throw new Error('rollback')
        })
        registerCleanup(context, 'newer', calls)
        throw original
      }
      const plugin: EditorPlugin = {
        install: phase === 'install' ? fail : undefined,
        activate: phase === 'activate' ? fail : () => undefined,
      }

      const errors = captureCleanupErrors(() => host.setPlugins([plugin]))
      expect(calls).toEqual(['newer', 'throwing', 'older'])
      expect(errors).toEqual([])
      expect(failures).toEqual([[phase, original]])
      expect(host.getInjectedTextRowProviders()).toEqual([])
      expect(host.getActivePluginNames()).toEqual([])
      host.dispose()
      expect(calls).toEqual(['newer', 'throwing', 'older'])
    },
  )

  test('contains a failing plugin dispose and finishes tearing the host down', () => {
    const disposeFailures: string[] = []
    const host = new EditorPluginHost()
    host.setEvents({
      onPluginDisposeFailed: (name, error) => {
        disposeFailures.push(`${name}: ${String(error)}`)
      },
    })
    let secondDisposed = false
    let installationUnwound = false

    host.setPlugins([
      {
        name: 'failing-dispose',
        install: () => ({
          dispose: () => {
            installationUnwound = true
          },
        }),
        activate: () => undefined,
        dispose: () => {
          throw new Error('dispose failed')
        },
      },
      {
        name: 'later-plugin',
        activate: () => undefined,
        dispose: () => {
          secondDisposed = true
        },
      },
    ])

    expect(() => host.dispose()).not.toThrow()

    expect(installationUnwound).toBe(true)
    expect(secondDisposed).toBe(true)
    expect(disposeFailures).toEqual(['failing-dispose: Error: dispose failed'])
  })

  test('keeps the surviving lease of a twice-registered injected text row provider live', () => {
    const host = new EditorPluginHost()
    let changes = 0
    const events: EditorPluginHostEvents = {
      onInjectedTextRowProvidersChanged: () => {
        changes += 1
      },
    }
    host.setEvents(events)
    const provider = createInjectedTextRowEmitter()
    const leases: EditorDisposable[] = []

    host.setPlugins([
      {
        name: 'double-registration',
        activate: (context) => {
          leases.push(context.registerInjectedTextRowProvider(provider))
          leases.push(context.registerInjectedTextRowProvider(provider))
        },
      },
    ])

    leases[0]?.dispose()

    expect(host.getInjectedTextRowProviders()).toHaveLength(1)

    changes = 0
    provider.fireChange()

    expect(changes).toBe(1)

    host.dispose()
  })
})

type InjectedTextRowEmitter = EditorInjectedTextRowProvider & {
  fireChange(): void
}

/** Models a real emitter: an unsubscribed listener stops hearing about changes. */
function createInjectedTextRowEmitter(): InjectedTextRowEmitter {
  const listeners = new Set<() => void>()

  return {
    getInjectedTextRows: () => [],
    onDidChangeInjectedTextRows: (listener) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fireChange: () => {
      for (const listener of listeners) listener()
    },
  }
}

function ownedHost(): EditorPluginHost {
  const host = new EditorPluginHost()
  hosts.push(host)
  return host
}

function registerCleanup(
  context: EditorPluginContext,
  name: string,
  calls: string[],
  fail?: () => void,
): void {
  context.registerInjectedTextRowProvider({
    getInjectedTextRows: () => [],
    onDidChangeInjectedTextRows: () => ({
      dispose: () => {
        calls.push(name)
        fail?.()
      },
    }),
  })
}

function captureCleanupErrors(cleanup: () => unknown): unknown[] {
  const errors: unknown[] = []
  try {
    cleanup()
  } catch (error) {
    errors.push(error)
  }
  return errors
}
