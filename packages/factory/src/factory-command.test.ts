/**
 * Unit tests for `registerFactoryCommand`.
 *
 * Tests AC5 and AC6 from story 44-8.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Command } from 'commander'
import { registerFactoryCommand } from './factory-command.js'

// Mock the scenarios CLI command to avoid side effects in these tests
vi.mock('./scenarios/cli-command.js', () => ({
  registerScenariosCommand: vi.fn(),
}))

describe('registerFactoryCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('AC6: registers a command named "factory" on the program without throwing', () => {
    const program = new Command()
    program.exitOverride()

    expect(() => registerFactoryCommand(program)).not.toThrow()

    const names = program.commands.map((c) => c.name())
    expect(names).toContain('factory')
  })

  it('AC6: the factory command has a description', () => {
    const program = new Command()
    program.exitOverride()
    registerFactoryCommand(program)

    const factoryCmd = program.commands.find((c) => c.name() === 'factory')
    expect(factoryCmd).toBeDefined()
    expect(factoryCmd!.description()).toBeTruthy()
  })

  it('AC6: calls registerScenariosCommand to attach scenarios subcommands', async () => {
    const { registerScenariosCommand } = await import('./scenarios/cli-command.js')
    const program = new Command()
    program.exitOverride()

    registerFactoryCommand(program)

    expect(vi.mocked(registerScenariosCommand)).toHaveBeenCalledTimes(1)
  })
})
