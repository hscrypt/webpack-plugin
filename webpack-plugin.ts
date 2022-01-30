import { escapeRegExp } from 'lodash'
import { SyncHook } from 'tapable'
import { Compiler } from 'webpack'
import HTMLWebpackPlugin = require("html-webpack-plugin")
import * as fs from "fs";

export function is(filenameExtension: string) {
    const reg = new RegExp(`\.${filenameExtension}$`)
    return (fileName: string) => reg.test(fileName)
}

export const isJS = is('js')

interface BeforeAssetTagGenerationData {
    outputName: string
    assets: {
        publicPath: string
        js: string[]
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

type Script = string

export interface ReplaceConfig {
    position?: 'before' | 'after'
    removeTarget?: boolean
    target: string
}

// export type ScriptTagFactory = (params: { script: string }) => string

export const DEFAULT_REPLACE_CONFIG: ReplaceConfig = {
    target: '</head>',
}

export interface Config {
    filename: string,
    hscrypt: string,
    path?: string
    debug?: boolean
    // filter?(fileName: string): boolean
    replace?: ReplaceConfig
    // scriptTagFactory?: ScriptTagFactory
}

export interface FileCache {
    [fileName: string]: string // file content
}

interface Asset {
    source(): string
    size(): number
}

interface Compilation {
    assets: { [key: string]: Asset }
}

export default class HscryptPlugin {
    // Using object reference to distinguish styles for multiple files
    private scriptMap: Map<HTMLWebpackPlugin, Script[]> = new Map()
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
        return `${this.filename}.gpg`
    }

    protected encrypt(source: string) {
        let { encryptedPath } = this
        encryptedPath = this.config.path ? `${this.config.path}/${encryptedPath}` : encryptedPath
        this.log(`Writing source from ${this.filename} to ${encryptedPath}`)
        fs.writeFileSync(encryptedPath, source)
    }

    protected prepare({ assets }: Compilation) {
        Object.keys(assets).forEach(filename => {
            this.log(`checking js asset: ${filename}`)
            if (isJS(filename) && this.shouldReplace(filename)) {
                const source = assets[filename].source()
                this.scriptCache[filename] = source
                this.encrypt(source)
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
    ): string | undefined {
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
        const hscryptTag = `<script type="module" src="${this.config.hscrypt}"></script>`
        const injectTag = `<script type="module">window.onload = () => hscrypt.inject('${this.encryptedPath}')</script>`
        const replaceValues = [
            hscryptTag,
            injectTag,
            this.replaceConfig.target,
        ]

        if (html.indexOf(this.replaceConfig.target) === -1) {
            throw new Error(
                `Can't inject script ${this.filename} into "${htmlFileName}", didn't find replace target "${this.replaceConfig.target}"`,
            )
        }

        return html.replace(this.replaceConfig.target, replaceValues.join(''))
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
                const scriptIdx = data.assets.js.indexOf(source)
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

            sources.forEach(source => {
                // TODO: script unused
                this.log(`process script; html before:\n${data.html}`)
                data.html = this.addScript({
                    html: data.html,
                    htmlFileName: data.outputName,
                })
                this.log(`process script; html after:\n${data.html}`)
            })
        }
    }

    apply(compiler: Compiler) {
        compiler.hooks.compilation.tap(
            `hscrypt_compilation`,
            (compilation) => {
                const hooks: HTMLWebpackPluginHooks = (HTMLWebpackPlugin as any).getHooks(
                    compilation,
                )

                hooks.beforeAssetTagGeneration.tap(
                    `hscrypt_beforeAssetTagGeneration`,
                    (data) => {
                        this.prepare(compilation)
                        this.prepareScript(data)
                    },
                )

                hooks.beforeEmit.tap(`hscrypt_beforeEmit`, (data) => {
                    this.process(data)
                })
            },
        )

        if (this.config.debug) {
            compiler.hooks.done.tap(
                'hscrypt_rm_script',
                (stats) => {
                    this.log("stats:", stats)
                }
            )
        }
    }
}
