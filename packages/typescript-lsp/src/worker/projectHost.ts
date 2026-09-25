import ts from 'typescript'

const ROOT = '/'

/** What request handlers read: the language service and the program's view of one file. */
export type ProjectService = {
  readonly languageService: ts.LanguageService
  getSourceFile(fileName: string): ts.SourceFile | undefined
}

/**
 * The files one TypeScript program sees, held in memory and changed one file at a time.
 *
 * Every file carries a version, so after an upsert the language service reparses that file and
 * reuses every other one; nothing here rebuilds the program from scratch. Open documents sit over
 * the files: their text wins until they close, and closing falls back to the file, if there is one.
 * Paths are the host's own, with no symlinks to resolve: `realpath` is the identity.
 */
export class ProjectHost implements ProjectService {
  public readonly languageService: ts.LanguageService
  readonly #files: Map<string, string>
  readonly #open = new Map<string, string>()
  readonly #versions = new Map<string, number>()
  readonly #directories = new Set<string>([ROOT])
  #roots: readonly string[]
  #projectVersion = 0

  public constructor(
    files: Map<string, string>,
    roots: readonly string[],
    private readonly options: ts.CompilerOptions,
  ) {
    this.#files = files
    this.#roots = roots
    for (const fileName of files.keys()) this.#addDirectories(fileName)
    this.languageService = ts.createLanguageService(this.#host())
  }

  public getSourceFile(fileName: string): ts.SourceFile | undefined {
    return this.languageService.getProgram()?.getSourceFile(fileName)
  }

  public setFile(fileName: string, text: string): void {
    if (this.#files.get(fileName) === text) return
    this.#files.set(fileName, text)
    this.#addDirectories(fileName)
    this.#changed(fileName)
  }

  public deleteFile(fileName: string): void {
    if (!this.#files.delete(fileName)) return
    this.#changed(fileName)
  }

  public setOpen(fileName: string, text: string): void {
    this.#open.set(fileName, text)
    this.#addDirectories(fileName)
    this.#changed(fileName)
  }

  public closeOpen(fileName: string): void {
    if (!this.#open.delete(fileName)) return
    this.#changed(fileName)
  }

  public setRoots(roots: readonly string[]): void {
    if (sameList(this.#roots, roots)) return
    this.#roots = roots
    this.#projectVersion += 1
  }

  #changed(fileName: string): void {
    this.#versions.set(fileName, (this.#versions.get(fileName) ?? 0) + 1)
    this.#projectVersion += 1
  }

  #text(fileName: string): string | undefined {
    return this.#open.get(fileName) ?? this.#files.get(fileName)
  }

  #addDirectories(fileName: string): void {
    for (
      let index = fileName.lastIndexOf('/');
      index > 0;
      index = fileName.lastIndexOf('/', index - 1)
    ) {
      const directory = fileName.slice(0, index)
      if (this.#directories.has(directory)) return
      this.#directories.add(directory)
    }
  }

  #host(): ts.LanguageServiceHost {
    return {
      getCompilationSettings: () => this.options,
      getProjectVersion: () => String(this.#projectVersion),
      getScriptFileNames: () => [...this.#roots, ...this.#openOutsideRoots()],
      getScriptVersion: (fileName) => String(this.#versions.get(fileName) ?? 0),
      getScriptSnapshot: (fileName) => {
        const text = this.#text(fileName)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => ROOT,
      getDefaultLibFileName: (options) => `${ROOT}${ts.getDefaultLibFileName(options)}`,
      fileExists: (fileName) => this.#text(fileName) !== undefined,
      readFile: (fileName) => this.#text(fileName),
      directoryExists: (directory) => this.#directories.has(trimSlash(directory)),
      getDirectories: (directory) => this.#childDirectories(trimSlash(directory)),
      readDirectory: (directory, extensions) =>
        this.#readDirectory(trimSlash(directory), extensions),
      realpath: (fileName) => fileName,
      useCaseSensitiveFileNames: () => true,
    }
  }

  /** An open document outside the project's roots is still a file the client asks about. */
  #openOutsideRoots(): string[] {
    const roots = new Set(this.#roots)
    return Array.from(this.#open.keys()).filter((fileName) => !roots.has(fileName))
  }

  #childDirectories(parent: string): string[] {
    const prefix = parent === ROOT ? ROOT : `${parent}/`
    const children: string[] = []
    for (const directory of this.#directories) {
      if (!directory.startsWith(prefix) || directory === parent) continue
      const rest = directory.slice(prefix.length)
      if (!rest.includes('/')) children.push(rest)
    }
    return children
  }

  #readDirectory(directory: string, extensions: readonly string[] | undefined): string[] {
    const prefix = directory === ROOT ? ROOT : `${directory}/`
    return Array.from(this.#files.keys()).filter(
      (fileName) =>
        fileName.startsWith(prefix) &&
        (!extensions || extensions.some((extension) => fileName.endsWith(extension))),
    )
  }
}

function trimSlash(directory: string): string {
  if (directory.length > 1 && directory.endsWith('/')) return directory.slice(0, -1)
  return directory
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}
