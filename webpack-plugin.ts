import { escapeRegExp } from 'lodash'
import { SyncHook } from 'tapable'
import { Compiler, Compilation } from 'webpack'
import * as HTMLWebpackPlugin from "html-webpack-plugin"
import * as fs from "fs";
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

export interface Config {
    filename: string,
    pswd: string,
    hscrypt?: string,
    path?: string
    debug?: boolean | number
    replace?: ReplaceConfig
    iterations?: number
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
        const hscryptTag = this.config.hscrypt ? [`<script type="module" src="${this.config.hscrypt}"></script>`] : []
        let args = [
            `'${this.encryptedPath}'`,
            `window.location.hash.substring(1)`,
        ]
        if (iterations) {
            args.push(iterations.toString())
        }
        const injectTag = `<script type="module">window.onload = () => hscrypt.inject(${args.join(', ')})</script>`
        const replaceValues = hscryptTag.concat([
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

    private process(data: BeforeEmitData) {
        // check if current html needs to be inlined
        this.log("process:", data)
        if (data.outputName == 'index.html') {
            const sources = this.scriptMap.get(data.plugin) || []

            sources.forEach(() => {
                // TODO: `source` unused; assumed to just be adding this.config.filename; should check/verify/simplify
                //  this
                this.log(`process script; html before:\n${data.html}`)
                data.html = this.addScript({
                    html: data.html,
                    htmlFileName: data.outputName,
                    iterations: this.config.iterations,
                })
                this.log(`process script; html after:\n${data.html}`)
            })
        }
    }

    apply(compiler: Compiler) {
        compiler.hooks.compilation.tap(
            `hscrypt_compilation`,
            compilation => {
                this.log("COMPILATION!")
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
                    this.process(data)
                })
            },
        )
    }
}
