import { escapeRegExp } from 'lodash'
import { SyncHook } from 'tapable'
import { Compiler, Compilation } from 'webpack'
import * as HTMLWebpackPlugin from "html-webpack-plugin"
import * as fs from "fs";
import * as path from "path";
import * as hscrypt from 'hscrypt';

export function is(filenameExtension: string) {
    const reg = new RegExp(`\.${filenameExtension}$`)
    return (fileName: string) => reg.test(fileName)
}

export const isJS = is('js')

interface BeforeAssetTagGenerationData {
    outputName: string
    assets: {
        publicPath: string
        js: Array<string>
    }
    plugin: HTMLWebpackPlugin
}

interface BeforeEmitData {
    html: string
    outputName: string
    plugin: HTMLWebpackPlugin
}

interface HTMLWebpackPluginHooks {
    beforeAssetTagGeneration: SyncHook<BeforeAssetTagGenerationData>
    beforeEmit: SyncHook<BeforeEmitData>
}

type Source = hscrypt.Source

// TODO: parameterize this as `{head,body} x {beginning,end}`, or as an element id or selector
export interface ReplaceConfig {
    position?: 'before' | 'after'
    removeTarget?: boolean
    target: string
}

export const DEFAULT_REPLACE_CONFIG: ReplaceConfig = {
    target: '</head>',
}

export const DEFAULT_OUT_FILENAME = 'index.html'
export const DEFAULT_HSCRYPT_SRC = 'hscrypt/dist/src/hscrypt.mjs'
export const DEFAULT_HSCRYPT_DST = 'hscrypt.mjs'
export const HSCRYPT_CONFIG_VAR = hscrypt.HSCRYPT_CONFIG_VAR

export interface Config {
    [key: string]: any
    filename: string              // JS bundle to encrypt/inject/decrypt
    pswd: string                  // Encryption/Decryption key; provided to the plugin in webpack.config.js at build time, and by users as a URL "hash" at page load time
    injectHscryptMjs?: boolean    // Default: true; optionally disable injecting hscrypt.mjs (e.g. if the non-encrypted wrapper bundle includes hscrypt already)
    hscryptSrc?: string           // Look for a copy of `hscrypt.mjs` locally at this path, relative `path`; by default, will try to find it in node_modules/hscrypt
    hscryptDst?: string           // Copy `hscrypt.mjs` from `hscryptSrc` to this location (which will be used as the `<script src="…">` in the injected script). Default: `hscrypt.mjs`
    path?: string                 // Output directory to look for `filename` in (e.g. `dist`)
    debug?: boolean | number      // Toggle debug logging
    replace?: ReplaceConfig       // Where to inject the hscrypt "injection" <script> tag (default: just before "</head>"
    iterations?: number           // PBKDF2 iterations (when generating decryption key from password); default: 10_000 (cf. `hscrypt.utils.DEFAULT_ITERATIONS`)
    outFilename?: string          // Override output (encrypted) filename (default: `${filename}.encrypted`)
    cacheDecryptionKey?: boolean  // Cache the (post-PBKDF2) decryption key in `localStorage`, for faster subsequent page loads
    missingKeyCb?: string         // Global name of a callback (e.g. `MyApp.myMissingKeyCb`) of type ({ msg: string }) => void; see `hscrypt.MissingKeyCb`
    decryptionErrorCb?: string    // Global name of a callback (e.g. `MyApp.myDecryptionErrorCb`) of type ({ err: hscrypt.DecryptionError, cacheHit: boolean }) => void; see `hscrypt.DecryptionErrorCb`
    scrubHash?: boolean           // When a password is pulled from the URL hash, remove it from the hash (default: true)
    watchHash?: boolean           // When decryption doesn't initially succeed on a page (based on URL hash / localStorage cache), register a `window.hashchange` listener, and re-attempt decryption if a new URL hash value is entered (or navigated to)
    injectConfigVar?: string      // Name of a variable injected into the page containing config values (typically a subset of the other fields in this `Config` object) to be passed to `hscrypt.inject`; default: `DEFAULT_INJECT_CONFIG_VAR` i.e. "HSCRYPT_CONFIG"
}

export interface FileCache {
    [filename: string]: Source  // file content
}

export default class HscryptPlugin {
    // Using object reference to distinguish styles for multiple files
    private scriptMap: Map<HTMLWebpackPlugin, Source[]> = new Map()
    protected scriptCache: FileCache = {}

    constructor(protected readonly config: Config) {}

    protected log(...args: any[]) {
        if (this.config.debug) {
            console.log(...args)
        }
    }

    protected get filename() {
        return this.config.filename
    }

    protected get replaceConfig() {
        return this.config.replace || DEFAULT_REPLACE_CONFIG
    }

    protected get encryptedPath(): string {
        return `${this.filename}.encrypted`
    }

    protected get outFilename() {
        return this.config.outFilename || DEFAULT_OUT_FILENAME
    }

    protected get injectHscryptMjs() {
        return this.config.injectHscryptMjs === undefined || this.config.injectHscryptMjs
    }

    protected findAncestorNamed(cur: string, name: string): string | null {
        while (path.basename(cur) != name) {
            const parent = path.dirname(cur)
            if (cur == parent) {
                return null
            }
            cur = parent
        }
        return cur
    }

    protected getHscryptSrc(outputDir?: string) {
        if (this.config.hscryptSrc) return this.config.hscryptSrc

        let node_modules = this.findAncestorNamed(__dirname, 'node_modules')
        if (node_modules) {
            this.log(`Found node_modules via cur dir ${__dirname}: ${node_modules}`)
        } else {
            if (outputDir) {
                node_modules = this.findAncestorNamed(outputDir, 'node_modules')
                if (node_modules) {
                    this.log(`Found node_modules via outputDir ${outputDir}: ${node_modules}`)
                }
            }
        }
        if (!node_modules) {
            throw new Error(`Couldn't find a node_modules directory in ancestry of ${__dirname}, ${outputDir}`)
        }
        return path.join(node_modules, DEFAULT_HSCRYPT_SRC)
    }

    protected get hscryptDst() {
        return this.config.hscryptDst || DEFAULT_HSCRYPT_DST
    }

    protected encrypt({ source, pswd, iterations, }: {
        source: Source
        pswd?: string
        iterations?: number
    }) {
        pswd = pswd || this.config.pswd
        iterations = iterations || this.config.iterations
        let { encryptedPath } = this
        const dir = this.config.path
        if (dir) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            encryptedPath = `${dir}/${encryptedPath}`
        }
        this.log(`Calling encrypt: ${iterations} iterations`)
        const encrypted = hscrypt.encrypt({ source, pswd, iterations, })
        this.log(`Writing source from ${this.filename} to ${encryptedPath}`)
        fs.writeFileSync(encryptedPath, encrypted)
    }

    protected prepare({ assets }: Compilation) {
        Object.keys(assets).forEach(filename => {
            this.log(`checking js asset: ${filename}`)
            if (isJS(filename) && this.shouldReplace(filename)) {
                const source = assets[filename].source()
                this.scriptCache[filename] = source
                this.encrypt({ source })
                delete assets[filename]
            }
        })
    }

    protected getScript(
        {
            script,
            publicPath,
        }: {
            script: string
            publicPath: string
        }
    ): Source | undefined {
        this.log(`getScript(${script}, ${publicPath})`)
        // Link pattern: publicPath + fileName + '?' + hash
        const filename = script
            .replace(new RegExp(`^${escapeRegExp(publicPath)}`), '')
            .replace(/\?.+$/g, '')

        if (!this.shouldReplace(filename)) return

        const source = this.scriptCache[filename]

        if (source === undefined) {
            console.error(
                `Can't find script matching ${source}. This may indicate a bug in hscrypt-webpack-plugin`,
            )
        }

        return source
    }

    protected shouldReplace(filename: string): boolean {
        return this.filename == filename
    }

    protected addScript(
        {
            html,
            htmlFileName,
        }: {
            html: string
            htmlFileName: string
        }
    ) {
        const hscryptTag = `<script src="${this.hscryptDst}"></script>`

        // Build a string literal (for injecting into the page in a <script> tag) representing an `HSCRYPT_CONFIG`
        // object that will be stored globally on the client (on the `window` object)
        let kvs = [
            `src: '${this.encryptedPath}'`,
        ]
        const iterations = this.config.iterations
        if (iterations) {
            kvs.push(`iterations: ${iterations}`)
        }
        const configKeys = [ 'cacheDecryptionKey', 'missingKeyCb', 'decryptionErrorCb', 'scrubHash', 'watchHash', ]
        for (const k of configKeys) {
            if (!(k in this.config)) continue
            const v = this.config[k]
            if (v === undefined) continue
            if (typeof v === 'string') {
                // There should not be untrusted data here (these are values from `this.config`), but perform a
                // best-effort check anyway
                if (v.indexOf('"') != -1) {
                    throw new Error(`Invalid "inject" arg, ${k}: ${v}`)
                }
                kvs.push(`${k}: "${v}"`)
            } else if (typeof v === 'boolean' || typeof v === 'number') {
                kvs.push(`${k}: ${v}`)
            }
        }
        const argsString = `{ ${kvs.join(", ")} }`
        const injectConfigStmt = `window.${HSCRYPT_CONFIG_VAR} = ${argsString}`

        // Inject <script> tag:
        // - define `window.HSCRYPT_CONFIG` with decryption configs
        // - pass `HSCRYPT_CONFIG` to `hscrypt.inject`
        const injectTag = `<script>window.onload = () => { ${injectConfigStmt}; hscrypt.inject(${HSCRYPT_CONFIG_VAR}) }</script>`
        const replaceValues = (this.injectHscryptMjs ? [hscryptTag] : []).concat([
            injectTag,
            this.replaceConfig.target,
        ])

        if (html.indexOf(this.replaceConfig.target) === -1) {
            throw new Error(
                `Can't inject script ${this.filename} into "${htmlFileName}", didn't find replace target "${this.replaceConfig.target}"`,
            )
        }

        return html.replace(this.replaceConfig.target, replaceValues.join('\n\t'))
    }

    private prepareScript(data: BeforeAssetTagGenerationData) {
        // `prepareScript` may be called more than once in webpack watch mode.
        // https://github.com/Runjuu/html-inline-css-webpack-plugin/issues/30
        // https://github.com/Runjuu/html-inline-css-webpack-plugin/issues/13
        this.scriptMap.clear()

        const scripts = data.assets.js
        this.log("scripts:", scripts)
        scripts.forEach(script => {
            if (!this.shouldReplace(script)) return
            this.log(`Loaded source for script ${script}`)
            const source = this.getScript({
                script,
                publicPath: data.assets.publicPath,
            })

            if (source) {
                if (this.scriptMap.has(data.plugin)) {
                    this.scriptMap.get(data.plugin)!.push(source)
                } else {
                    this.scriptMap.set(data.plugin, [source])
                }
                const scriptIdx = data.assets.js.indexOf(script)
                // prevent generate <script /> tag
                if (scriptIdx !== -1) {
                    data.assets.js.splice(scriptIdx, 1)
                }
            }
        })
    }

    private process(data: BeforeEmitData, outputDir: string) {
        // check if current html needs to be inlined
        this.log("process:", data, "outputDir:", outputDir, "curdir:", __dirname)
        if (data.outputName == this.outFilename) {
            const sources = this.scriptMap.get(data.plugin) || []

            sources.forEach(() => {
                // TODO: `source` unused; assumed to just be adding this.config.filename; should check/verify/simplify
                // this
                this.log(`process script; html before:\n${data.html}`)
                data.html = this.addScript({
                    html: data.html,
                    htmlFileName: data.outputName,
                })
                this.log(`process script; html after:\n${data.html}`)
            })

            if (this.injectHscryptMjs) {
                const hscryptSrc = this.getHscryptSrc(outputDir)
                const hscryptDst = path.join(outputDir, this.hscryptDst)
                if (fs.existsSync(hscryptSrc)) {
                    this.log(`Found hscrypt.mjs at ${hscryptSrc}; copying to ${hscryptDst}`)
                    fs.copyFileSync(hscryptSrc, hscryptDst)
                } else {
                    throw new Error(`Couldn't find hscrypt.mjs at ${hscryptSrc}`)
                }
            }
        }
    }

    apply(compiler: Compiler) {
        compiler.hooks.compilation.tap(
            `hscrypt_compilation`,
            compilation => {
                this.log(`COMPILATION! output.path: ${compilation.outputOptions.path}`)
                const hooks: HTMLWebpackPluginHooks = (HTMLWebpackPlugin as any).getHooks(
                    compilation,
                )

                hooks.beforeAssetTagGeneration.tap(
                    `hscrypt_beforeAssetTagGeneration`,
                    data => {
                        this.prepare(compilation)
                        this.prepareScript(data)
                    },
                )

                hooks.beforeEmit.tap(`hscrypt_beforeEmit`, data => {
                    this.process(data, compilation.outputOptions.path)
                })
            },
        )
    }
}
