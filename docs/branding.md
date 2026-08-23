# Branding 资源

品牌资源统一存放在 `public/branding/`：

- `base/`：`main` 分支的基础资源
- `fmzh/`：`feature/f-20260717-replace-logo` 的 FMZH 用户资源

默认构建使用 `base`。切换资源时设置 `CODEX_BRAND`：

```bash
CODEX_BRAND=base npm run build
CODEX_BRAND=fmzh npm run build
```

也可以使用 `VITE_BRAND` 作为兼容参数。只支持 `base` 和 `fmzh`，未指定时默认为 `base`。构建后的 HTML、Apple Touch Icon 和 Web Manifest 会自动指向对应目录。
