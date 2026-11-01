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
  test.each(['remove', 'install', 'activate'] as const)(
    'releases a throwing provider subscription after %s and supports reinstall',
    verifyProviderReinstall,
  )

  test.each(['activation', 'activation array', 'installation'] as const)(
    'finishes %s cleanup, its registrations and later plugins after returned cleanup fails',
    (phase) => {
      const host = ownedHost()
      const calls: string[] = []
      const failures: [string, unknown][] = []
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
      expect(failures[0]?.[1]).toBe(firstFailure)
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
      const failures: [string, unknown][] = []
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
      expect(failures[0]?.[1]).toBe(original)
      expect(host.getInjectedTextRowProviders()).toEqual([])
      expect(host.getActivePluginNames()).toEqual([])
      host.dispose()
      expect(calls).toEqual(['newer', 'throwing', 'older'])
    },
  )

  test('does not repeat plugin cleanup when a returned disposer reenters host teardown', () => {
    const host = ownedHost()
    const calls: string[] = []
    const plugin: EditorPlugin = {
      install: () => ({
        dispose: () => {
          calls.push('installation')
        },
      }),
      activate: () => ({
        dispose: () => {
          calls.push('activation')
          host.dispose()
        },
      }),
      dispose: () => {
        calls.push('dispose hook')
      },
    }
    host.setPlugins([plugin])

    expect(() => host.removePlugin(plugin)).not.toThrow()
    expect(calls.filter((call) => call === 'installation')).toHaveLength(1)
    expect(calls.filter((call) => call === 'activation')).toHaveLength(1)
    expect(calls.filter((call) => call === 'dispose hook')).toHaveLength(1)
    expect(host.getActivePluginNames()).toEqual([])
  })

  test('drains registrations made during deactivation before disposing the installation', () => {
    const host = ownedHost()
    const calls: string[] = []
    const failures: unknown[] = []
    host.setEvents({
      onPluginDeactivateFailed: (_name, error) => {
        failures.push(error)
      },
    })
    host.setPlugins([
      {
        activate: (context) => {
          registerCleanup(context, 'phase', calls)
          return {
            dispose: () => {
              calls.push('returned')
              registerCleanup(context, 'late active', calls)
              throw false
            },
          }
        },
        deactivate: (context) => {
          registerCleanup(context, 'hook active', calls)
        },
        dispose: () => {
          calls.push('installation')
        },
      },
    ])

    expect(() => host.setPlugins([])).not.toThrow()
    expect(calls).toEqual(['returned', 'phase', 'late active', 'hook active', 'installation'])
    expect(failures).toEqual([false])
    expect(host.getInjectedTextRowProviders()).toEqual([])
  })

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

type ProviderFailurePhase = 'remove' | 'install' | 'activate'

function verifyProviderReinstall(phase: ProviderFailurePhase): void {
  const host = ownedHost()
  const unsubscribeFailure = new Error('unsubscribe')
  const phaseFailure = new Error(phase)
  const provider = createThrowingInjectedTextRowEmitter(unsubscribeFailure)
  const failures: unknown[] = []
  let changes = 0
  const recordFailure = (_name: string, error: unknown) => failures.push(error)
  host.setEvents({
    onInjectedTextRowProvidersChanged: () => {
      changes += 1
    },
    onPluginInstallFailed: recordFailure,
    onPluginActivationFailed: recordFailure,
    onPluginDeactivateFailed: recordFailure,
  })
  const plugin = providerFailurePlugin(provider, phase, phaseFailure)

  host.setPlugins([plugin])
  if (phase === 'remove') host.removePlugin(plugin)

  expect(host.getInjectedTextRowProviders()).toEqual([])
  expect(provider.listenerCount()).toBe(0)
  expect.soft(changes).toBe(2)
  expect(failures).toHaveLength(1)
  expect(failures[0]).toBe(phase === 'remove' ? unsubscribeFailure : phaseFailure)

  host.setPlugins([
    {
      activate: (context) => {
        context.registerInjectedTextRowProvider(provider)
      },
    },
  ])
  expect(host.getInjectedTextRowProviders()).toEqual([provider])
  expect(provider.listenerCount()).toBe(1)
  const beforeChange = changes
  provider.fireChange()
  expect(changes).toBe(beforeChange + 1)
  host.setPlugins([])
  expect(provider.listenerCount()).toBe(0)
  expect(host.getInjectedTextRowProviders()).toEqual([])
  expect(failures).toHaveLength(1)
}

function providerFailurePlugin(
  provider: EditorInjectedTextRowProvider,
  phase: ProviderFailurePhase,
  failure: Error,
): EditorPlugin {
  const register = (context: EditorPluginContext) => {
    context.registerInjectedTextRowProvider(provider)
    if (phase !== 'remove') throw failure
  }
  return {
    install: phase === 'install' ? register : undefined,
    activate: phase === 'install' ? () => undefined : register,
  }
}

function createThrowingInjectedTextRowEmitter(failure: Error) {
  const listeners = new Set<() => void>()
  let shouldThrow = true
  const unsubscribe = (listener: () => void) => {
    listeners.delete(listener)
    if (!shouldThrow) return
    shouldThrow = false
    throw failure
  }
  return {
    getInjectedTextRows: () => [],
    onDidChangeInjectedTextRows: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => unsubscribe(listener) }
    },
    listenerCount: () => listeners.size,
    fireChange: () => {
      for (const listener of listeners) listener()
    },
  }
}
