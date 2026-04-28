# AI 自动阅卷助手

一个基于 Chrome Manifest V3 的侧边栏插件，用于在阅卷页面中自动完成：

1. 定位 `#subjectmark_content_svg` 作答区域
2. 捕获当前标签页并裁剪目标区域
3. 保存截图到用户选择的本地目录
4. 调用 OCR 接口识别文本
5. 调用 DeepSeek 对识别结果评分
6. 回填 `.score-input`
7. 重命名截图为 `第n份-m分.png`
8. 自动点击 `.submit-button` 推进下一份

## 目录结构

```text
manifest.json
background.js
content.js
sidepanel.html
sidepanel.css
sidepanel.js
README.md
```

## 使用方式

1. 打开 Chrome，进入 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”，指向当前目录
4. 点击插件图标打开侧边栏
5. 填写 OCR 与 DeepSeek 配置，输入标准答案 / 评分要点
6. 选择一个本地目录作为临时截图目录
7. 在目标阅卷页面点击“开始阅卷”

## 关键假设

- OCR 接口按你提供的飞桨 `layout-parsing` 示例协议工作：请求头使用 `Authorization: token xxx`，请求体使用 Base64 文件直传，截图按图片类型固定发送 `fileType: 1`。
- DeepSeek 接口按 OpenAI 兼容聊天补全格式工作。
- 评分页面存在以下选择器：
  - 作答区域：`#subjectmark_content_svg`
  - 分数输入框：`.score-input`
  - 提交按钮：`.submit-button`

## 已实现的增强项

- Side Panel 配置面板
- API Key 本地 AES-GCM 加密存储
- 目录句柄持久化（IndexedDB）
- 手动确认模式
- 进度条与执行日志
- 停止阅卷
- 阅卷完成后按需删除本次生成的截图文件

## 注意事项

- 当前 OCR 配置项已适配为 `OCR 接口地址 + OCR Token`，不再使用 `AppID / API Key / Secret Key`。
- 如评分站点在 `chrome://`、扩展页或其他受限页面中，Chrome 内容脚本无法注入。
- 手动确认模式下，插件会在当前份回填分数后停止自动提交，以便人工审核。
