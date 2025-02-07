const path = require('path');

module.exports = {
    optimization: {
        minimize: false,
        splitChunks: {
            chunks: 'all'
        },
    },
    entry: "./src/main.ts",
    target: "web",
    resolve: {
        extensions: [".ts", ".js"]
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: "ts-loader",
                    options: {
                    }
                },
                exclude: /node_modules/
            }
        ]
    },
    externals: { 'jszip': 'JSZip' },
    output: {
        filename: "TiebaPostBackupTool.js",
        path: path.resolve(__dirname, "dist")
    }
};
