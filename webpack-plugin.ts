import { escapeRegExp } from 'lodash'
import { SyncHook } from 'tapable'
import { Compiler, Compilation } from 'webpack'
import * as HTMLWebpackPlugin from "html-webpack-plugin"
import * as fs from "fs";
import * as path from "path";
import * as hscrypt from 'hscrypt';
const fetch = require('node-fetch-commonjs');

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

type Source = string | Buffer

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
export const DEFAULT_HSCRYPT = 'https://raw.githubusercontent.com/hscrypt/js/5782bb0d93d7c8c50e3c8d001a7870a8d545fd8f/dist/src/hscrypt.mjs'
export const DEFAULT_HSCRYPT_SRC = './hscrypt.mjs'
export const DEFAULT_INJECT_CONFIG_VAR = 'HSCRYPT_CONFIG'

export interface Config {
    [key: string]: any
    filename: string            // JS bundle to encrypt/inject/decrypt
    pswd: string                // Encryption/Decryption key; provided to the plugin in webpack.config.js at build time, and by users as a URL "hash" at page load time
    hscrypt?: string            // If an `hscrypt.mjs` isn't found at `hscryptSrc`, fetch one from this URL
    hscryptSrc?: string         // Look for `hscrypt.mjs` locally at this path
    path?: string               // Output directory to look for `filename` in (e.g. `dist`)
    debug?: boolean | number    // Toggle debug logging
    replace?: ReplaceConfig     // Where to inject the hscrypt "injection" <script> tag (default: just before "</head>"
    iterations?: number         // PBKDF2 iterations (when generating decryption key from password); default: 10_000 (cf. `hscrypt.utils.DEFAULT_ITERATIONS`)
    outFilename?: string        // Override output (encrypted) filename (default: `${filename}.encrypted`)
    cache?: boolean             // Cache the (post-PBKDF2) decryption key in `localStorage`, for faster subsequent page loads
    missingKeyCb?: string       // Global name of a callback (e.g. `MyApp.myMissingKeyCb`) of type ({ msg: string }) => void; see `hscrypt.MissingKeyCb`
    decryptionErrorCb?: string  // Global name of a callback (e.g. `MyApp.myDecryptionErrorCb`) of type ({ err: hscrypt.DecryptionError, cacheHit: boolean }) => void; see `hscrypt.DecryptionErrorCb`
    scrubHash?: boolean         // When a password is pulled from the URL hash, remove it from the hash (default: true)
    watchHash?: boolean         // When decryption doesn't initially succeed on a page (based on URL hash / localStorage cache), register a `window.hashchange` listener, and re-attempt decryption if a new URL hash value is entered (or navigated to)
    injectConfigVar?: string    // Name of a variable injected into the page containing config values (typically a subset of the other fields in this `Config` object) to be passed to `hscrypt.inject`; default: `DEFAULT_INJECT_CONFIG_VAR` i.e. "HSCRYPT_CONFIG"
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

    protected get injectConfigVar() {
        return this.config.injectConfigVar || DEFAULT_INJECT_CONFIG_VAR
    }

    protected get encryptedPath(): string {
        return `${this.filename}.encrypted`
    }

    protected get outFilename() {
        return this.config.outFilename || DEFAULT_OUT_FILENAME
    }

    protected get hscrypt() {
        return this.config.hscrypt || DEFAULT_HSCRYPT
    }
    protected get hscryptSrc() {
        return this.config.hscryptSrc || DEFAULT_HSCRYPT_SRC
    }

    protected encrypt({ source, pswd, iterations, }: {
        source: Source
        pswd: string
        iterations?: number
    }) {
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
                this.encrypt({
                    source,
                    pswd: this.config.pswd,
                    iterations: this.config.iterations,
                })
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
            iterations,
        }: {
            html: string
            htmlFileName: string
            iterations?: number
        }
    ) {
        const hscryptTag = `<script src="${this.hscryptSrc}"></script>`
        let args = [
            `src: '${this.encryptedPath}'`,
        ]
        if (iterations) {
            args.push(`iterations: ${iterations}`)
        }

        const configKeys = [ 'cache', 'missingKeyCb', 'decryptionErrorCb', 'scrubHash', 'watchHash', ]
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
                args.push(`${k}: "${v}"`)
            } else if (typeof v === 'boolean') {
                args.push(`${k}: ${v}`)
            }
        }
        const argsString = `{ ${args.join(", ")} }`
        const injectConfigStmt = `var ${this.injectConfigVar} = ${argsString}`
        const injectTag = `<script>window.onload = () => { ${injectConfigStmt}; hscrypt.inject(${this.injectConfigVar}) }</script>`
        const replaceValues = [hscryptTag].concat([
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
        this.log("process:", data)
        if (data.outputName == this.outFilename) {
            const sources = this.scriptMap.get(data.plugin) || []

            sources.forEach(() => {
                // TODO: `source` unused; assumed to just be adding this.config.filename; should check/verify/simplify
                // this
                this.log(`process script; html before:\n${data.html}`)
                data.html = this.addScript({
                    html: data.html,
                    htmlFileName: data.outputName,
                    iterations: this.config.iterations,
                })
                this.log(`process script; html after:\n${data.html}`)
            })

            const dst = path.join(outputDir, this.hscryptSrc)
            if (fs.existsSync(dst)) {
                this.log(`Already found ${dst}`)
            } else {
                this.log(`Fetching ${this.hscrypt}`)
                // TODO: await?
                fetch(this.hscrypt)
                    .then((response: any) => response.text())
                    .then((source: any) => {
                        fs.writeFileSync(dst, source)
                        this.log(`Wrote ${dst}`)
                    })
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
