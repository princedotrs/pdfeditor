import { describe, it, expect } from 'vitest'
import { distribute } from './distribute'

const join = (r: string[]) => r.join('')

describe('distribute', () => {
  it('reports no change when the text is identical', () => {
    const d = distribute(['Hello ', 'World'], 'Hello World')
    expect(d.changed).toBe(false)
    expect(d.texts).toEqual(['Hello ', 'World'])
  })

  it('keeps untouched runs intact when editing inside one run', () => {
    const d = distribute(['Hello ', 'World'], 'Hello Earth')
    expect(join(d.texts)).toBe('Hello Earth')
    expect(d.texts[0]).toBe('Hello ')
    expect(d.texts[1]).toBe('Earth')
  })

  it('attributes an insertion to the run being extended', () => {
    const d = distribute(['Bold', 'plain'], 'Bolder plain')
    expect(join(d.texts)).toBe('Bolder plain')
    expect(d.texts[0]).toBe('Bolder ')
    expect(d.texts[1]).toBe('plain')
    expect(d.insertedInto).toBe(0)
  })

  it('handles a deletion spanning several runs', () => {
    const d = distribute(['abc', 'def', 'ghi'], 'ahi')
    expect(join(d.texts)).toBe('ahi')
    expect(d.texts[0]).toBe('a')
    expect(d.texts[1]).toBe('')
    expect(d.texts[2]).toBe('hi')
  })

  it('handles clearing the line entirely', () => {
    const d = distribute(['abc', 'def'], '')
    expect(d.texts).toEqual(['', ''])
    expect(d.changed).toBe(true)
  })

  it('handles typing into an empty line', () => {
    const d = distribute([''], 'new')
    expect(d.texts).toEqual(['new'])
  })

  it('puts a leading insertion in the first run', () => {
    const d = distribute(['World'], 'Hello World')
    expect(d.texts).toEqual(['Hello World'])
  })

  it('preserves a trailing run when prepending', () => {
    const d = distribute(['one', 'two'], 'Xonetwo')
    expect(join(d.texts)).toBe('Xonetwo')
    expect(d.texts[0]).toBe('Xone')
    expect(d.texts[1]).toBe('two')
  })

  it('always reassembles to exactly the requested text', () => {
    const cases: Array<[string[], string]> = [
      [['The ', 'quick ', 'brown'], 'The slow brown'],
      [['2024'], '2025'],
      [['a'], 'abcdefg'],
      [['abcdefg'], 'a'],
      [['x', 'y', 'z'], 'xyz'],
      [['x', 'y', 'z'], ''],
      [['Total: ', '$100.00'], 'Total: $1,250.00'],
      [['ﬁrst'], 'first'],
    ]
    for (const [runs, next] of cases) {
      expect(join(distribute(runs, next).texts)).toBe(next)
    }
  })
})
