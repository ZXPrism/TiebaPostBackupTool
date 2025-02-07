import { Markdown } from "./Markdown"
import { Database } from "./Database";
import { Post, MainReply, SubReply, PostInfo } from "./Post";

export class Parser {
    private _Markdown: Markdown;
    private _Database: Database;
    private readonly _PostURLPrefix = "https://tieba.baidu.com/p";

    constructor() {
        this._Markdown = new Markdown();
        this._Database = new Database();
    }

    /**
     * 重置数据库。
     */
    public Reset() {
        sessionStorage.clear();
    }

    /**
     * 检查当前是否处于多页解析流程中
     * 如果是，则自动开始解析当前页，并返回 `true`，此时不显示解析按钮，防止误触
     * 如果不是，则什么也不做，并返回 `false`
     */
    public ContinueParse() {
        const postInfo = this._ParsepostInfo();

        // 检查当前是否处于多页解析流程中
        const postID = postInfo.postID;
        const status = sessionStorage.getItem(postID);
        if (status) {
            this.Parse();
            return true;
        }

        return false;
    }

    /**
     * 解析贴子。
     * 1. 获取贴子的基本信息
     * 2. 解析所有主楼回复以及楼中楼回复
     * 3. 自动跳转至下一页进行解析
     */
    public async Parse() {
        // 打开数据库
        await this._Database.OpenDatabase();

        // 获取贴子的基本信息
        const postInfo = this._ParsepostInfo();
        const postID = postInfo.postID;
        const postCurrPage = postInfo.postCurrPage;

        let postObj: Post = {
            postInfo: postInfo,
            replies: []
        };

        if (!sessionStorage.getItem(postID)) { // 若还未设置多页解析流程标志
            sessionStorage.setItem(postID, "YES");

            // 创建数据库新条目
            postObj.postInfo = postInfo;
            await this._Database.AddPost(postObj);

            alert(`[TiebaPostBackupTool] 提示：备份过程中请勿操作本页面（如滚动页面、点击链接等）。\n预计花费时间：${postInfo.postReplyNum / 2}秒`);

            if (postCurrPage != 1) { //如果不在第一页，则自动跳转到第一页
                window.location.href = `${this._PostURLPrefix}/${postID}`;
                return;
            }
        }

        // 从数据库中获得 Post 对象
        postObj = await this._Database.GetPost(postID);

        // 模拟滚动屏幕以加载全部内容
        await this._SimulateScroll();

        // 解析所有主楼回复以及楼中楼回复
        const replies = this._ParseReplies();

        // 更新 Post 对象
        postObj.replies.push(...replies);

        // 判断是否为最后一页
        if (postCurrPage != postInfo.postPageNum) { // 自动跳转至下一页进行解析
            await this._Database.AddPost(postObj); // 更新数据库对应条目
            window.location.href = `${this._PostURLPrefix}/${postID}?pn=${postCurrPage + 1}`;
        }
        else {
            // 最后一页已处理完毕，写入 Markdown
            await this._SaveToMarkdown(postObj);

            // 删除数据库对应条目
            this._Database.DeletePost(postID);

            // 清除多页解析流程标志
            sessionStorage.removeItem(postID);

            alert("备份成功！");
        }
    }

    /**
     * 获取贴子的基本信息，包括：
     * 1. 标题 `postTitle`
     * 2. 所属贴吧 `postTieba`
     * 3. ID `postID`
     * 4. 页数 `postPageNum`
     * 5. 当前所在页 `postCurrPage`
     * 6. 回复数 `postReplyNum`
     */
    private _ParsepostInfo() {
        // 获取标题
        const postTitleElement = document.querySelector(".core_title_txt");
        if (!postTitleElement) {
            throw new Error("无法获取贴子标题！");
        }
        const postTitle = postTitleElement.textContent?.trim() ?? "N/A"; // 贴子标题

        // 获取所属贴吧
        const postTiebaElement = document.querySelector("a.card_title_fname");
        if (!postTiebaElement) {
            throw new Error("无法获取所属贴吧！");
        }
        const postTieba = postTiebaElement.textContent?.trim() ?? "N/A"; // 所属贴吧

        // 获取贴子 ID
        const regexpPostID = /\d+/;
        const matchPostID = window.location.href.match(regexpPostID);
        if (!matchPostID) {
            throw new Error("无法获取贴子 ID！");
        }
        const postID = matchPostID[0]; // 贴子 ID

        // 获取页数和回复数
        const postStatusElement = document.querySelector("ul.l_posts_num");
        if (!postStatusElement) {
            throw new Error("无法获取贴子状态！");
        }
        const postStatus = postStatusElement.textContent ?? "N/A";
        const regexpPostStatus = /(\d+)回复贴，共(\d+)页/g;
        const matchPostStatus = Array.from(postStatus.matchAll(regexpPostStatus));
        if (matchPostStatus.length == 0) {
            throw new Error("无法获取页数和回复数！");
        }
        const postReplyNum = parseInt(matchPostStatus[0][1]); // 回复数
        const postPageNum = parseInt(matchPostStatus[0][2]); // 页数

        // 获取当前所在页
        let postCurrPage: number = 1;
        if (postPageNum != 1) {
            const postCurrPageElement = postStatusElement.querySelector("span.tP");
            if (!postCurrPageElement) {
                throw new Error("无法获取当前所在页！");
            }
            postCurrPage = parseInt(postCurrPageElement.textContent ?? "-1"); // 当前所在页
        }

        return {
            postTitle: postTitle,
            postTieba: postTieba,
            postID: postID,
            postPageNum: postPageNum,
            postCurrPage: postCurrPage,
            postReplyNum: postReplyNum
        } as PostInfo;
    }

    /**
     * 解析贴子的所有回复。
     * 1. 通过选择器获取每一层楼（主楼）的回复
     * 2. 对于每个回复，调用 `_ParseMainReply(...)` 分别进行解析
     */
    private _ParseReplies() {
        let replies: MainReply[] = [];

        const mainReplies = document.querySelectorAll("div.l_post");
        mainReplies.forEach((mainReply) => {
            if (mainReply.getAttribute("data-field") != "{}") { // 跳过广告楼层
                replies.push(this._ParseMainReply(mainReply));
            }
        });

        return replies;
    }

    /**
     * 解析主楼回复 `mainReply`。
     * 1. 用户名 `author`
     * 2. 回复时间 `replyTime`
     * 3. 回复内容 `replyContent`
     * 4. 楼层号 `floor`
     * 5. 通过选择器获得所有楼中楼回复（可能不存在）
     * 6. 对于每个楼中楼回复，调用 `_ParseSubReply(...)` 分别进行解析
     */
    private _ParseMainReply(mainReply: Element) {
        let mainReplyObj: MainReply = {
            author: "",
            replyTime: "",
            replyContent: "",
            floor: -1,
            subReplies: []
        };

        // 获取用户名
        const authorElement = mainReply.querySelector("a.p_author_name");
        if (!authorElement) {
            throw new Error("无法获取用户名！");
        }
        mainReplyObj.author = authorElement.textContent ?? "N/A"; // 用户名

        // 获取回复内容
        const replyContentElement = mainReply.querySelector("div.d_post_content");
        if (!replyContentElement) {
            throw new Error("无法获取回复内容！");
        }
        mainReplyObj.replyContent = replyContentElement.innerHTML.trim(); // 回复内容

        // 获取回复时间和楼层号
        const replyStatus = mainReply.querySelector("div.core_reply_tail")?.innerHTML;
        if (!replyStatus) {
            throw new Error("无法获取回复状态！");
        }

        const regexpReplyTime = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
        const matchReplyTime = replyStatus.match(regexpReplyTime);
        if (!matchReplyTime) {
            throw new Error("无法获取回复时间！");
        }
        mainReplyObj.replyTime = matchReplyTime[0]; // 回复时间

        const regexFloor = /(\d+)楼/g;
        const matchFloor = Array.from(replyStatus.matchAll(regexFloor));
        if (matchFloor.length == 0) {
            throw new Error("无法获取楼层号！");
        }
        mainReplyObj.floor = parseInt(matchFloor[0][1]); // 楼层号

        // console.log(`用户名：${mainReplyObj.author}`);
        // console.log(`回复内容：${mainReplyObj.replyContent}`);
        // console.log(`回复时间：${mainReplyObj.replyTime}`);
        // console.log(`楼层号：${mainReplyObj.floor}`);

        // 解析所有楼中楼回复
        const subReplies = mainReply.querySelectorAll(".lzl_cnt").forEach((subReply) => {
            mainReplyObj.subReplies.push(this._ParseSubReply(subReply));
        });

        // console.log("===");

        return mainReplyObj;
    }

    /**
     * 解析楼中楼回复 `subReply`。
     * 1. 用户名 `author`
     * 2. 回复时间 `replyTime`
     * 3. 回复内容 `replyContent`
     */
    private _ParseSubReply(subReply: Element) {
        let subReplyObj: SubReply = {
            author: "",
            replyTime: "",
            replyContent: ""
        };

        // 获取用户名
        const authorElement = subReply.querySelector("a.j_user_card ");
        if (!authorElement) {
            throw new Error("无法获取楼中楼用户名！");
        }
        subReplyObj.author = authorElement.textContent ?? "N/A"; // 用户名

        // 获取回复时间
        const replyTimeElement = subReply.querySelector("span.lzl_time");
        if (!replyTimeElement) {
            throw new Error("无法获取楼中楼回复时间！");
        }
        subReplyObj.replyTime = replyTimeElement.textContent ?? "N/A"; // 回复时间

        // 获取回复内容
        const replyContentElement = subReply.querySelector("span.lzl_content_main");
        if (!replyContentElement) {
            throw new Error("无法获取楼中楼回复内容！");
        }
        const replyTextRaw = replyContentElement.innerHTML.trim(); // 回复内容
        const regexpRemoveUserLink = /<a [^>]*>(.*?)<\/a>/;
        subReplyObj.replyContent = replyTextRaw.replace(regexpRemoveUserLink, "$1");


        console.log("## 楼中楼 ##");
        console.log(`用户名：${subReplyObj.author}`);
        console.log(`回复内容：${subReplyObj.replyContent}`);
        console.log(`回复时间：${subReplyObj.replyTime}`);

        return subReplyObj;
    }

    /**
     * 模拟滚动屏幕以加载全部内容。
     */
    private _SimulateScroll(): Promise<void> {
        return new Promise(resolve => {
            window.scrollTo(0, 0);
            const task = setInterval(() => {
                window.scrollBy(0, 100);
                const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
                if (window.scrollY + window.innerHeight >= maxScroll) {
                    // 等待一段时间，确保最后一层楼加载成功
                    setTimeout(() => {
                        clearInterval(task);
                        resolve();
                    }, 100);
                }
            }, 100);
        });
    }

    private async _SaveToMarkdown(postObj: Post) {
        const md = this._Markdown;

        md.Header(1, postObj.postInfo.postTitle);
        md.URL(`${this._PostURLPrefix}/${postObj.postInfo.postID}`);

        md.TableHeader(["贴吧", "楼层数", "回复数"]);
        md.TableData([
            postObj.postInfo.postTieba,
            postObj.replies.length.toString(),
            postObj.postInfo.postReplyNum.toString()
        ]);

        md.Header(2, "正文");
        postObj.replies.forEach((mainReply) => {
            md.Header(3, `${mainReply.floor} 楼`);
            md.Text(`**${mainReply.author}** 于 ${mainReply.replyTime}`);
            md.Quote(mainReply.replyContent);

            if (mainReply.subReplies.length > 0) {
                md.Header(4, "楼中楼");
            }

            mainReply.subReplies.forEach((subReply) => {
                md.Separator();
                md.Text(`**${subReply.author}** 于 ${subReply.replyTime}`);
                md.Quote(subReply.replyContent);
            });
        });

        await md.Generate(`${postObj.postInfo.postTitle}`);
    }
};
