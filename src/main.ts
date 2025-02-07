import { Parser } from "./Parser";

(function () {
    'use strict';

    const parser = new Parser();

    GM_registerMenuCommand("重置（出现 BUG 时使用）", () => {
        parser.Reset();
    });

    window.addEventListener("load", () => {
        if (!parser.ContinueParse()) {
            GM_registerMenuCommand("备份当前贴子", () => {
                parser.Parse();
            });
        }
    });
})();
