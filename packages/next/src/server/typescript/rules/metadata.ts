import { NEXT_TS_ERRORS } from '../constant'
import { getInfo, getSource, getTs, isPositionInsideNode } from '../utils'

const TYPE_ANOTATION = ': Metadata'
const TYPE_ANOTATION_ASYNC = ': Promise<Metadata> | Metadata'
const TYPE_IMPORT = `import type { Metadata } from 'next'`

// Find the `export const metadata = ...` node.
function getMetadataExport(fileName: string, position: number) {
  const source = getSource(fileName)
  let metadataExport: ts.VariableDeclaration | undefined

  if (source) {
    const ts = getTs()
    ts.forEachChild(source, function visit(node) {
      if (metadataExport) return

      // Covered by this node
      if (isPositionInsideNode(position, node)) {
        // Export variable
        if (
          ts.isVariableStatement(node) &&
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          if (ts.isVariableDeclarationList(node.declarationList)) {
            for (const declaration of node.declarationList.declarations) {
              if (
                isPositionInsideNode(position, declaration) &&
                declaration.name.getText() === 'metadata'
              ) {
                // `export const metadata = ...`
                metadataExport = declaration
                return
              }
            }
          }
        }
      }
    })
  }
  return metadataExport
}

let cachedProxiedLanguageService: ts.LanguageService | undefined
let cachedProxiedLanguageServiceHost: ts.LanguageServiceHost | undefined
function getProxiedLanguageService() {
  if (cachedProxiedLanguageService)
    return {
      languageService: cachedProxiedLanguageService as ts.LanguageService,
      languageServiceHost:
        cachedProxiedLanguageServiceHost as ts.LanguageServiceHost & {
          addFile: (fileName: string, body: string) => void
        },
    }

  const languageServiceHost = getInfo().languageServiceHost

  const ts = getTs()
  class ProxiedLanguageServiceHost implements ts.LanguageServiceHost {
    files: { [fileName: string]: { file: ts.IScriptSnapshot; ver: number } } =
      {}

    log = () => {}
    trace = () => {}
    error = () => {}
    getCompilationSettings = () => languageServiceHost.getCompilationSettings()
    getScriptIsOpen = () => true
    getCurrentDirectory = () => languageServiceHost.getCurrentDirectory()
    getDefaultLibFileName = (o: any) =>
      languageServiceHost.getDefaultLibFileName(o)

    getScriptVersion = (fileName: string) => {
      const file = this.files[fileName]
      if (!file) return languageServiceHost.getScriptVersion(fileName)
      return file.ver.toString()
    }

    getScriptSnapshot = (fileName: string) => {
      const file = this.files[fileName]
      if (!file) return languageServiceHost.getScriptSnapshot(fileName)
      return file.file
    }

    getScriptFileNames(): string[] {
      const names: Set<string> = new Set()
      for (var name in this.files) {
        if (this.files.hasOwnProperty(name)) {
          names.add(name)
        }
      }
      const files = languageServiceHost.getScriptFileNames()
      for (const file of files) {
        names.add(file)
      }
      return [...names]
    }

    addFile(fileName: string, body: string) {
      const snap = ts.ScriptSnapshot.fromString(body)
      snap.getChangeRange = (_) => undefined
      const existing = this.files[fileName]
      if (existing) {
        this.files[fileName].ver++
        this.files[fileName].file = snap
      } else {
        this.files[fileName] = { ver: 1, file: snap }
      }
    }

    readFile(fileName: string) {
      const file = this.files[fileName]
      return file
        ? file.file.getText(0, file.file.getLength())
        : languageServiceHost.readFile(fileName)
    }
    fileExists(fileName: string) {
      return (
        this.files[fileName] !== undefined ||
        languageServiceHost.fileExists(fileName)
      )
    }
  }

  cachedProxiedLanguageServiceHost = new ProxiedLanguageServiceHost()
  cachedProxiedLanguageService = ts.createLanguageService(
    cachedProxiedLanguageServiceHost,
    ts.createDocumentRegistry()
  )
  return {
    languageService: cachedProxiedLanguageService as ts.LanguageService,
    languageServiceHost:
      cachedProxiedLanguageServiceHost as ts.LanguageServiceHost & {
        addFile: (fileName: string, body: string) => void
      },
  }
}

function updateVirtualFileWithType(
  fileName: string,
  node: ts.VariableDeclaration | ts.FunctionDeclaration,
  isGenerateMetadata?: boolean
) {
  const source = getSource(fileName)
  if (!source) return

  // We annotate with the type in a vritual language service
  const sourceText = source.getFullText()
  let nodeEnd: number
  let annotation: string

  const ts = getTs()
  if (ts.isFunctionDeclaration(node)) {
    if (isGenerateMetadata) {
      nodeEnd = node.body!.getFullStart()
      annotation = TYPE_ANOTATION_ASYNC
    } else {
      return
    }
  } else {
    nodeEnd = node.name.getFullStart() + node.name.getFullWidth()
    annotation = TYPE_ANOTATION
  }

  const newSource =
    sourceText.slice(0, nodeEnd) +
    annotation +
    sourceText.slice(nodeEnd) +
    TYPE_IMPORT
  const { languageServiceHost } = getProxiedLanguageService()
  languageServiceHost.addFile(fileName, newSource)

  return [nodeEnd, annotation.length]
}

function isTyped(node: ts.VariableDeclaration | ts.FunctionDeclaration) {
  return node.type !== undefined
}

const metadata = {
  filterCompletionsAtPosition(
    fileName: string,
    position: number,
    _options: any,
    prior: ts.WithMetadata<ts.CompletionInfo>
  ) {
    const node = getMetadataExport(fileName, position)
    if (!node) return prior
    if (isTyped(node)) return prior

    const ts = getTs()

    // We annotate with the type in a vritual language service
    const pos = updateVirtualFileWithType(fileName, node)
    if (pos === undefined) return prior

    // Get completions
    const { languageService } = getProxiedLanguageService()
    const newPos = position <= pos[0] ? position : position + pos[1]
    const completions = languageService.getCompletionsAtPosition(
      fileName,
      newPos,
      undefined
    )

    if (completions) {
      completions.isIncomplete = true

      completions.entries = completions.entries
        .filter((e) => {
          return [
            ts.ScriptElementKind.memberVariableElement,
            ts.ScriptElementKind.typeElement,
            ts.ScriptElementKind.string,
          ].includes(e.kind)
        })
        .map((e) => {
          const insertText =
            e.kind === ts.ScriptElementKind.memberVariableElement &&
            /^[a-zA-Z0-9_]+$/.test(e.name)
              ? e.name + ': '
              : e.name

          return {
            name: e.name,
            insertText,
            kind: e.kind,
            kindModifiers: e.kindModifiers,
            sortText: '!' + e.name,
            labelDetails: {
              description: `Next.js metadata`,
            },
            data: e.data,
          }
        })

      return completions
    }

    return prior
  },

  getSemanticDiagnosticsForExportVariableStatementInClientEntry(
    fileName: string,
    node: ts.VariableStatement | ts.FunctionDeclaration
  ) {
    const source = getSource(fileName)
    const ts = getTs()

    // It is not allowed to export `metadata` or `generateMetadata` in client entry
    if (ts.isFunctionDeclaration(node)) {
      if (node.name?.getText() === 'generateMetadata') {
        return [
          {
            file: source,
            category: ts.DiagnosticCategory.Error,
            code: NEXT_TS_ERRORS.INVALID_METADATA_EXPORT,
            messageText: `The Next.js 'generateMetadata' API is not allowed in a client component.`,
            start: node.name.getStart(),
            length: node.name.getWidth(),
          },
        ]
      }
    } else {
      for (const declaration of node.declarationList.declarations) {
        const name = declaration.name.getText()
        if (name === 'metadata') {
          return [
            {
              file: source,
              category: ts.DiagnosticCategory.Error,
              code: NEXT_TS_ERRORS.INVALID_METADATA_EXPORT,
              messageText: `The Next.js 'metadata' API is not allowed in a client component.`,
              start: declaration.name.getStart(),
              length: declaration.name.getWidth(),
            },
          ]
        }
      }
    }
    return []
  },

  getSemanticDiagnosticsForExportVariableStatement(
    fileName: string,
    node: ts.VariableStatement | ts.FunctionDeclaration
  ) {
    const source = getSource(fileName)
    const ts = getTs()

    function proxyDiagnostics(
      pos: number[],
      n: ts.VariableDeclaration | ts.FunctionDeclaration
    ) {
      // Get diagnostics
      const { languageService } = getProxiedLanguageService()
      const diagnostics = languageService.getSemanticDiagnostics(fileName)

      // Filter and map the results
      return diagnostics
        .filter((d) => {
          if (d.start === undefined || d.length === undefined) return false
          if (d.start < n.getFullStart()) return false
          if (
            d.start + d.length >=
            n.getFullStart() + n.getFullWidth() + pos[1]
          )
            return false
          return true
        })
        .map((d) => {
          return {
            file: source,
            category: d.category,
            code: d.code,
            messageText: d.messageText,
            start: d.start! < pos[0] ? d.start : d.start! - pos[1],
            length: d.length,
          }
        })
    }

    if (ts.isFunctionDeclaration(node)) {
      if (node.name?.getText() === 'generateMetadata') {
        if (isTyped(node)) return []

        // We annotate with the type in a vritual language service
        const pos = updateVirtualFileWithType(fileName, node, true)
        if (!pos) return []

        return proxyDiagnostics(pos, node)
      }
    } else {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.name.getText() === 'metadata') {
          if (isTyped(declaration)) break

          // We annotate with the type in a vritual language service
          const pos = updateVirtualFileWithType(fileName, declaration)
          if (!pos) break

          return proxyDiagnostics(pos, declaration)
        }
      }
    }
    return []
  },

  getCompletionEntryDetails(
    fileName: string,
    position: number,
    entryName: string,
    formatOptions: ts.FormatCodeOptions,
    source: string,
    preferences: ts.UserPreferences,
    data: ts.CompletionEntryData
  ) {
    const node = getMetadataExport(fileName, position)
    if (!node) return
    if (isTyped(node)) return

    // We annotate with the type in a vritual language service
    const pos = updateVirtualFileWithType(fileName, node)
    if (pos === undefined) return

    const { languageService } = getProxiedLanguageService()
    const newPos = position <= pos[0] ? position : position + pos[1]

    const details = languageService.getCompletionEntryDetails(
      fileName,
      newPos,
      entryName,
      formatOptions,
      source,
      preferences,
      data
    )
    return details
  },

  getQuickInfoAtPosition(fileName: string, position: number) {
    const node = getMetadataExport(fileName, position)
    if (!node) return
    if (isTyped(node)) return

    // We annotate with the type in a vritual language service
    const pos = updateVirtualFileWithType(fileName, node)
    if (pos === undefined) return

    const { languageService } = getProxiedLanguageService()
    const newPos = position <= pos[0] ? position : position + pos[1]
    const insight = languageService.getQuickInfoAtPosition(fileName, newPos)
    return insight
  },

  getDefinitionAndBoundSpan(fileName: string, position: number) {
    const node = getMetadataExport(fileName, position)
    if (!node) return
    if (isTyped(node)) return
    if (!isPositionInsideNode(position, node)) return
    // We annotate with the type in a vritual language service
    const pos = updateVirtualFileWithType(fileName, node)
    if (pos === undefined) return
    const { languageService } = getProxiedLanguageService()
    const newPos = position <= pos[0] ? position : position + pos[1]

    const definitionInfoAndBoundSpan =
      languageService.getDefinitionAndBoundSpan(fileName, newPos)

    if (definitionInfoAndBoundSpan) {
      // Adjust the start position of the text span
      if (definitionInfoAndBoundSpan.textSpan.start > pos[0]) {
        definitionInfoAndBoundSpan.textSpan.start -= pos[1]
      }
    }
    return definitionInfoAndBoundSpan
  },
}

export default metadata
