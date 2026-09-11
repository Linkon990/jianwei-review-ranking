# 运行与部署

公开站点使用 Cloudflare Pages 静态托管。计算在访问者的浏览器中完成，托管端只提供 HTML、CSS、JavaScript 和图标，不运行 Python，也不接收演示中的阅读或结果数据。

在线地址：[jianwei-review-ranking.pages.dev](https://jianwei-review-ranking.pages.dev/)。项目已与 GitHub 的 `main` 分支连接，每次推送会自动重新构建和部署。

## Cloudflare Pages

从 GitHub 导入本仓库，选择 Pages，配置如下：

| 配置 | 值 |
| --- | --- |
| 生产分支 | `main` |
| 框架预设 | None |
| 根目录 | 仓库根目录 |
| 构建命令 | `npm run build` |
| 输出目录 | `site-dist` |
| Node.js | 22（`.node-version`） |

不需要环境变量、API 密钥、数据库或 Pages Functions。接入后，向 `main` 推送会触发生产部署；其他分支可生成预览部署。

`scripts/build_pages.mjs` 只复制明确列出的网页文件，并检查浏览器模式和脚本入口。它不会把仓库根目录、Python 服务或开发资料作为网页发布。构建输出可单独部署，不能用整个仓库目录替代 `site-dist/`。

`web/_headers` 配置同源脚本、禁止浏览器网络连接和禁止嵌入等响应头。网页没有分析统计脚本。托管服务仍会为提供网站服务处理常规访问请求；“不上传”特指演示的阅读记录、评分及模拟选择。

## 本地静态演示

```sh
python -m http.server 8080 --bind 127.0.0.1 --directory web
```

打开 `http://127.0.0.1:8080/`。每个标签页有独立的合成轮次，刷新会回到初始状态。不要直接双击 HTML 文件，使用本地 HTTP 服务加载绝对路径资源。

构建和预览与 Pages 相同的发布文件：

```sh
npm run build
python -m http.server 8080 --bind 127.0.0.1 --directory site-dist
```

## Python 参考服务

```sh
python -m src.demo_server
```

打开 `http://127.0.0.1:8765/`，或在 Windows 上使用 `./run_demo.ps1`。本地服务会把页面切换到服务端计算模式，使用同一界面和 Python 算法；浏览器版本使用独立实现，两者的公式与状态协议保持对齐。

此模式的状态保存在一个进程中，多标签共用当前轮次，重启服务恢复初始数据。事件日志写入忽略的本地数据目录；在带有兄弟工作记录目录的开发工作区中，沿用原有日志位置。不要将此单进程演示接口转发到公网。

## 数据与版本

合成评论的唯一编辑来源为 `src/sample_data.py`。修改后运行：

```sh
python scripts/export_sample_data.py
```

它生成 `web/sample-data.js`，保持两种运行方式使用相同内容。两种实现使用相同种子和首位探索序列；标识符与时间戳根据当前运行生成。

阅读结果只用于当前一轮演示。需要真实平台研究时，应另行实现可信订单退款回流、会话隔离、持久存储与随机试验，不能把公开演示的按钮当作真实交易接口。
