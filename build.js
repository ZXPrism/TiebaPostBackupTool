const { version } = require("./package.json");
const fs = require("fs");
const path = require("path");

const header = `\
// ==UserScript== \n\
// @name         Tieba Post Backup Tool \n\
// @namespace    https://github.com/ZXPrism/TiebaPostBackupTool \n\
// @version      ${version} \n\
// @description  Automatically backup tieba posts in a single click \n\
// @author       ZXP4 \n\
// @license      MIT \n\
// @match        https://tieba.baidu.com/p/* \n\
// @grant        GM_registerMenuCommand \n\
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js \n\
// ==/UserScript== \n\n`;

const distFilePath = path.resolve(__dirname, "dist", "TiebaPostBackupTool.js")

fs.readFile(distFilePath, "utf8", (err, data) => {
    if (err) {
        console.log("build.js: error: failed to read the bundle");
        return;
    }

    const result = header + data;
    fs.writeFile(distFilePath, result, "utf8", (err) => {
        if (err) {
            console.log("build.js: error: failed to write to the bundle");
            return;
        }
        console.log("build.js: bundle written successfully");
    });

});
