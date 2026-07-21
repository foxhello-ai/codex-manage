# cloudflared 构建资源

桌面开发时可以通过环境变量 `CODEX_CLOUDFLARED_PATH` 指定本机 cloudflared。

正式打包前，需要将经过 SHA-256 校验的二进制放入本目录：

```text
cloudflared-darwin-arm64
cloudflared-darwin-x64
cloudflared-win32-x64.exe
```

二进制文件不提交 Git，由发布流水线根据固定版本下载并校验。
