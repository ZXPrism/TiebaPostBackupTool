import JSZip from "jszip";

export class Markdown {
    private _MarkdownData: string[] = [];
    private _ImagePathDict = new Map<string, string>();

    constructor() {

    }

    public Header(level: number, header: string) {
        if (level < 1 || level > 6) {
            throw new Error(`非法的 level: ${level}`);
        }
        this._MarkdownData.push(`${"#".repeat(level)} ${header}\n\n`);
    }

    public TableHeader(header: string[]) {
        this._MarkdownData.push(`| ${header.join(" | ")} |\n`);

        const align = new Array(header.length).fill("---");
        this._MarkdownData.push(`| ${align.join(" | ")} |\n`);
    }

    public TableData(data: string[]) {
        this._MarkdownData.push(`| ${data.join(" | ")} |\n`);
    }

    public Text(text: string) {
        this._MarkdownData.push(`${this._ResolveTags(text)}\n\n`);
    }

    public Quote(text: string) {
        this._MarkdownData.push(`> ${this._ResolveTags(text)}\n\n`);
    }

    public Image(imgPath: string, imgMissingText?: string) {
        this._MarkdownData.push(`![${imgMissingText ?? "image"}](${imgPath})\n\n`);
    }

    public URL(url: string) {
        this._MarkdownData.push(`URL: [${url}](${url})\n\n`);
    }

    public Separator() {
        this._MarkdownData.push("---\n\n");
    }

    public async Generate(filename: string) {
        let zip = new JSZip();
        const imgFolder = zip.folder("img");

        if (!imgFolder) {
            throw new Error("无法创建文件夹！");
        }

        for (const [imgSrc, imgPath] of this._ImagePathDict) {
            const imageData = await this._DownloadImage(imgSrc);
            imgFolder.file(imgPath, imageData);
        }

        zip.file(`${filename}.md`, this._MarkdownData.join(""));

        const file = await zip.generateAsync({ type: "blob" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(file);
        link.download = `${filename}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    private _ResolveTags(text: string): string {
        const regexpExt = /(.+?\.)+(\w+)/g;
        const regexpCORS = /(gsp0\.baidu|(tb1|tb2)\.bdstatic)\.com/;

        return text
            .replace(/<img[^>]*?src="(.+?)"[^>]*>/g,
                (match, p1, offset) => {
                    // 获得图像扩展名
                    const matchExt = Array.from((p1 as string).matchAll(regexpExt));
                    if (matchExt.length == 0) {
                        throw new Error("无法获得图像扩展名！");
                    }
                    const ext = matchExt[0][2];

                    // 统一为 HTTPS 协议（否则下载图片可能失败）
                    p1 = p1.replace(/http\b/, "https");

                    // 对于某些图片（通常是贴吧表情），由于下载会触发 CORS
                    // 而且也没有盗链限制，所以直接使用原链接，不另行下载
                    const matchCORS = (p1 as string).match(regexpCORS);
                    if (matchCORS) {
                        return `\n![image](${p1})`;
                    }
                    else {
                        if (!this._ImagePathDict.has(p1)) {
                            this._ImagePathDict.set(p1, `${this._ImagePathDict.size}.${ext}`);
                        }
                        return `\n![image](img/${this._ImagePathDict.get(p1)})\n`;
                    }
                })
            .replace("<br>", "\n")
            .replace(/<[^>]*>/g, "") // 去除所有 html tag。FIX：可能会误伤正常内容..
            .replace("点击展开，查看完整图片", "");
    }

    private async _DownloadImage(url: string): Promise<Blob> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`无法下载图片： ${url}`);
        }
        return await response.blob();
    }
};
