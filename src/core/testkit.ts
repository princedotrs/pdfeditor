/**
 * Test-only helpers for driving the interpreter over a hand-written content
 * stream with a real (pdf-lib backed) resource dictionary.
 */
import { PDFDocument, PDFDict, PDFName, StandardFonts } from 'pdf-lib'
import { FontCache } from './font'
import { ContentInterpreter } from './interpreter'
import { IDENTITY, type Matrix } from './matrix'
import { latin1ToBytes } from './lexer'
import type { TextRun } from './model'

export interface FormSpec {
  content: string
  /** Form `/Matrix`; defaults to the identity. */
  matrix?: Matrix
  /** Font resource names the form declares for itself. */
  fonts?: Record<string, StandardFonts>
}

export interface Harness {
  doc: PDFDocument
  resources: PDFDict
  interpret(content: string): TextRun[]
}

/**
 * Build a document whose page resources contain the requested standard fonts
 * under the given names, plus any Form XObjects, then interpret arbitrary
 * content against them.
 */
export async function makeHarness(
  fonts: Record<string, StandardFonts> = { F1: StandardFonts.Helvetica },
  forms: Record<string, FormSpec> = {},
  /** Named colour spaces, as the array form that appears in /Resources. */
  colorSpaces: Record<string, unknown[]> = {
    Sep: ['Separation', 'Spot', 'DeviceCMYK', null],
    Icc1: ['ICCBased', null],
  }
): Promise<Harness> {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])

  const embed = (map: Record<string, StandardFonts>): PDFDict => {
    const dict = doc.context.obj({})
    for (const [name, std] of Object.entries(map)) {
      dict.set(PDFName.of(name), doc.embedStandardFont(std).ref)
    }
    return dict
  }

  const fontDict = embed(fonts)

  const resources = doc.context.obj({}) as PDFDict
  resources.set(PDFName.of('Font'), fontDict)

  if (Object.keys(forms).length > 0) {
    const xobjects = doc.context.obj({}) as PDFDict
    for (const [name, spec] of Object.entries(forms)) {
      const stream = doc.context.stream(latin1ToBytes(spec.content), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 612, 792],
        ...(spec.matrix ? { Matrix: [...spec.matrix] } : {}),
      })
      if (spec.fonts) {
        const formResources = doc.context.obj({}) as PDFDict
        formResources.set(PDFName.of('Font'), embed(spec.fonts))
        stream.dict.set(PDFName.of('Resources'), formResources)
      }
      xobjects.set(PDFName.of(name), doc.context.register(stream))
    }
    resources.set(PDFName.of('XObject'), xobjects)
  }

  if (Object.keys(colorSpaces).length > 0) {
    const spaces = doc.context.obj({}) as PDFDict
    for (const [name, definition] of Object.entries(colorSpaces)) {
      spaces.set(PDFName.of(name), doc.context.obj(definition as never))
    }
    resources.set(PDFName.of('ColorSpace'), spaces)
  }

  // Materialise every embedded font. This has to happen after the forms are
  // built, since they embed fonts of their own.
  await doc.save()

  return {
    doc,
    resources,
    interpret(content: string): TextRun[] {
      const cache = new FontCache(doc.context)
      const interpreter = new ContentInterpreter(doc.context, cache)
      return interpreter.interpret(
        { key: 'page:0', bytes: latin1ToBytes(content), resources },
        { pageIndex: 0, baseCtm: IDENTITY }
      ).runs
    },
  }
}
