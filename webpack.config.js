const path = require('path');

module.exports = {
    entry: './webpack-plugin.ts',
    devtool: 'inline-source-map',
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /.node$/,
                loader: 'node-loader',
            }
        ],
    },
    resolve: {
        extensions: [ '.ts', '.js', ],
    },
    output: {
        filename: 'hscrypt-webpack-plugin.bundle.js',
        path: path.resolve(__dirname, 'dist'),
        library: 'mylib',
        libraryTarget: 'umd',
        umdNamedDefine: true
    },
};
