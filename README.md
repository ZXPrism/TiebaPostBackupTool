# Tieba Post Backup Tool （百度贴吧贴子备份工具）

不定期更新。

[【百度贴吧贴子备份工具-演示】](https://www.bilibili.com/video/BV1A8NteREva/?share_source=copy_web&vd_source=34d2dac1f41bd4ca259dd99a9bbdc8b2)

## 构建
1. `npm install`
2. `npm run build`
3. 输出脚本文件位于 `dist` 文件夹下

## 使用方式
1. 手动构建，或从 [Greasy Fork](https://greasyfork.org/scripts/526166-tieba-post-backup-tool) 下载脚本。
2. 使用 [TamperMonkey](https://www.tampermonkey.net/) 安装脚本。
3. 打开想要备份的贴子。
4. 打开脚本管理器的菜单。
5. 点击 `备份当前贴子`，等待备份操作完成。
6. 完成后，脚本会弹出消息框，提示备份成功。

![interface](interface.png)

## TODO
- [ ] 修复换行丢失的问题
- [ ] 改进图片和文字的混排
- [ ] 改进 HTML tag 的处理算法（见 [Markdown.ts](./src/Markdown.ts) 函数 `_ResolveTags`）
- [ ] 改进楼中楼评论的解析算法（目前每层楼最多只能保存十条楼中楼评论）
- [ ] 支持仅备份指定页
- [ ] 改进备份结果的显示
    - 目前的 markdown 有点简陋，并没有很好地体现贴吧的 “风格”
    - 可以考虑设计一套专门的存储格式，将备份数据的存储与显示解耦，以便后续对于显示效果的持续更新
